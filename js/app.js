import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js';
import * as db from './db.js';
import {
  DEFAULT_SETTINGS, uid, round2, fmtNum, fmtWeight, parseNum, increase, decrease,
  createSession, startSets, classicScheme, doubleSets, schemeTextOf, moveSchemes, hasEmptyWeight, activePlans, nextPlanAfter,
  plannedPlanId, sessionSummary, exerciseHistory, personalRecord, schemeText, setsText,
  validateImport, buildExport, pickDailyQuote, localDayKey,
  pendingReminder, applyScheme, currentScheme, SCHEMES, schemeLabel, hasReminder, nextPlanAfterDelete, mergeExercisesFile, schemeChange,
  suggestIncrease, backupDue, daysSinceBackup, weeksInARow, computeMilestones, liftedComparison, sessionVolume,
  loadOf, barOf, BARS, fmtLoad, signedNum, loadLabel, setUpLoads, MOODS, sessionDataText, thisWeek, closestMilestone, daysBetween, agoText,
  isDoubleEx, hasRange, rangeText, modeOf, entryMode, startOpts, defaultRange, atTop, doubleReady, lastDone
} from './logic.js';
import { QUOTES } from './quotes.js';
import { exerciseIconSrc } from './exercise-icons.js';

const VERSION = '1.11.0';

// ======================================================================
// Store: one in-memory copy of the data, written through to IndexedDB.
// ======================================================================

let state = {
  loaded: false,
  exercises: [],
  plans: [],
  sessions: [],
  settings: { ...DEFAULT_SETTINGS },
  route: { name: 'home' },
  progressTab: 'overview',
  loadError: null,
  toast: null
};
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    // The data may have loaded before this listener existed: render once more to catch up.
    l();
    return () => listeners.delete(l);
  }, []);
  return state;
}

let toastTimer = null;
// A short message at the bottom; with an action (e.g. Undo) it stays a little longer.
function toast(msg, action = null) {
  clearTimeout(toastTimer);
  setState({ toast: { msg, action } });
  toastTimer = setTimeout(() => setState({ toast: null }), action ? 6000 : 2800);
}

function go(route) {
  setState({ route });
  window.scrollTo(0, 0);
}

const upsert = (list, item) => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
};

function failed(err) {
  console.error(err);
  toast('Could not save: ' + (err && err.message ? err.message : 'storage error'));
}

function saveSession(session) {
  setState({ sessions: upsert(state.sessions, session) });
  return db.put('sessions', session).catch(failed);
}

function deleteSession(id) {
  setState({ sessions: state.sessions.filter((s) => s.id !== id) });
  return db.remove('sessions', id).catch(failed);
}

// Deletes a workout (cancelled or finished). If it was the latest finished one, its plan is up next again.
function removeSession(session) {
  const finishedAt = session.finishedAt || session.firstFinishedAt || null;
  if (finishedAt) {
    const next = nextPlanAfterDelete(state.sessions, { ...session, finishedAt }, state.settings);
    if (next && next !== state.settings.nextPlanId) saveSettings({ nextPlanId: next });
  }
  return deleteSession(session.id);
}

function saveSettings(patch) {
  const settings = { ...state.settings, ...patch };
  setState({ settings });
  return db.saveSettings(settings).catch(failed);
}

function savePlan(plan) {
  setState({ plans: upsert(state.plans, plan) });
  return db.put('plans', plan).catch(failed);
}

function saveExercise(ex) {
  setState({ exercises: upsert(state.exercises, ex) });
  return db.put('exercises', ex).catch(failed);
}

// Picks today's quote on the first launch of the day; keeps it until midnight.
function ensureDailyQuote() {
  const prev = state.settings.dailyQuote;
  const next = pickDailyQuote(prev, localDayKey(), QUOTES.length);
  if (next && next !== prev) saveSettings({ dailyQuote: next });
}

const getSession = (id) => state.sessions.find((s) => s.id === id);
const exMap = () => Object.fromEntries(state.exercises.map((e) => [e.id, e]));
// What volume, total lifted and milestones need for the real load: the exercises and, for workouts
// without their own body weight, the first body weight ever entered.
const volCtx = () => ({ exercises: exMap(), bodyWeight: state.settings.bodyWeightFirst ?? state.settings.bodyWeight ?? null });

// Body weight from Settings: workouts started today keep the day's value; the first value ever
// entered (or corrected the same day) counts for older workouts.
function setBodyWeight(v) {
  const s = state.settings;
  const today = localDayKey();
  const first = s.bodyWeightFirst === null || s.bodyWeightFirstDay === today;
  saveSettings({ bodyWeight: v, ...(first ? { bodyWeightFirst: v, bodyWeightFirstDay: v === null ? null : today } : {}) });
  for (const x of state.sessions) {
    if (localDayKey(new Date(x.startedAt)) === today && x.bodyWeight !== v) saveSession({ ...x, bodyWeight: v });
  }
}

// 1.9.0, once: how each exercise logs its weight (bar, both dumbbells, body weight).
async function setUpLoadsOnce(exercises, settings) {
  if (settings.loadsSetUp) return { exercises, settings };
  const { changed, added } = setUpLoads(exercises);
  const list = exercises.map((e) => changed.find((c) => c.id === e.id) || e).concat(added);
  const next = { ...settings, loadsSetUp: true };
  try {
    if (changed.length || added.length) await db.putMany('exercises', [...changed, ...added]);
    await db.saveSettings(next);
  } catch (err) { console.warn('Could not save the load types', err); }
  return { exercises: list, settings: next };
}

// 1.11.0, once: sets and reps move from the plans to the exercises; plans keep only the order.
async function moveSchemesOnce(exercises, plans, settings) {
  if (settings.schemesMoved) return { exercises, plans, settings };
  const moved = moveSchemes(exercises, plans);
  const next = { ...settings, schemesMoved: true };
  try {
    if (moved.exercises.length) await db.putMany('exercises', moved.exercises);
    if (moved.plans.length) await db.putMany('plans', moved.plans);
    await db.saveSettings(next);
  } catch (err) { console.warn('Could not move sets and reps to the exercises', err); }
  return { ...moved, settings: next };
}

// Every one-time update, in order, for data loaded at start or imported from a file.
async function upgradeData(exercises, plans, settings) {
  const a = await setUpLoadsOnce(exercises, settings);
  return moveSchemesOnce(a.exercises, plans, a.settings);
}

// ======================================================================
// Small helpers and shared pieces
// ======================================================================

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtDate(iso, withDay) {
  if (!iso) return '';
  const d = new Date(iso);
  return (withDay ? DAYS[d.getDay()] + ', ' : '') + d.getDate() + ' ' + MONTHS[d.getMonth()];
}
const planName = (plan) => (plan ? 'Workout ' + plan.name : 'Workout');
const hhmm = (iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
function reminderText(r) {
  const parts = [];
  if (r.dir === 'up') parts.push('↑ weight');
  if (r.dir === 'down') parts.push('↓ weight');
  if (r.scheme) parts.push('switch to ' + schemeLabel(r.scheme));
  if (r.note && r.note.trim()) parts.push('“' + r.note.trim() + '”');
  return parts.join(' · ');
}
// Exercises confirmed in a workout, in the order they were actually done.
function doneInOrder(session) {
  return session.entries.filter((e) => e.status === 'done')
    .sort((a, b) => (Date.parse(a.doneAt || 0) || 0) - (Date.parse(b.doneAt || 0) || 0) || a.order - b.order);
}

function ProgressTabs({ active }) {
  return html`<div class="seg" role="tablist" aria-label="Progress view">
    <button role="tab" aria-selected=${active === 'overview'} class=${active === 'overview' ? 'on' : ''} onClick=${() => setState({ progressTab: 'overview' })}>Overview</button>
    <button role="tab" aria-selected=${active === 'workouts'} class=${active === 'workouts' ? 'on' : ''} onClick=${() => setState({ progressTab: 'workouts' })}>Workouts</button>
    <button role="tab" aria-selected=${active === 'exercises'} class=${active === 'exercises' ? 'on' : ''} onClick=${() => setState({ progressTab: 'exercises' })}>Exercises</button>
  </div>`;
}

const P = {
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  swap: 'M7 7h12l-3-3M17 17H5l3 3',
  skip: 'M5 5v14M9 5l10 7-10 7z',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-.4-.4-2.1z',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  chart: 'M4 19V5M4 19h16M8 15l4-4 3 3 5-6',
  gear: 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  chevron: 'M6 9l6 6 6-6',
  clock: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 8v4l3 2',
  search: 'M11 5a6 6 0 1 0 0 12a6 6 0 1 0 0-12M20 20l-4.5-4.5',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  next: 'M9 6l6 6-6 6',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14'
};

// Exercise icon on the right of a row (nothing if the exercise has none).
// Done: a small check on its corner; skipped: faded.
function ExIcon({ id, done = false, skipped = false, size = 40 }) {
  const src = exerciseIconSrc(id);
  if (!src) return null;
  return html`<span class=${'ex-icon' + (skipped ? ' faded' : '')} style=${'width:' + size + 'px;height:' + size + 'px'}>
    <img src=${src} alt="" width=${size} height=${size} draggable="false" />
    ${done ? html`<span class="ex-icon-check"><${Icon} name="check" size=${11} sw=${3.4} /></span>` : null}
  </span>`;
}

function Icon({ name, size = 20, sw = 2 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${sw} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${name === 'gear' ? html`<circle cx="12" cy="12" r="3" />` : null}
    <path d=${P[name]} />
  </svg>`;
}

function Nav({ active }) {
  const tabs = [['home', 'Today', 'home'], ['plans', 'Plans', 'list'], ['progress', 'Progress', 'chart'], ['settings', 'Settings', 'gear']];
  return html`<nav class="nav" aria-label="Main">
    ${tabs.map(([id, label, icon]) => html`<button key=${id} class=${active === id ? 'active' : ''} aria-current=${active === id ? 'page' : undefined} onClick=${() => go({ name: id })}>
      <${Icon} name=${icon} size=${22} />${label}
    </button>`)}
  </nav>`;
}

function Sheet({ title, sub, children, onClose, footer }) {
  return html`<div class="overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="sheet" role="dialog" aria-label=${title}>
      <div class="sheet-head"><h2>${title}</h2>${sub ? html`<p class="small muted">${sub}</p>` : null}</div>
      ${footer || null}
      <div class="sheet-list">${children}</div>
      <div class="sheet-foot"><button class="btn btn-big" onClick=${onClose}>Cancel</button></div>
    </div>
  </div>`;
}

// One exercise in a choose-an-exercise list: name, detail below it, icon on the right.
function ExPickRow({ ex, sub, onClick }) {
  return html`<button class="sheet-item ex-pick" onClick=${onClick}>
    <span class="ex-pick-text">
      <span class="ex-pick-name">${ex.name}</span>
      ${sub ? html`<span class="small muted num">${sub}</span>` : null}
    </span>
    <${ExIcon} id=${ex.id} />
  </button>`;
}

// Exercise picker with "create new" field; used by Workout (swap/add) and Plans (add/replace).
function ExercisePicker({ title, sub, exclude, onPick, onClose, showLast }) {
  const [name, setName] = useState('');
  const list = state.exercises.filter((e) => !e.archived && !exclude.has(e.id)).sort((a, b) => a.name.localeCompare(b.name));
  const create = () => {
    const n = name.trim();
    if (!n) return;
    const ex = { id: uid(), name: n, equipment: 'machine', setup: '', notes: '', archived: false, load: 'total', sets: 3, reps: 8, dSets: 3 };
    saveExercise(ex);
    onPick(ex.id);
  };
  const footer = html`<div style="padding: 0 16px 10px; display: flex; gap: 8px; align-items: flex-end">
    <label class="field" style="flex: 1">New exercise
      <input class="input" value=${name} placeholder="Name" onInput=${(e) => setName(e.target.value)} />
    </label>
    <button class="btn btn-primary" onClick=${create}>Create</button>
  </div>`;
  return html`<${Sheet} title=${title} sub=${sub} onClose=${onClose} footer=${footer}>
    ${list.length ? list.map((e) => {
      const last = showLast ? lastWeightText(e.id) : '';
      return html`<${ExPickRow} key=${e.id} ex=${e} sub=${last} onClick=${() => onPick(e.id)} />`;
    }) : html`<p class="small muted" style="padding: 10px">No other exercises in the catalog yet. Create one above.</p>`}
  <//>`;
}

function lastWeightText(exId) {
  const h = exerciseHistory(state.sessions, exId);
  if (!h.length) {
    const ex = state.exercises.find((e) => e.id === exId);
    return '';
  }
  const last = h[h.length - 1];
  const ex = state.exercises.find((e) => e.id === exId);
  return last.top === 0 ? 'bodyweight' : 'last ' + fmtLoad(last.top, ex);
}

function useWakeLock(enabled) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return undefined;
    let lock = null;
    let alive = true;
    const request = async () => {
      try {
        if (document.visibilityState === 'visible' && alive) lock = await navigator.wakeLock.request('screen');
      } catch (e) { /* not allowed or not supported */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') request(); };
    request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      if (lock) lock.release().catch(() => {});
    };
  }, [enabled]);
}

// ======================================================================
// Import / export
// ======================================================================

// Adds the exercises of a file to the catalog; plans, workouts and settings are not touched.
async function addExercisesFromFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const { added, skipped } = mergeExercisesFile(data, state.exercises);
    if (added.length) await db.putMany('exercises', added);
    setState({ exercises: [...state.exercises, ...added] });
    toast('Added ' + added.length + (added.length === 1 ? ' exercise' : ' exercises') + (skipped.length ? ', skipped ' + skipped.length + ' already in the catalog' : '') + '.');
  } catch (err) {
    console.error(err);
    toast(err instanceof SyntaxError ? 'This file is not valid JSON.' : err.message);
  }
}

async function importFile(file) {
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    if (raw && raw.kind === 'exercises' && state.plans.length) { await addExercisesFromFile(file); return; }
    const data = validateImport(raw);
    const hasData = state.plans.length || state.sessions.length;
    if (hasData && !window.confirm('Replace all plans and history on this iPhone with this file?')) return;
    await db.replaceAll(data);
    const set = await upgradeData(data.exercises, data.plans, data.settings);
    setState({ exercises: set.exercises, plans: set.plans, sessions: data.sessions, settings: set.settings, route: { name: 'home' } });
    ensureDailyQuote();
    toast('Imported ' + data.exercises.length + ' exercises, ' + data.plans.length + ' plans, ' + data.sessions.length + ' workouts.');
  } catch (err) {
    console.error(err);
    toast(err instanceof SyntaxError ? 'This file is not valid JSON.' : err.message);
  }
}

function ImportButton({ label, cls, onFile }) {
  const ref = useRef(null);
  return html`<span style="display: grid">
    <button class=${cls || 'btn'} onClick=${() => ref.current && ref.current.click()}>${label}</button>
    <input ref=${ref} type="file" accept="application/json,.json" style="display: none"
      onChange=${(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) (onFile || importFile)(f); }} />
  </span>`;
}

async function exportBackup() {
  const now = new Date();
  // Always the same name: saved into the same folder, it replaces the previous backup (the date is inside).
  const name = 'lift-happens-backup.json';
  const text = JSON.stringify(buildExport(state, now), null, 2);
  const file = new File([text], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    saveSettings({ lastBackup: now.toISOString(), backupSnoozeUntil: null });
    toast('Backup ready: ' + name);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error(err);
    toast('Export failed: ' + (err.message || err));
  }
}

// ======================================================================
// Welcome (first run)
// ======================================================================

function Welcome() {
  const startEmpty = async () => {
    const a = { id: uid(), name: 'A', order: 0, archived: false, items: [] };
    const b = { id: uid(), name: 'B', order: 1, archived: false, items: [] };
    await savePlan(a);
    await savePlan(b);
    await saveSettings({ nextPlanId: a.id });
    go({ name: 'plans' });
  };
  return html`<div class="screen">
    <div class="main" style="justify-content: center; padding: calc(var(--safe-top) + var(--top-gap) + 16px) 24px 32px; gap: 18px">
      <${AppFace} size=${140} />
      <h1 class="title">Lift Happens</h1>
      <p class="muted" style="line-height: 1.5">Your plans, pre-filled with last time's weights. Everything stays on this iPhone.</p>
      <${ImportButton} label="Import plans or backup file" cls="btn btn-primary btn-big" />
      <button class="btn btn-big" onClick=${startEmpty}>Start with empty plans A and B</button>
      <p class="tiny muted">Tip: add this page to your Home Screen first (Share → Add to Home Screen), then open it from there.</p>
    </div>
  </div>`;
}

// ======================================================================
// App face (the icon's eyes and barbell smile, without the tile)
// ======================================================================

function AppFace({ size = 88, style = '', wink = false }) {
  const h = Math.round(size * 290 / 400);
  if (!wink) return html`<img class="app-face" src="icons/face.png" alt="" width=${size} height=${h} style=${style} />`;
  // Workout finished: the face appears, then winks.
  return html`<span class="app-face face-wink" style=${'width:' + size + 'px;height:' + h + 'px;' + style}>
    <img src="icons/face.png" alt="" width=${size} height=${h} /><img src="icons/face-wink.png" alt="" width=${size} height=${h} />
  </span>`;
}

function EmptyState({ children }) {
  return html`<section class="card empty-state"><${AppFace} size=${120} />${children}</section>`;
}

// ======================================================================
// Home
// ======================================================================

function Home() {
  const d = useStore();
  const [override, setOverride] = useState(null);
  const plans = activePlans(d.plans);
  const open = d.sessions.find((s) => !s.finishedAt);
  const planned = plannedPlanId(d.plans, d.settings);
  const todayId = override || planned;
  const plan = plans.find((p) => p.id === todayId);
  const finished = d.sessions.filter((s) => s.finishedAt).sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  const last = finished[0];
  const lastPlan = last ? d.plans.find((p) => p.id === last.planId) : null;

  const start = () => {
    if (!plan) return;
    if (!plan.items.length) { toast('This plan has no exercises yet. Add some in Plans.'); return; }
    const s = { ...createSession(plan, d.sessions, new Date(), exMap(), d.settings.progression), bodyWeight: d.settings.bodyWeight ?? null };
    saveSession(s);
    go({ name: 'workout', id: s.id });
  };
  const discard = () => {
    if (window.confirm('Discard the workout in progress? Its log will be deleted.')) removeSession(open);
  };

  const showBackup = backupDue(d.settings, d.sessions);
  const backupDays = showBackup ? daysSinceBackup(d.settings, d.sessions) : null;
  const notNow = () => saveSettings({ backupSnoozeUntil: new Date(Date.now() + 7 * 86400000).toISOString() });

  return html`<div class="screen">
    <div class="header">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
        <div style="display: flex; flex-direction: column; gap: 10px; min-width: 0">
          <span class="small muted">${fmtDate(new Date().toISOString(), true)}</span>
          <h1 class="title">Lift Happens</h1>
        </div>
        <${AppFace} size=${84} />
      </div>
      ${d.settings.showQuote && d.settings.dailyQuote && QUOTES[d.settings.dailyQuote.index]
        ? html`<p class="quote">${QUOTES[d.settings.dailyQuote.index]}</p>` : null}
    </div>
    <div class="main" style="gap: 12px; padding-top: 12px">
      ${showBackup ? html`<section class="card card-pad backup-card" aria-label="Backup reminder">
        <div style="display: flex; gap: 12px; align-items: flex-start">
          <span class="backup-icon"><${Icon} name="download" size=${20} /></span>
          <div style="display: flex; flex-direction: column; gap: 3px">
            <strong style="font-size: 16px">${d.settings.lastBackup ? 'Last backup: ' + backupDays + ' days ago' : 'No backup yet'}</strong>
            <span class="small" style="line-height: 1.4; color: var(--text-2)">Plans and workouts live only on this iPhone. Save a copy, e.g. to iCloud Drive.</span>
          </div>
        </div>
        <div class="grid-2" style="margin-top: 6px">
          <button class="btn btn-primary" onClick=${exportBackup}>Export now</button>
          <button class="btn" onClick=${notNow}>Not now</button>
        </div>
      </section>` : null}
      ${open ? html`<section class="card card-pad card-live" style="gap: 12px">
        <span class="section-label live-label" style="margin: 0"><span class="live-dot" aria-hidden="true"></span>In progress</span>
        <h2 style="font-size: 28px; font-weight: 700">${planName(d.plans.find((p) => p.id === open.planId))}</h2>
        <p class="small muted">Started ${fmtDate(open.startedAt, true)} · ${open.entries.filter((e) => e.status !== 'open').length} of ${open.entries.length} exercises handled</p>
        <button class="btn btn-go btn-big" onClick=${() => go({ name: 'workout', id: open.id })}>Resume workout</button>
        <button class="btn btn-ghost btn-danger-text" onClick=${discard}>Discard this workout</button>
      </section>` : html`<section class="card card-pad" style="padding: 18px 20px; gap: 12px">
        <span class="section-label" style="margin: 0">Today</span>
        <div>
          <h2 style="font-size: 40px; font-weight: 700; line-height: 1">${planName(plan)}</h2>
          <p class="muted" style="margin-top: 6px">${plan ? plan.items.length + ' exercises' : 'No plan'}</p>
        </div>
        <button class="btn btn-primary btn-big" style="min-height: 56px; font-size: 17px" onClick=${start}>Start workout</button>
        ${plans.filter((p) => p.id !== todayId).map((p) => html`<button key=${p.id} class="btn btn-ghost" onClick=${() => setOverride(p.id)}>Do ${planName(p)} instead</button>`)}
        ${last ? html`<button class="last-line" aria-label=${'Last workout: ' + planName(lastPlan) + ', ' + fmtDate(last.startedAt, true) + ', ' + agoText(daysBetween(last.startedAt, new Date())) + '. Open its log'}
          onClick=${() => go({ name: 'session', id: last.id, from: 'home' })}>
          <span class="last-line-text">Last workout: ${planName(lastPlan)} · ${fmtDate(last.startedAt)} · ${agoText(daysBetween(last.startedAt, new Date()))}</span>
          <${Icon} name="next" size=${14} sw=${2.4} />
        </button>` : null}
      </section>`}
      <${ThisWeek} sessions=${d.sessions} plans=${d.plans} />
    </div>
    <${Nav} active="home" />
  </div>`;
}

// This week on Today: Monday to Sunday coloured by workout, weeks in a row, the closest milestone.
function ThisWeek({ sessions, plans }) {
  const now = new Date();
  const wk = thisWeek(sessions, now);
  const streak = weeksInARow(sessions, now);
  const near = closestMilestone(computeMilestones(sessions, now, volCtx()).next);
  const lifted = near && near.kind === 'lifted';
  const shown = near ? (lifted ? tText(near.value) + ' / ' + tText(near.at) : Math.min(near.value, near.at) + ' / ' + near.at) : '';
  const nearName = near ? (near.kind === 'weeks' ? near.at + ' weeks in a row' : near.name) : '';
  const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return html`<section class="card card-pad" style="gap: 10px" aria-label="This week">
    <span class="section-label" style="margin: 0">This week</span>
    <div class="week-strip">
      ${wk.days.map((day, i) => {
        const s = day.session;
        const plan = s ? plans.find((p) => p.id === s.planId) : null;
        return html`<div key=${day.key} class="week-day">
          <span class="cal-head">${DAY_LETTERS[i]}</span>
          ${s ? html`<button class="cal-day cal-done week-dot" style=${'background:' + planColor(plans, s.planId)}
              aria-label=${DAYS[(i + 1) % 7] + ' ' + day.date + ', ' + planName(plan) + '. Open its log'} onClick=${() => go({ name: 'session', id: s.id, from: 'home' })}>${day.date}</button>`
            : html`<span class=${'cal-day week-dot' + (day.key === wk.todayKey ? ' cal-today' : '') + (day.key > wk.todayKey ? ' cal-future' : '')}>${day.date}</span>`}
        </div>`;
      })}
    </div>
    <p class="small" style="line-height: 1.45">${wk.count
      ? html`<strong>${wk.count} ${wk.count === 1 ? 'workout' : 'workouts'}</strong>${' this week' + (wk.count >= 2 ? ' ✓' : '')}`
      : 'No workouts this week yet'}${streak ? html`${' · '}<strong>${streak} ${streak === 1 ? 'week' : 'weeks'}</strong>${' in a row with 2+'}` : null}</p>
    ${near ? html`<div class="week-next">
      <span class="week-next-title">Next: ${nearName} · ${near.title}</span>
      <div class="week-next-bar">
        <div class="ms-bar"><div style=${'width:' + Math.round(near.progress * 100) + '%'}></div></div>
        <span class="small num">${shown}</span>
      </div>
    </div>` : null}
  </section>`;
}

// ======================================================================
// Workout
// ======================================================================

function Workout({ id }) {
  const d = useStore();
  const session = d.sessions.find((s) => s.id === id);
  const [openId, setOpenId] = useState(() => {
    const s = getSession(id);
    const first = s && s.entries.slice().sort((a, b) => a.order - b.order).find((e) => e.status === 'open');
    return first ? first.id : null;
  });
  const [edit, setEdit] = useState(null);
  const editRef = useRef(null);
  const clearEdit = () => { editRef.current = null; setEdit(null); };
  const [sheet, setSheet] = useState(null);
  const [setupOpen, setSetupOpen] = useState({});
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [remPanel, setRemPanel] = useState(null);
  const [sugSheet, setSugSheet] = useState(null);
  const [noteOpen, setNoteOpen] = useState({});
  const [menu, setMenu] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [drag, setDrag] = useState(null);
  const [planAsk, setPlanAsk] = useState(null);
  // The last exercise was confirmed while "Update Workout A?" is asked: finish once it is answered.
  const finishAfterAsk = useRef(false);
  const dragRef = useRef(null);
  const suppressClick = useRef(false);
  const mainRef = useRef(null);
  // A finished workout opened again is being edited: it stays finished (date and rotation unchanged).
  const editing = !!(session && session.finishedAt);
  useWakeLock(d.settings.keepAwake && !editing);

  // With the reminder panel open, keep the exercise's Done button in view.
  useEffect(() => {
    if (!remPanel) return undefined;
    const t = setTimeout(() => {
      const main = mainRef.current;
      const btn = main && main.querySelector('[data-done="' + remPanel + '"]');
      if (!btn) return;
      const r = btn.getBoundingClientRect(), m = main.getBoundingClientRect();
      if (r.bottom > m.bottom - 8) main.scrollBy({ top: r.bottom - m.bottom + 16, behavior: 'smooth' });
    }, 40);
    return () => clearTimeout(t);
  }, [remPanel, noteOpen]);

  useEffect(() => { if (!session) go({ name: 'home' }); }, [session]);
  if (!session) return null;

  const exById = exMap();
  const plan = d.plans.find((p) => p.id === session.planId);
  const settings = d.settings;
  const entries = session.entries.slice().sort((a, b) => a.order - b.order);
  const opts = { excludeSessionId: id };
  const sessionMode = session.mode === 'double' ? 'double' : 'classic';
  // Starting values of one exercise in this workout's mode (Classic and Double kept apart).
  const optsFor = (exId) => startOpts(sessionMode, exById[exId], { ...opts });
  // The exercise's own sets × reps (or sets × range) in this workout's mode, with its starting weights.
  const startFor = (exId) => startSets(exById[exId] || { id: exId }, state.sessions, optsFor(exId));

  // Always patch the latest copy, so quick taps never overwrite each other.
  const patchEntries = (fn) => {
    const cur = getSession(id);
    if (cur) saveSession({ ...cur, entries: fn(cur.entries) });
  };
  const patchEntry = (eid, fn) => patchEntries((list) => list.map((e) => (e.id === eid ? fn(e) : e)));
  const patchSet = (eid, i, patch) => patchEntry(eid, (e) => ({ ...e, sets: e.sets.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const latestEntry = (eid) => (getSession(id).entries.find((e) => e.id === eid));

  const nextOpenAfter = (eid, list) => {
    const ord = list.slice().sort((a, b) => a.order - b.order);
    const i = ord.findIndex((e) => e.id === eid);
    const seq = ord.slice(i + 1).concat(ord.slice(0, Math.max(0, i)));
    const n = seq.find((e) => e.status === 'open' && e.id !== eid);
    return n ? n.id : null;
  };

  const markDone = (eid, fromSwipe) => {
    const e = latestEntry(eid);
    if (!e) return;
    if (hasEmptyWeight(e)) {
      toast('Enter a weight for every set first.');
      setOpenId(eid);
      return;
    }
    const now = new Date().toISOString();
    let after = null;
    patchEntries((list) => {
      const next = list.map((x) => (x.id === eid ? { ...x, status: 'done', doneAt: now } : x));
      after = nextOpenAfter(eid, next);
      return next;
    });
    clearEdit();
    if (!fromSwipe) setOpenId(settings.autoAdvance ? after : null);
    const exDone = exById[e.exerciseId];
    if (atTop(e, exDone)) toast(exDone.name + ': all sets at ' + exDone.repMax + '. Next time: more weight.');
    // Different sets or reps than the exercise's: offer to update it (asked again only if they change again).
    const ch = schemeChange(e, exDone);
    if (ch && e.planAsked !== schemeLabel(ch.to)) {
      setPlanAsk({ entryId: eid, exerciseId: e.exerciseId, name: (exDone || {}).name || 'Exercise', ...ch });
      if (!editing && allHandled()) finishAfterAsk.current = true;
      return;
    }
    autoFinish();
  };

  // Nothing left to do: the workout finishes by itself (not while editing a finished one).
  const allHandled = () => { const cur = getSession(id); return !!cur && cur.entries.every((x) => x.status !== 'open'); };
  const autoFinish = () => { if (!editing && allHandled()) finalize(false, true); };

  const answerPlan = (update) => {
    const a = planAsk;
    setPlanAsk(null);
    if (!a) return;
    const label = schemeLabel(a.to);
    const shown = a.setsOnly ? a.to.sets + ' sets' : label;
    patchEntry(a.entryId, (x) => (update ? { ...x, plannedSets: a.to.sets, appliedScheme: a.setsOnly ? null : label, planAsked: label } : { ...x, planAsked: label }));
    const cur = update ? state.exercises.find((x) => x.id === a.exerciseId) : null;
    if (cur) {
      saveExercise(a.setsOnly ? { ...cur, dSets: a.to.sets } : { ...cur, sets: a.to.sets, reps: a.to.reps });
      toast(a.name + ' is now ' + shown + ', in every workout.');
    }
    if (finishAfterAsk.current) { finishAfterAsk.current = false; autoFinish(); }
  };

  const skip = (e) => {
    clearEdit();
    if (e.kind === 'added') {
      patchEntries((list) => list.filter((x) => x.id !== e.id));
      setOpenId(null);
      autoFinish();
      return;
    }
    if (e.status === 'skipped') { patchEntry(e.id, (x) => ({ ...x, status: 'open' })); return; }
    let after = null;
    patchEntries((list) => {
      const next = list.map((x) => (x.id === e.id ? { ...x, status: 'skipped', doneAt: null } : x));
      after = nextOpenAfter(e.id, next);
      return next;
    });
    setOpenId(settings.autoAdvance ? after : null);
    autoFinish();
  };


  const pickSwap = (entryId, exId) => {
    setSheet(null);
    patchEntry(entryId, (e) => {
      const sets = startFor(exId);
      return {
        ...e, kind: 'swapped', status: 'open', doneAt: null,
        replacesExerciseId: e.kind === 'swapped' ? e.replacesExerciseId : e.exerciseId,
        exerciseId: exId, plannedSets: sets.length, appliedScheme: null, mode: entryMode(sessionMode, exById[exId]), sets
      };
    });
    setOpenId(entryId);
  };

  const undoSwap = (e) => {
    patchEntry(e.id, (x) => {
      const sets = startFor(x.replacesExerciseId);
      return {
        ...x, kind: 'planned', exerciseId: x.replacesExerciseId, replacesExerciseId: null, status: 'open', doneAt: null,
        plannedSets: sets.length, appliedScheme: null, mode: entryMode(sessionMode, exById[x.replacesExerciseId]), sets
      };
    });
  };

  const pickAdd = (exId) => {
    setSheet(null);
    const newId = uid();
    patchEntries((list) => {
      const order = list.reduce((m, x) => Math.max(m, x.order), -1) + 1;
      return [...list, {
        id: newId, order, exerciseId: exId, planItemId: null, kind: 'added', replacesExerciseId: null,
        status: 'open', doneAt: null, plannedSets: null, reminder: null, mode: entryMode(sessionMode, exById[exId]),
        sets: startFor(exId)
      }];
    });
    setOpenId(newId);
  };

  // Weight and reps are real inputs: tapping one opens the iPhone keypad directly.
  const startEdit = (ev, entryId, i, f, draft) => {
    const next = { entryId, i, f, draft };
    editRef.current = next;
    setEdit(next);
    const t = ev.target;
    setTimeout(() => { try { t.select(); } catch (err) { /* ignore */ } }, 0);
  };
  const onEditInput = (ev) => {
    if (!editRef.current) return;
    editRef.current = { ...editRef.current, draft: ev.target.value };
    setEdit(editRef.current);
  };
  const onEditKey = (ev) => { if (ev.key === 'Enter') ev.target.blur(); };

  const commitEdit = () => {
    const ed = editRef.current;
    editRef.current = null;
    if (!ed) return;
    setEdit(null);
    const v = parseNum(ed.draft);
    if (Number.isNaN(v)) return;
    // Below 0 only for body-weight exercises (assisted, with a counterweight).
    const en = latestEntry(ed.entryId);
    const neg = ed.f === 'w' && en && loadOf(state.exercises.find((x) => x.id === en.exerciseId)) === 'bodyweight';
    if (v < 0 && !neg) return;
    patchSet(ed.entryId, ed.i, ed.f === 'w' ? { weight: round2(v) } : { reps: Math.round(v) });
  };

  const finalize = (skipOpen, auto = false) => {
    const cur = getSession(id);
    const entriesNext = cur.entries.map((e) => (skipOpen && e.status === 'open' ? { ...e, status: 'skipped' } : e));
    if (editing) {
      // Editing a finished workout: keep its date and leave the rotation alone.
      saveSession({ ...cur, entries: entriesNext });
      setConfirmFinish(false);
      go({ name: 'summary', id, edited: true });
      return;
    }
    saveSession({ ...cur, entries: entriesNext, finishedAt: new Date().toISOString() });
    const next = nextPlanAfter(state.plans, cur.planId);
    if (next) saveSettings({ nextPlanId: next });
    setConfirmFinish(false);
    go({ name: 'summary', id, auto });
  };
  const finish = () => {
    clearEdit();
    if (getSession(id).entries.some((e) => e.status === 'open')) setConfirmFinish(true);
    else finalize(false);
  };

  const handled = entries.filter((e) => e.status !== 'open').length;
  const pending = entries.filter((e) => e.status === 'open');
  const handledList = entries.filter((e) => e.status !== 'open');
  const openEntries = pending;
  const inSession = new Set(entries.map((e) => e.exerciseId));

  // ---- swipe to confirm on collapsed cards ----
  const swipeHandlers = (e, canSwipe) => ({
    onPointerDown: (ev) => {
      if (!canSwipe) return;
      dragRef.current = { id: e.id, x0: ev.clientX, y0: ev.clientY, moved: false, dx: 0 };
    },
    onPointerMove: (ev) => {
      const g = dragRef.current;
      if (!g || g.id !== e.id) return;
      const dx = ev.clientX - g.x0, dy = ev.clientY - g.y0;
      if (!g.moved) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          g.moved = true;
          try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
        } else {
          if (Math.abs(dy) > 10) dragRef.current = null;
          return;
        }
      }
      g.dx = Math.max(0, Math.min(dx, 180));
      setDrag({ id: e.id, dx: g.dx });
    },
    onPointerUp: () => {
      const g = dragRef.current;
      dragRef.current = null;
      if (!g || g.id !== e.id || !g.moved) return;
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 400);
      setDrag(null);
      if (g.dx > 90) markDone(e.id, true);
    },
    onPointerCancel: () => { dragRef.current = null; setDrag(null); }
  });

  // ---- reminders ----
  const setReminder = (eid, patch) => patchEntry(eid, (x) => {
    const r = { ...(x.reminder || {}), ...patch };
    return { ...x, reminder: hasReminder(r) ? r : null };
  });
  const remText = (r) => {
    const parts = [];
    if (r.dir === 'up') parts.push('↑ weight');
    if (r.dir === 'down') parts.push('↓ weight');
    if (r.scheme) parts.push(schemeLabel(r.scheme));
    if (r.note && r.note.trim()) parts.push('“' + r.note.trim() + '”');
    return parts.join(' · ');
  };
  // A "switch to 4 × 6" reminder: today's sets and, for an exercise of the plan, the exercise itself.
  const applyRem = (e, sc) => {
    patchEntry(e.id, (x) => ({ ...x, sets: applyScheme(x.sets, sc), plannedSets: sc.sets, appliedScheme: schemeLabel(sc) }));
    const cur = e.kind === 'planned' ? state.exercises.find((x) => x.id === e.exerciseId) : null;
    if (cur && modeOf(e) === 'double') {
      // Double progression keeps its own sets; the reps come from the range.
      saveExercise({ ...cur, dSets: sc.sets });
      toast(cur.name + ' is now ' + sc.sets + ' sets, in every workout.');
    } else if (cur) {
      saveExercise({ ...cur, sets: sc.sets, reps: sc.reps });
      toast(cur.name + ' is now ' + schemeLabel(sc) + ', in every workout.');
    }
  };

  const doCancel = () => {
    setConfirmCancel(false);
    const cur = getSession(id);
    go({ name: 'home' });
    if (cur) removeSession(cur);
    toast(editing ? 'Workout deleted.' : 'Workout cancelled. Nothing was saved.');
  };

  const card = (e) => {
    const ex = exById[e.exerciseId] || { name: 'Exercise', equipment: 'machine' };
    const incoming = e.status === 'open' ? pendingReminder(d.sessions, e.exerciseId, id) : null;
    const inRem = incoming ? incoming.reminder : null;
    const outRem = hasReminder(e.reminder) ? e.reminder : null;
    const planned = e.plannedSets ?? null;
    const nowScheme = currentScheme(e.sets);
    const remOpen = remPanel === e.id;
    const myRem = e.reminder || {};
    const inChips = [];
    if (inRem) {
      if (inRem.dir === 'up') inChips.push('↑ weight');
      if (inRem.dir === 'down') inChips.push('↓ weight');
      const already = nowScheme && inRem.scheme && nowScheme.sets === inRem.scheme.sets && nowScheme.reps === inRem.scheme.reps;
      if (inRem.scheme && e.appliedScheme !== schemeLabel(inRem.scheme) && !already) inChips.push(schemeLabel(inRem.scheme));
      if (inRem.note && inRem.note.trim()) inChips.push('Note');
    }
    // Automatic suggestion (green): your own weight or scheme reminder always wins.
    const suggest = !editing && !(inRem && (inRem.dir || inRem.scheme)) && suggestIncrease(d.sessions, e, ex, id);
    // Double progression: reps inside the range first; all sets at the top last time → more weight.
    const dbl = modeOf(e) === 'double' && hasRange(ex);
    const ready = dbl && !editing && !(inRem && inRem.dir) ? doubleReady(d.sessions, e, ex, id) : null;
    const lastD = dbl && openId === e.id ? lastDone(d.sessions, e.exerciseId, { excludeSessionId: id, mode: 'double' }) : null;
    // Reaching the top today: shown unless the card already says it is time for more weight.
    const top = dbl && e.status === 'open' && !ready && atTop(e, ex);
    const open = openId === e.id;
    const isDone = e.status === 'done';
    const isSkipped = e.status === 'skipped';
    const canSwipe = e.status === 'open' && !open;
    const dx = drag && drag.id === e.id ? drag.dx : 0;
    const ws = e.sets.map((x) => x.weight);
    const known = ws.filter((w) => w !== null && w !== undefined);
    const lo = known.length ? Math.min.apply(null, known) : null;
    const hi = known.length ? Math.max.apply(null, known) : null;
    const bwLoad = loadOf(ex) === 'bodyweight';
    const wTxt = known.length < ws.length ? 'weight to enter'
      : bwLoad ? (lo === hi ? fmtLoad(lo, ex) : 'BW ' + signedNum(lo) + ' to ' + signedNum(hi) + ' kg')
      : hi === 0 ? 'bodyweight' : lo === hi ? fmtNum(lo) + ' kg' : fmtNum(lo) + '–' + fmtNum(hi) + ' kg';
    const reps = e.sets.map((x) => x.reps);
    const rTxt = reps.every((r) => r === reps[0]) ? reps[0] : reps.join('/');
    const tags = [];
    if (e.kind === 'added') tags.push('Added · today only');
    if (e.kind === 'swapped') tags.push('Replaces ' + ((exById[e.replacesExerciseId] || {}).name || 'planned exercise') + ' · today only');
    if (planned && e.sets.length !== planned) tags.push(e.sets.length + ' of ' + planned + ' sets · log only');

    return html`<div key=${e.id} class="swipe-wrap">
      ${dx > 0 ? html`<div class="swipe-under" style=${'opacity:' + Math.min(1, dx / 90)}><span><${Icon} name="check" sw=${3} /> Done</span></div>` : null}
      <section class=${'card ex-card' + (open ? ' open' : '') + (open && e.status === 'open' && !editing ? ' live' : '')} style=${'transform: translateX(' + dx + 'px); transition: ' + (dx ? 'none' : 'transform 0.2s ease')}>
        <button class="ex-head" aria-expanded=${open} ...${swipeHandlers(e, canSwipe)}
          onClick=${() => { if (suppressClick.current) return; clearEdit(); setOpenId(open ? null : e.id); }}>
          <div class="ex-head-text">
            <span class="ex-name">${open && e.status === 'open' && !editing ? html`<span class="live-dot" aria-label="In progress"></span>` : null}${ex.name}${ex.setup ? html`<span class="muted"><${Icon} name="wrench" size=${14} /></span>` : null}</span>
            <span class="small muted num">${e.sets.length} × ${dbl ? rangeText(ex) : rTxt} · ${wTxt}</span>
            ${tags.length ? html`<span class="ex-tag">${tags.join(' · ')}</span>` : null}
            ${inChips.length || ((suggest || ready) && !open) ? html`<span class="rem-chips">
              ${suggest && !open ? html`<span class="rem-chip sug"><${Icon} name="up" size=${12} sw=${2.6} />suggested</span>` : null}
              ${ready && !open ? html`<span class="rem-chip sug"><${Icon} name="up" size=${12} sw=${2.6} />more weight</span>` : null}
              ${inChips.map((c) => html`<span key=${c} class="rem-chip"><${Icon} name="bell" size=${12} sw=${2.4} />${c}</span>`)}
            </span>` : null}
            ${outRem ? html`<span class="rem-out">Next time: ${remText(outRem)}</span>` : null}
          </div>
          ${exerciseIconSrc(e.exerciseId) ? html`<span class="ex-head-side">
              ${isSkipped ? html`<span class="skip-badge">Skipped</span>` : null}
              <${ExIcon} id=${e.exerciseId} done=${isDone} skipped=${isSkipped} />
            </span>` : html`
          ${isDone ? html`<span class="check-badge"><${Icon} name="check" size=${16} sw=${3} /></span>` : null}
          ${isSkipped ? html`<span class="skip-badge">Skipped</span>` : null}`}
        </button>
        ${open ? html`<div class="ex-body">
          ${isSkipped ? html`<div class="skip-box">
            <p style="flex: 1">Logged as skipped. It stays in the plan with the same weights next time.</p>
            <button class="btn" onClick=${() => skip(e)}>Undo</button>
          </div>` : html`
          ${suggest ? html`<div class="sug-row"><button class="rem-chip sug sug-btn" aria-label=${'Suggested: more weight for ' + ex.name + '. Options'} onClick=${() => setSugSheet(e.exerciseId)}>
            <${Icon} name="up" size=${12} sw=${2.6} />suggested</button></div>` : null}
          ${ready ? html`<div class="dp-box" role="note"><${Icon} name="up" size=${18} sw=${2.4} />
            <span><strong>Time for more weight.</strong> Last time every set reached ${ready.max}, the top of ${rangeText(ex)}.</span></div>` : null}
          ${inRem ? html`<div class="rem-box">
            <span class="rem-label">Reminder from ${fmtDate(incoming.session.startedAt)}</span>
            ${inRem.dir === 'up' ? html`<strong>↑ Increase the weight</strong>` : null}
            ${inRem.dir === 'down' ? html`<strong>↓ Decrease the weight</strong>` : null}
            ${inRem.scheme ? html`<div class="rem-row">
              <strong>Switch to ${schemeLabel(inRem.scheme)}</strong>
              ${e.appliedScheme === schemeLabel(inRem.scheme)
                ? html`<span class="small" style="color: #8AB8FF">${e.kind === 'planned' ? 'Updated ✓' : 'Applied today ✓'}</span>`
                : nowScheme && nowScheme.sets === inRem.scheme.sets && nowScheme.reps === inRem.scheme.reps
                  ? html`<span class="small muted">Already ${schemeLabel(inRem.scheme)}</span>`
                  : html`<button class="btn btn-primary" onClick=${() => applyRem(e, inRem.scheme)}>${e.kind === 'planned' ? 'Apply' : 'Apply today'}</button>`}
            </div>` : null}
            ${inRem.scheme && e.appliedScheme !== schemeLabel(inRem.scheme) && e.kind === 'planned' ? html`<span class="tiny muted">Apply changes today’s sets and ${ex.name} from now on.</span>` : null}
            ${inRem.note && inRem.note.trim() ? html`<em style="color: var(--text-2)">“${inRem.note.trim()}”</em>` : null}
            <span class="tiny muted">Cleared when you tap Done.</span>
          </div>` : null}
          ${lastD ? html`<span class="dp-last small num">Last time: ${lastD.entry.sets.every((x) => x.weight === lastD.entry.sets[0].weight)
            ? fmtLoad(lastD.entry.sets[0].weight, ex) + ' × ' + lastD.entry.sets.map((x) => x.reps).join(' · ')
            : setsText(lastD.entry.sets, ex)}</span>` : null}
          <div class="set-grid"><span></span><span class="col-label">${bwLoad ? 'KG ON BODY WEIGHT' : 'KG'}</span><span class="col-label">${dbl ? 'REPS ' + rangeText(ex) : 'REPS'}</span><span></span></div>
          ${e.sets.map((s, i) => {
            const editW = edit && edit.entryId === e.id && edit.i === i && edit.f === 'w';
            const editR = edit && edit.entryId === e.id && edit.i === i && edit.f === 'r';
            const empty = s.weight === null || s.weight === undefined;
            return html`<div key=${i} class="set-grid">
              <span class="set-num">${i + 1}</span>
              <div class=${'stepper' + (empty ? ' empty' : '')}>
                <button class="icon-btn" aria-label=${'Decrease weight, set ' + (i + 1)} onClick=${() => patchSet(e.id, i, { weight: decrease(ex.equipment, latestEntry(e.id).sets[i].weight, settings, bwLoad) })}><${Icon} name="minus" size=${18} sw=${2.2} /></button>
                <input class="step-field" inputmode="decimal" enterkeyhint="done" autocomplete="off" aria-label=${'Weight in kg, set ' + (i + 1)} placeholder="enter"
                  value=${editW ? edit.draft : (empty ? '' : signedNum(s.weight))}
                  onFocus=${(ev) => startEdit(ev, e.id, i, 'w', empty ? '' : signedNum(s.weight))}
                  onInput=${onEditInput} onBlur=${commitEdit} onKeyDown=${onEditKey} />
                <button class="icon-btn" aria-label=${'Increase weight, set ' + (i + 1)} onClick=${() => patchSet(e.id, i, { weight: increase(ex.equipment, latestEntry(e.id).sets[i].weight, settings) })}><${Icon} name="plus" size=${18} sw=${2.2} /></button>
              </div>
              <div class=${'stepper' + (dbl && s.reps >= ex.repMax ? ' rep-max' : dbl && s.reps < ex.repMin ? ' rep-low' : '')}>
                <button class="icon-btn" aria-label=${'Fewer reps, set ' + (i + 1)} onClick=${() => patchSet(e.id, i, { reps: Math.max(0, latestEntry(e.id).sets[i].reps - 1) })}><${Icon} name="minus" size=${18} sw=${2.2} /></button>
                <input class="step-field" inputmode="numeric" enterkeyhint="done" autocomplete="off" aria-label=${'Reps, set ' + (i + 1)}
                  value=${editR ? edit.draft : String(s.reps)}
                  onFocus=${(ev) => startEdit(ev, e.id, i, 'r', String(s.reps))}
                  onInput=${onEditInput} onBlur=${commitEdit} onKeyDown=${onEditKey} />
                <button class="icon-btn" aria-label=${'More reps, set ' + (i + 1)} onClick=${() => patchSet(e.id, i, { reps: latestEntry(e.id).sets[i].reps + 1 })}><${Icon} name="plus" size=${18} sw=${2.2} /></button>
              </div>
              ${e.sets.length > 1 ? html`<button class="icon-btn remove-set" aria-label=${'Remove set ' + (i + 1) + ' from today’s log'} onClick=${() => patchEntry(e.id, (x) => ({ ...x, sets: x.sets.filter((_, j) => j !== i) }))}><${Icon} name="x" size=${18} /></button>` : html`<span></span>`}
            </div>`;
          })}
          ${top ? html`<div class="dp-box" role="status"><${Icon} name="up" size=${18} sw=${2.4} />
            <span>All sets at ${ex.repMax}, the top of ${rangeText(ex)}. <strong>Next time: more weight.</strong></span></div>` : null}
          ${setupOpen[e.id] && ex.setup ? html`<div class="note-box"><${Icon} name="wrench" size=${18} /><span>Machine setup: <strong>${ex.setup}</strong></span></div>` : null}
          <div class="act-row" style="margin-top: 6px">
            <button class="btn" onClick=${() => patchEntry(e.id, (x) => ({ ...x, sets: [...x.sets, { ...x.sets[x.sets.length - 1] }] }))}><${Icon} name="plus" size=${16} sw=${2.2} /> Set</button>
            ${e.kind === 'added' ? null : e.kind === 'swapped'
              ? html`<button class="btn" aria-label="Undo swap" onClick=${() => undoSwap(e)}><${Icon} name="swap" size=${16} /> Undo</button>`
              : html`<button class="btn" onClick=${() => setSheet({ mode: 'swap', entryId: e.id, from: ex.name })}><${Icon} name="swap" size=${16} /> Swap</button>`}
            <button class="btn" onClick=${() => skip(e)}><${Icon} name=${e.kind === 'added' ? 'x' : 'skip'} size=${16} /> ${e.kind === 'added' ? 'Remove' : 'Skip'}</button>
            ${ex.setup ? html`<button class="btn act-icon" aria-label="Machine setup" title="Machine setup" aria-pressed=${!!setupOpen[e.id]} onClick=${() => setSetupOpen({ ...setupOpen, [e.id]: !setupOpen[e.id] })}><${Icon} name="wrench" size=${18} /></button>` : null}
            <button class=${'btn act-icon' + (outRem ? ' btn-marked' : '')} aria-label="Reminder for next time" title="Reminder" aria-expanded=${remOpen} onClick=${() => setRemPanel(remOpen ? null : e.id)}><${Icon} name="bell" size=${18} /></button>
          </div>
          ${remOpen ? html`<div class="rem-panel">
            <span class="rem-label" style="color: var(--muted)">For next time</span>
            <div class="grid-2">
              <button class=${'chip-btn' + (myRem.dir === 'up' ? ' on' : '')} aria-pressed=${myRem.dir === 'up'} onClick=${() => { setReminder(e.id, { dir: myRem.dir === 'up' ? null : 'up' }); setRemPanel(null); }}>↑ Weight</button>
              <button class=${'chip-btn' + (myRem.dir === 'down' ? ' on' : '')} aria-pressed=${myRem.dir === 'down'} onClick=${() => { setReminder(e.id, { dir: myRem.dir === 'down' ? null : 'down' }); setRemPanel(null); }}>↓ Weight</button>
            </div>
            ${dbl ? null : html`<span class="tiny muted">Change scheme</span>`}
            ${dbl ? null : html`<div class="grid-4">
              ${SCHEMES.map((sc) => {
                const label = schemeLabel(sc);
                const isCurrent = nowScheme && nowScheme.sets === sc.sets && nowScheme.reps === sc.reps;
                const on = myRem.scheme && myRem.scheme.sets === sc.sets && myRem.scheme.reps === sc.reps;
                return html`<button key=${label} class=${'chip-btn' + (on ? ' on' : '') + (isCurrent ? ' current' : '')} disabled=${!!isCurrent} aria-pressed=${!!on}
                  aria-label=${isCurrent ? label + ', current scheme' : label} onClick=${() => setReminder(e.id, { scheme: on ? null : sc })}>${label}</button>`;
              })}
            </div>`}
            ${noteOpen[e.id] || (myRem.note && myRem.note.length)
              ? html`<label class="field">Note
                  <input class="input" placeholder="e.g. seat one notch higher" value=${myRem.note || ''} onInput=${(ev) => setReminder(e.id, { note: ev.target.value })} />
                </label>`
              : html`<button class="btn btn-ghost link" style="align-self: flex-start; padding: 0 6px" onClick=${() => setNoteOpen({ ...noteOpen, [e.id]: true })}>+ Note</button>`}
            <span class="tiny muted">Shown next time you do ${ex.name}, in any workout.</span>
          </div>` : null}
          ${isDone
            ? html`<button class="btn" data-done=${e.id} style="margin-top: 6px" onClick=${() => patchEntry(e.id, (x) => ({ ...x, status: 'open', doneAt: null }))}>Mark as not done</button>`
            : html`<button class="btn btn-primary btn-big" data-done=${e.id} style="margin-top: 6px; border-radius: 12px" onClick=${() => markDone(e.id, false)}><${Icon} name="check" sw=${3} /> Done · next exercise</button>`}
          `}
        </div>` : null}
      </section>
    </div>`;
  };

  return html`<div class="screen">
    <div class="header">
      <div class="header-row">
        ${editing
          ? html`<span class="section-label" style="margin: 0">Editing</span>`
          : html`<button class="icon-btn back" aria-label="Back to Today" onClick=${() => go({ name: 'home' })}><${Icon} name="back" size=${22} /></button>`}
        <div style="display: flex; align-items: center; gap: 2px">
          <span class=${'mode-tag' + (sessionMode === 'double' ? ' double' : '')}>${sessionMode === 'double' ? 'Double progression' : 'Classic'}</span>
          <span class="small muted" style="margin-left: 6px">${fmtDate(session.startedAt, true)}${editing ? ' · ' + hhmm(session.startedAt) : ''}</span>
          <button class="icon-btn" style="margin-right: -10px" aria-label="Workout options" onClick=${() => setMenu(true)}><${Icon} name="more" size=${24} sw=${3.5} /></button>
        </div>
      </div>
      <h1 class="title">${planName(plan)}</h1>
      <div style="display: flex; align-items: center; gap: 10px">
        <div class="bar"><div style=${'width:' + Math.round((handled / Math.max(1, entries.length)) * 100) + '%'}></div></div>
        <span class="small muted num">${handled} / ${entries.length} exercises</span>
      </div>
      ${settings.showQuote && settings.dailyQuote && QUOTES[settings.dailyQuote.index]
        ? html`<p class="quote quote-go">${QUOTES[settings.dailyQuote.index]}</p>` : null}
    </div>
    <div class="main" ref=${mainRef}>
      ${pending.map(card)}
      ${handledList.length ? html`<h2 class="section-label">Done & skipped · ${handledList.length}</h2>` : null}
      ${handledList.map(card)}
      <button class="btn-dashed" style="margin-top: 4px" onClick=${() => setSheet({ mode: 'add' })}><${Icon} name="plus" size=${18} sw=${2.2} /> Add exercise (today only)</button>
    </div>
    <div class="footer"><button class="btn btn-big btn-outline" onClick=${finish}>${editing ? 'Save' : 'Finish workout'}</button></div>

    ${sheet && sheet.mode === 'swap' ? html`<${ExercisePicker} title=${'Swap ' + sheet.from + ' for…'} showLast=${true}
      sub=${'Logged today only. Next time the plan shows ' + sheet.from + ' again, with its usual weights.'}
      exclude=${inSession} onClose=${() => setSheet(null)} onPick=${(exId) => pickSwap(sheet.entryId, exId)} />` : null}
    ${sheet && sheet.mode === 'add' ? html`<${ExercisePicker} title="Add an exercise" showLast=${true}
      sub="Logged today only. It is not added to the plan." exclude=${inSession}
      onClose=${() => setSheet(null)} onPick=${pickAdd} />` : null}

    ${menu ? html`<div class="overlay" onClick=${(ev) => { if (ev.target === ev.currentTarget) setMenu(false); }}>
      <div class="sheet" role="dialog" aria-label="Workout options">
        <div class="sheet-head"><h2>${planName(plan)}</h2><p class="small muted">Started ${fmtDate(session.startedAt, true)}</p></div>
        <div style="padding: 0 16px; display: flex; flex-direction: column; gap: 8px">
          <button class="btn btn-big btn-warn" onClick=${() => { setMenu(false); setConfirmCancel(true); }}><${Icon} name="trash" size=${18} /> ${editing ? 'Delete workout' : 'Cancel workout'}</button>
        </div>
        <div class="sheet-foot"><button class="btn btn-big" onClick=${() => setMenu(false)}>Close</button></div>
      </div>
    </div>` : null}

    ${confirmCancel ? html`<div class="overlay center">
      <div class="dialog" role="alertdialog" aria-labelledby="cancel-title">
        <h2 id="cancel-title">${editing ? 'Delete this workout?' : 'Cancel this workout?'}</h2>
        <p style="line-height: 1.45">${editing
          ? 'It disappears from the log, with its sets and reminders. Starting weights and records are recalculated without it.'
          : 'Nothing from today is saved: no sets, no reminders. ' + planName(plan) + ' stays up next, with the usual weights.'}</p>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px">
          <button class="btn btn-primary btn-big" autofocus onClick=${() => setConfirmCancel(false)}>${editing ? 'Keep it' : 'Keep training'}</button>
          <button class="btn btn-big btn-warn" onClick=${doCancel}>${editing ? 'Delete workout' : 'Cancel workout'}</button>
        </div>
      </div>
    </div>` : null}

    ${confirmFinish ? html`<div class="overlay center">
      <div class="dialog" role="alertdialog" aria-labelledby="finish-title">
        <h2 id="finish-title">${editing ? 'Some exercises are not done' : 'Workout not complete'}</h2>
        <p style="line-height: 1.45">${openEntries.length} ${openEntries.length === 1 ? 'exercise' : 'exercises'} not done: ${openEntries.map((e) => (exById[e.exerciseId] || {}).name).join(', ')}</p>
        <p class="small muted" style="line-height: 1.45">${editing ? 'If you save now, they are logged as skipped.' : 'If you finish now, they are logged as skipped and come back next time with the same weights.'}</p>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px">
          <button class="btn btn-primary btn-big" autofocus onClick=${() => { setConfirmFinish(false); if (openEntries[0]) setOpenId(openEntries[0].id); }}>Back to workout</button>
          <button class="btn btn-big btn-warn" onClick=${() => finalize(true)}>${editing ? 'Save anyway' : 'Finish anyway'}</button>
        </div>
      </div>
    </div>` : null}

    ${sugSheet ? (() => {
      const ex = exById[sugSheet] || { id: sugSheet, name: 'this exercise' };
      const off = () => {
        setSugSheet(null);
        const cur = state.exercises.find((x) => x.id === ex.id);
        if (!cur) return;
        saveExercise({ ...cur, noSuggest: true });
        toast('No more suggestions for ' + cur.name + '.', { label: 'Undo', run: () => saveExercise({ ...cur, noSuggest: false }) });
      };
      return html`<${Sheet} title=${'Suggested: more weight'} sub=${ex.name} onClose=${() => setSugSheet(null)}>
        <button class="sheet-item btn-danger-text" style="justify-content: center" onClick=${off}>Don’t suggest for ${ex.name}</button>
        <p class="small muted" style="padding: 10px 10px 0; line-height: 1.45">You can turn it back on in Plans or in Settings → Exercises.</p>
      </${Sheet}>`;
    })() : null}

    ${planAsk ? html`<div class="overlay center">
      <div class="dialog" role="alertdialog" aria-labelledby="plan-ask-title">
        <h2 id="plan-ask-title">Update ${planAsk.name}?</h2>
        ${planAsk.setsOnly ? html`
        <p style="line-height: 1.45"><strong>${planAsk.name}</strong>: ${planAsk.from.sets} sets → this workout ${planAsk.to.sets} sets.</p>
        <p class="small muted" style="line-height: 1.45">Update: ${planAsk.name} has ${planAsk.to.sets} sets from the next time, in every workout. Only this workout: it stays at ${planAsk.from.sets}.</p>` : html`
        <p style="line-height: 1.45"><strong>${planAsk.name}</strong>: ${schemeLabel(planAsk.from)} → this workout ${schemeLabel(planAsk.to)}.</p>
        <p class="small muted" style="line-height: 1.45">Update: ${planAsk.name} is ${schemeLabel(planAsk.to)} from the next time, in every workout. Only this workout: it stays ${schemeLabel(planAsk.from)}.</p>`}
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px">
          <button class="btn btn-primary btn-big" autofocus onClick=${() => answerPlan(true)}>Update ${planAsk.name}</button>
          <button class="btn btn-big" onClick=${() => answerPlan(false)}>Only this workout</button>
        </div>
      </div>
    </div>` : null}
  </div>`;
}

// ======================================================================
// Finish summary
// ======================================================================

// Comparison cards: shown at the end of a workout (live) and at the bottom of every workout log.
function SummaryCards({ sum, plan, live }) {
  // A Double progression workout: progress is more weight or more reps (different units: no bars).
  const dbl = sum.mode === 'double';
  const maxAbs = Math.max(0, ...sum.rows.filter((r) => r.delta !== null && !r.bodyweight).map((r) => Math.abs(r.delta)));
  const volPct = sum.volPct === null ? '—' : (sum.volPct > 0 ? '+' : sum.volPct < 0 ? '−' : '±') + Math.abs(sum.volPct).toFixed(1) + '%';
  const kg = (v) => Math.round(v).toLocaleString('en') + ' kg';
  const here = live ? 'today' : 'this workout';
  const volTitle = 'Total volume vs last ' + planName(plan);
  let volText;
  if (sum.volBase === 'previous' && sum.volLast > 0) {
    volText = 'Last ' + planName(plan) + ' (' + fmtDate(sum.volPrev.startedAt, true) + '): ' + kg(sum.volLast) + ' · ' + here + ': ' + kg(sum.volToday) + ' (real load × reps, exercises done both times)';
  } else if (sum.volBase === 'previous') {
    volText = 'No exercises in common with the last ' + planName(plan) + ' (' + fmtDate(sum.volPrev.startedAt, true) + ').';
  } else {
    volText = 'Nothing to compare yet: this is the first ' + planName(plan) + '.';
  }
  return html`
      <section class="card card-pad">
        <span class="section-label" style="margin: 0">${volTitle}</span>
        <span class="hero-num num">${volPct}</span>
        <span class="small muted num">${volText}</span>
      </section>

      <section class="card card-pad" style="gap: 12px">
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap">
          <h2 style="font-size: 15px; font-weight: 600">${dbl ? 'Progress vs last time' : 'Top-set weight vs last time'}</h2>
          <div class="legend"><span><i style="background: var(--up)"></i>Heavier</span>${dbl ? html`<span><i style="background: var(--go)"></i>More reps</span>` : null}<span><i style="background: var(--down)"></i>Lighter</span></div>
        </div>
        <span class="small muted">${dbl
          ? [sum.heavier + ' heavier', sum.moreReps + ' more reps', sum.lighter + ' lighter'].concat(sum.fewerReps ? [sum.fewerReps + ' fewer reps'] : []).concat([sum.same + ' same']).join(' · ')
          : sum.heavier + ' heavier · ' + sum.lighter + ' lighter · ' + sum.same + ' same'}${sum.records ? ' · ' + sum.records + (sum.records === 1 ? ' new record' : ' new records') : ''}</span>
        <div>
          ${sum.rows.length ? sum.rows.map((r) => {
            let detail, delta, bw = 0, dir = null;
            const lx = { load: r.load };
            const wt = (v) => (r.load === 'bodyweight' ? fmtLoad(v, lx) : fmtNum(v) + ' kg');
            const wFrom = (v) => (r.load === 'bodyweight' ? fmtLoad(v, lx).replace(/ kg$/, '') : fmtNum(v));
            if (r.delta === null) { detail = r.bodyweight ? r.totalReps + ' reps' : wt(r.top) + ' · first time'; delta = 'new'; }
            else if (r.bodyweight) { detail = 'reps ' + r.prevReps + ' → ' + r.totalReps; delta = r.delta > 0 ? '+' + r.delta + ' reps' : r.delta < 0 ? '−' + (-r.delta) + ' reps' : 'same'; }
            else if (r.repsDelta !== null && r.repsDelta !== undefined) {
              detail = wt(r.top) + ' · reps ' + r.prevReps + ' → ' + r.totalReps;
              const n = Math.abs(r.repsDelta);
              delta = r.repsDelta > 0 ? '+' + n + (n === 1 ? ' rep' : ' reps') : r.repsDelta < 0 ? '−' + n + (n === 1 ? ' rep' : ' reps') : 'same';
              dir = r.repsDelta > 0 ? 'reps' : r.repsDelta < 0 ? 'down' : null;
            }
            else {
              detail = (r.delta !== 0 ? wFrom(r.prevTop) + ' → ' + wt(r.top) : wt(r.top));
              delta = r.delta > 0 ? '+' + fmtNum(r.delta) + ' kg' : r.delta < 0 ? '−' + fmtNum(-r.delta) + ' kg' : 'same';
              if (r.delta !== 0 && maxAbs > 0) { bw = Math.max(4, Math.round((Math.abs(r.delta) / maxAbs) * 50)); dir = r.delta > 0 ? 'up' : 'down'; }
            }
            const rec = r.record ? (r.record.kind === 'weight'
              ? 'New record! ' + wt(r.record.value) + ' × ' + r.record.reps + ', set ' + (r.record.setIndex + 1) + ' of ' + r.record.setCount + ' (best was ' + wt(r.record.previous) + ')'
              : 'New record! ' + r.record.value + ' reps (best was ' + r.record.previous + ')') : null;
            const tone = dir === 'up' ? 'var(--up)' : dir === 'down' ? 'var(--down)' : dir === 'reps' ? 'var(--go)' : 'var(--text)';
            return html`<div key=${r.entryId} class=${'sum-row' + (dbl ? ' no-bar' : '')}>
              <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0">
                <span style="font-size: 14px; font-weight: 500">${r.name}</span>
                <span class="tiny muted num">${detail}</span>
                ${rec ? html`<span class="record"><${Icon} name="trophy" size=${12} sw=${2.4} />${rec}</span>` : null}
                ${dbl && r.atTop ? html`<span class="rem-chip sug" style="align-self: flex-start"><${Icon} name="up" size=${12} sw=${2.6} />Next time: more weight</span>` : null}
              </div>
              ${dbl ? null : html`<div class="dbar" aria-hidden="true"><div class="zero"></div>${dir ? html`<div class=${dir} style=${'width:' + bw + '%'}></div>` : null}</div>`}
              <span class="small num" style=${'text-align: right; font-weight: 600' + (dbl ? '; white-space: nowrap; color: ' + tone : '')}>${delta}</span>
            </div>`;
          }) : html`<p class="small muted">No exercises were confirmed.</p>`}
        </div>
      </section>`;
}

// Your session: duration, average heart rate, mood. Optional; saved as you type, also later from the log.
function SessionCard({ session, note }) {
  const [dur, setDur] = useState(session.duration ? String(session.duration) : '');
  const [hr, setHr] = useState(session.heartRate ? String(session.heartRate) : '');
  const save = (patch) => { const cur = getSession(session.id); if (cur) saveSession({ ...cur, ...patch }); };
  const num = (t) => { const v = parseInt(t, 10); return Number.isFinite(v) && v > 0 ? v : null; };
  const onNum = (setter, key) => (ev) => {
    const t = ev.target.value.replace(/[^0-9]/g, '').slice(0, 3);
    if (t !== ev.target.value) ev.target.value = t;
    setter(t);
    save({ [key]: num(t) });
  };
  const blurOnEnter = (ev) => { if (ev.key === 'Enter') ev.target.blur(); };
  return html`<section class="card card-pad sess-card" aria-label="Your session">
    <span class="section-label" style="margin: 0">Your session</span>
    <span class="tiny muted" style="line-height: 1.4">${note}</span>
    <label class="sess-row"><span class="sess-icon"><${Icon} name="clock" /></span><span class="sess-label">Duration</span>
      <input class="input sess-input" inputmode="numeric" enterkeyhint="done" autocomplete="off" aria-label="Duration in minutes" value=${dur} onInput=${onNum(setDur, 'duration')} onKeyDown=${blurOnEnter} />
      <span class="sess-unit">min</span></label>
    <label class="sess-row"><span class="sess-icon"><${Icon} name="heart" /></span><span class="sess-label">Avg heart rate</span>
      <input class="input sess-input" inputmode="numeric" enterkeyhint="done" autocomplete="off" aria-label="Average heart rate in beats per minute" value=${hr} onInput=${onNum(setHr, 'heartRate')} onKeyDown=${blurOnEnter} />
      <span class="sess-unit">bpm</span></label>
    <div class="sess-row sess-mood"><span class="sess-label">Mood</span>
      <div class="moods" role="group" aria-label="Mood">
        ${MOODS.map((m, i) => html`<button key=${i} class=${'mood' + (session.mood === i + 1 ? ' on' : '')} aria-pressed=${session.mood === i + 1} aria-label=${'Mood ' + (i + 1) + ' of ' + MOODS.length}
          onClick=${() => save({ mood: session.mood === i + 1 ? null : i + 1 })}>${m}</button>`)}
      </div>
    </div>
  </section>`;
}

// An exercise added to a finished workout from its summary: the workout is open again (in progress).
function addToFinished(id, exId) {
  const cur = getSession(id);
  if (!cur) return;
  const exById = exMap();
  const order = cur.entries.reduce((m, x) => Math.max(m, x.order), -1) + 1;
  const entry = {
    id: uid(), order, exerciseId: exId, planItemId: null, kind: 'added', replacesExerciseId: null,
    status: 'open', doneAt: null, plannedSets: null, reminder: null, mode: entryMode(cur.mode, exById[exId]),
    sets: startSets(exById[exId] || { id: exId }, state.sessions, startOpts(cur.mode, exById[exId], { excludeSessionId: id }))
  };
  saveSession({ ...cur, finishedAt: null, entries: [...cur.entries, entry] });
  go({ name: 'workout', id });
}

function Summary({ id, edited, auto }) {
  const d = useStore();
  const session = d.sessions.find((s) => s.id === id);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (!session) go({ name: 'home' }); }, [session]);
  if (!session) return null;
  const plan = d.plans.find((p) => p.id === session.planId);
  const next = d.plans.find((p) => p.id === d.settings.nextPlanId);
  const sum = sessionSummary(session, d.sessions, exMap(), plan, volCtx());
  const reopen = () => go({ name: 'workout', id });
  const reached = edited ? [] : computeMilestones(d.sessions, new Date(), volCtx()).unlocked.filter((u) => u.sessionId === id);

  return html`<div class="screen">
    <div class="main" style="padding: calc(var(--safe-top) + var(--top-gap)) 20px calc(var(--safe-bottom) + 24px); gap: 18px">
      <${AppFace} size=${140} wink=${true} style="align-self: center" />
      <div style="display: flex; align-items: center; gap: 12px">
        <span class="check-badge" style="width: 44px; height: 44px; border-radius: 22px"><${Icon} name="check" size=${24} sw=${3} /></span>
        <div style="display: flex; flex-direction: column; gap: 2px">
          <h1 style="font-size: 24px; font-weight: 700">${planName(plan)} saved</h1>
          <span class="small muted">${sum.setsLogged} sets logged · ${sum.skipped} skipped · next up: ${planName(next)}</span>
          <span class="small muted">${auto ? 'All exercises done: saved automatically. You can close the app.' : 'Saved automatically. You can close the app.'}</span>
        </div>
      </div>

      ${reached.map((u) => html`<section key=${u.kind + u.at} class="ms-banner">
        <span class="ms-trophy big"><${Icon} name="trophy" size=${26} /></span>
        <span style="display: flex; flex-direction: column; gap: 3px">
          <span class="ms-banner-label">Milestone unlocked</span>
          <strong style="font-size: 20px; font-family: var(--font-rounded)">${u.name} · ${u.title}</strong>
          <span class="small" style="line-height: 1.4; color: var(--text-2)">${u.line}</span>
        </span>
      </section>`)}

      <${SessionCard} key=${session.id} session=${session} note="Optional, e.g. from your watch. You can fill it in later from the log." />

      <${SummaryCards} sum=${sum} plan=${plan} live=${true} />

      ${edited ? null : html`<p class="small muted" style="line-height: 1.5">Today’s weights are the starting point next time you do these exercises, in any workout. Sets and reps still come from the plan.</p>`}
      ${edited ? null : html`<button class="btn btn-big" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${18} sw=${2.2} /> Add another exercise</button>`}
      <button class="btn btn-primary btn-big" onClick=${() => go({ name: 'home' })}><${Icon} name="home" /> Back to Home</button>
      <button class="btn btn-ghost" onClick=${reopen}>Edit this workout</button>
    </div>
    ${adding ? html`<${ExercisePicker} title="Add an exercise" showLast=${true}
      sub="Logged today only. The workout finishes again once it is done."
      exclude=${new Set(session.entries.map((e) => e.exerciseId))}
      onClose=${() => setAdding(false)} onPick=${(exId) => { setAdding(false); addToFinished(id, exId); }} />` : null}
  </div>`;
}

// ======================================================================
// Plans
// ======================================================================

function Plans() {
  const d = useStore();
  const plans = activePlans(d.plans);
  const [tabId, setTabId] = useState(() => plannedPlanId(d.plans, d.settings));
  const [openItem, setOpenItem] = useState(null);
  const [sheet, setSheet] = useState(null);
  const exById = exMap();
  const plan = plans.find((p) => p.id === tabId) || plans[0];
  if (!plan) return html`<div class="screen"><div class="main"><p class="muted">No plans.</p></div><${Nav} active="plans" /></div>`;
  const exOf = (eid) => exById[eid] || { id: eid, name: 'Unknown', equipment: 'machine' };

  // Only which exercises and in which order: every change is saved at once.
  const savePlanItems = (items) => savePlan({ ...plan, items });
  const move = (i, dir) => {
    const items = plan.items.slice();
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const t = items[i]; items[i] = items[j]; items[j] = t;
    savePlanItems(items);
  };
  const remove = (it) => {
    const before = plan.items;
    savePlanItems(before.filter((x) => x.id !== it.id));
    setOpenItem(null);
    toast(exOf(it.exerciseId).name + ' removed from ' + planName(plan) + '.', { label: 'Undo', run: () => { const cur = state.plans.find((p) => p.id === plan.id); if (cur) savePlan({ ...cur, items: before }); } });
  };
  const inPlan = new Set(plan.items.map((it) => it.exerciseId));
  const pick = (exId) => {
    const sh = sheet;
    setSheet(null);
    if (sh.mode === 'replace') savePlanItems(plan.items.map((it) => (it.id === sh.itemId ? { ...it, exerciseId: exId } : it)));
    else savePlanItems([...plan.items, { id: uid(), exerciseId: exId }]);
  };
  const lastW = (ex) => {
    const last = lastDone(d.sessions, ex.id);
    return last ? 'last ' + fmtLoad(last.top, ex) : 'no weight yet';
  };

  return html`<div class="screen">
    <div class="header">
      <div class="header-row">
        <h1 class="title">Plans</h1>
        <span class="small muted">All changes saved</span>
      </div>
      <div class="seg" role="tablist" aria-label="Plan">
        ${plans.map((p) => html`<button key=${p.id} role="tab" aria-selected=${p.id === plan.id} class=${p.id === plan.id ? 'on' : ''} onClick=${() => { setOpenItem(null); setTabId(p.id); }}>${planName(p)}</button>`)}
      </div>
      <p class="small muted" style="line-height: 1.45">Which exercises and in which order. Sets, reps and everything else: Settings → Exercises.</p>
    </div>
    <div class="main">
      ${plan.items.length ? null : html`<${EmptyState}><p class="muted">No exercises in ${planName(plan)} yet. Add the first one below.</p></${EmptyState}>`}
      ${plan.items.map((it, i) => {
        const ex = exOf(it.exerciseId);
        const open = openItem === it.id;
        return html`<div key=${it.id} class=${'card' + (open ? ' ex-card open' : '')}>
          <button class="ex-head" style="min-height: 56px" aria-expanded=${open} onClick=${() => setOpenItem(open ? null : it.id)}>
            <span class="small muted num" style="width: 18px; align-self: flex-start; padding-top: 2px">${i + 1}</span>
            <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
              <span style="font-size: 16px; font-weight: 600; line-height: 1.25">${ex.name}</span>
              <span class="small num" style="color: var(--text-2)">${schemeTextOf(ex, d.settings.progression)} · ${lastW(ex)}</span>
            </span>
            <${ExIcon} id=${ex.id} />
          </button>
          ${open ? html`<div class="btn-row" style="padding: 0 12px 12px">
            <button class="icon-btn" style="background: var(--card-2)" aria-label=${'Move ' + ex.name + ' up'} onClick=${() => move(i, -1)}><${Icon} name="up" size=${18} sw=${2.2} /></button>
            <button class="icon-btn" style="background: var(--card-2)" aria-label=${'Move ' + ex.name + ' down'} onClick=${() => move(i, 1)}><${Icon} name="down" size=${18} sw=${2.2} /></button>
            <button class="btn" onClick=${() => setSheet({ mode: 'replace', itemId: it.id, from: ex.name })}><${Icon} name="swap" size=${16} /> Replace</button>
            <button class="btn btn-warn" onClick=${() => remove(it)}>Remove</button>
          </div>` : null}
        </div>`;
      })}
      <button class="btn-dashed" style="margin-top: 6px" onClick=${() => setSheet({ mode: 'add' })}><${Icon} name="plus" size=${18} sw=${2.2} /> Add exercise to ${planName(plan)}</button>
    </div>
    ${sheet ? html`<${ExercisePicker} title=${sheet.mode === 'replace' ? 'Replace ' + sheet.from + ' with…' : 'Add to ' + planName(plan)}
      sub="Sets, reps and weights follow the exercise everywhere it is used." exclude=${inPlan}
      onClose=${() => setSheet(null)} onPick=${pick} />` : null}
    <${Nav} active="plans" />
  </div>`;
}

// ======================================================================
// Progress
// ======================================================================

function Progress() {
  const d = useStore();
  if (d.progressTab === 'exercises') return html`<${ExerciseProgress} />`;
  if (d.progressTab === 'workouts') return html`<${WorkoutHistory} />`;
  return html`<${Overview} />`;
}

// ---------- Overview: calendar, volume per workout, milestones ----------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Plan colours (first plan blue, second orange; checked for colour-blind separation on the dark card).
const PLAN_COLORS = ['#4A8AF0', '#C9780C'];
const OTHER_COLOR = '#8494B3';
const planColor = (plans, planId) => {
  const i = activePlans(plans).findIndex((p) => p.id === planId);
  return i >= 0 && i < PLAN_COLORS.length ? PLAN_COLORS[i] : OTHER_COLOR;
};
const kgText = (v) => Math.round(v).toLocaleString('en') + ' kg';
const tText = (v) => fmtNum(Math.round(v / 100) / 10) + ' t';

function MonthCalendar({ finished, plans }) {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const byDay = {};
  for (const s of finished) byDay[localDayKey(new Date(s.startedAt))] = s;
  const first = new Date(ym.y, ym.m, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(ym.y, ym.m + 1, 0).getDate();
  const todayKey = localDayKey(now);
  const oldest = new Date(finished[0].startedAt);
  const canPrev = ym.y * 12 + ym.m > oldest.getFullYear() * 12 + oldest.getMonth();
  const canNext = ym.y * 12 + ym.m < now.getFullYear() * 12 + now.getMonth();
  const shift = (k) => { const d = new Date(ym.y, ym.m + k, 1); setYm({ y: d.getFullYear(), m: d.getMonth() }); };
  const inMonth = finished.filter((s) => { const t = new Date(s.startedAt); return t.getFullYear() === ym.y && t.getMonth() === ym.m; }).length;
  const last28 = finished.filter((s) => now - Date.parse(s.startedAt) < 28 * 86400000).length;
  const streak = weeksInARow(finished, now);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(html`<span key=${'b' + i}></span>`);
  for (let day = 1; day <= daysIn; day++) {
    const key = localDayKey(new Date(ym.y, ym.m, day));
    const s = byDay[key];
    const plan = s ? plans.find((p) => p.id === s.planId) : null;
    if (s) cells.push(html`<button key=${key} class="cal-day cal-done" style=${'background:' + planColor(plans, s.planId)}
      aria-label=${day + ' ' + MONTH_NAMES[ym.m] + ', ' + planName(plan) + '. Open its log'} onClick=${() => go({ name: 'session', id: s.id, from: 'progress' })}>${day}</button>`);
    else cells.push(html`<span key=${key} class=${'cal-day' + (key === todayKey ? ' cal-today' : '') + (key > todayKey ? ' cal-future' : '')}>${day}</span>`);
  }
  return html`<section class="card card-pad" style="gap: 10px">
    <div style="display: flex; align-items: center; justify-content: space-between">
      <button class="icon-btn" aria-label="Previous month" disabled=${!canPrev} onClick=${() => shift(-1)}><${Icon} name="back" size=${20} /></button>
      <span style="font-size: 18px; font-weight: 700; font-family: var(--font-rounded)">${MONTH_NAMES[ym.m]} ${ym.y}</span>
      <button class="icon-btn" aria-label="Next month" disabled=${!canNext} onClick=${() => shift(1)}><${Icon} name="next" size=${20} /></button>
    </div>
    <div class="cal-grid">
      ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w, i) => html`<span key=${'w' + i} class="cal-head">${w}</span>`)}
      ${cells}
    </div>
    <div class="legend">${activePlans(plans).slice(0, 2).map((p) => html`<span key=${p.id}><span class="legend-dot" style=${'background:' + planColor(plans, p.id)}></span>${planName(p)}</span>`)}</div>
    <p class="small" style="line-height: 1.45"><strong>${inMonth} ${inMonth === 1 ? 'workout' : 'workouts'}</strong>${' in ' + MONTH_NAMES[ym.m] + ' · '}<strong>${fmtNum(Math.round(last28 / 4 * 10) / 10)}</strong>${' a week (last 4 weeks)'}${streak ? html`${' · '}<strong>${streak} ${streak === 1 ? 'week' : 'weeks'}</strong>${' in a row with 2+'}` : null}</p>
  </section>`;
}

function VolumeChart({ finished, plans }) {
  const [pick, setPick] = useState(null);
  const ctx = volCtx();
  const pts = finished.slice(-16).map((s, i) => ({ i, s, v: sessionVolume(s, ctx) }));
  const series = activePlans(plans).slice(0, 2).map((p) => ({ plan: p, color: planColor(plans, p.id), pts: pts.filter((x) => x.s.planId === p.id) })).filter((x) => x.pts.length);
  if (pts.length < 2 || !series.length) {
    return html`<section class="card card-pad"><span style="font-size: 17px; font-weight: 700">Total volume per workout</span>
      <span class="small muted">The chart appears after your second workout.</span></section>`;
  }
  const W = 340, H = 172, L = 40, R = 58, T = 12, B = 24;
  const vals = pts.map((x) => x.v / 1000);
  let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  const stepT = [0.5, 1, 2, 5, 10, 20, 50].find((st) => (Math.ceil(hi / st) - Math.floor(lo / st)) <= 4) || 100;
  lo = Math.floor(lo / stepT) * stepT; hi = Math.ceil(hi / stepT) * stepT; if (hi === lo) hi = lo + stepT;
  const ticks = []; for (let t = lo; t <= hi + 1e-9; t += stepT) ticks.push(Math.round(t * 10) / 10);
  const n = pts.length;
  const X = (i) => L + 12 + (W - L - R - 12) * (n === 1 ? 0.5 : i / (n - 1));
  const Y = (kg) => T + (H - T - B) * (1 - (kg / 1000 - lo) / (hi - lo));
  const ends = series.map((se) => { const last = se.pts[se.pts.length - 1]; return { se, x: X(last.i), y: Y(last.v), v: last.v }; });
  if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 16) {
    const [a, b] = ends[0].y <= ends[1].y ? [ends[0], ends[1]] : [ends[1], ends[0]];
    a.ly = a.y - 6; b.ly = b.y + 14;
  }
  const picked = pick !== null ? pts[pick] : null;
  const pickedPlan = picked ? plans.find((p) => p.id === picked.s.planId) : null;
  return html`<section class="card card-pad" style="gap: 8px">
    <div style="display: flex; justify-content: space-between; align-items: baseline"><span style="font-size: 17px; font-weight: 700">Total volume per workout</span><span class="tiny muted">real load × reps</span></div>
    <div class="legend">${series.map((se) => html`<span key=${se.plan.id}><span class="legend-line" style=${'background:' + se.color}></span>${planName(se.plan)}</span>`)}</div>
    <p class="small" style="min-height: 20px; color: var(--text-2)">${picked
      ? html`<strong>${fmtDate(picked.s.startedAt, true)}</strong> · ${planName(pickedPlan)} · ${kgText(picked.v)}`
      : 'Tap a point for its date and total.'}</p>
    <svg viewBox=${'0 0 ' + W + ' ' + H} width="100%" role="img" aria-label=${'Total volume of the last ' + n + ' workouts, ' + series.map((se) => planName(se.plan) + ' from ' + tText(se.pts[0].v) + ' to ' + tText(se.pts[se.pts.length - 1].v)).join(', ')}>
      ${ticks.map((t) => html`<g key=${'t' + t}><line x1=${L} x2=${W - R + 6} y1=${Y(t * 1000)} y2=${Y(t * 1000)} stroke="rgba(140,175,255,0.12)" stroke-width="1" />
        <text x=${L - 6} y=${Y(t * 1000) + 4} text-anchor="end" font-size="11" fill="var(--muted)">${fmtNum(t)} t</text></g>`)}
      ${series.map((se) => html`<polyline key=${'l' + se.plan.id} points=${se.pts.map((x) => X(x.i) + ',' + Y(x.v)).join(' ')} fill="none" stroke=${se.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`)}
      ${series.map((se) => se.pts.map((x) => html`<circle key=${'p' + x.i} cx=${X(x.i)} cy=${Y(x.v)} r=${pick === x.i ? 6 : 4.5} fill=${se.color} stroke="var(--card)" stroke-width="2" />`))}
      ${ends.map((e) => html`<text key=${'e' + e.se.plan.id} x=${e.x + 9} y=${(e.ly ?? e.y + 4)} font-size="12" font-weight="700" fill="var(--text)">${e.se.plan.name} ${tText(e.v)}</text>`)}
      <text x=${L} y=${H - 6} font-size="11" fill="var(--muted)">${fmtDate(pts[0].s.startedAt)}</text>
      <text x=${W - R + 6} y=${H - 6} text-anchor="end" font-size="11" fill="var(--muted)">${fmtDate(pts[n - 1].s.startedAt)}</text>
      ${pts.map((x) => html`<circle key=${'h' + x.i} cx=${X(x.i)} cy=${Y(x.v)} r="14" fill="transparent" style="cursor: pointer" onClick=${() => setPick(pick === x.i ? null : x.i)} />`)}
    </svg>
    <span class="tiny muted" style="line-height: 1.4">Each point is one workout${n < finished.length ? ' (last ' + n + ')' : ''}. ${series.length > 1 ? 'Compare A with A and B with B: they have different exercises.' : ''}</span>
  </section>`;
}

function Milestones({ sessions }) {
  const ms = computeMilestones(sessions, new Date(), volCtx());
  const unlocked = ms.unlocked.slice().sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const valueText = (n) => n.kind === 'lifted' ? tText(n.value) + ' / ' + tText(n.at) : Math.min(n.value, n.at) + ' / ' + n.at;
  return html`
    <section class="card card-pad" style="gap: 4px">
      <span class="small muted">Lifted so far</span>
      <span class="hero-num">${tText(ms.totals.lifted)}</span>
      <span class="small" style="color: var(--text-2); line-height: 1.4">${liftedComparison(ms.totals.lifted, localDayKey())}</span>
    </section>
    <span class="section-label">Next milestones</span>
    <section class="card" style="overflow: hidden">
      ${ms.next.map((n, i) => html`<div key=${n.kind} class="ms-row" style=${i ? '' : 'border-top: 0'}>
        <div style="display: flex; justify-content: space-between; gap: 8px"><span style="font-weight: 600">${n.name}</span><span class="small num" style="color: var(--text-2); white-space: nowrap">${valueText(n)}</span></div>
        <span class="small muted">${n.title}</span>
        <div class="ms-bar"><div style=${'width:' + Math.round(n.progress * 100) + '%'}></div></div>
      </div>`)}
    </section>
    ${unlocked.length ? html`<span class="section-label">Unlocked · ${unlocked.length}</span>
    <section class="card" style="overflow: hidden">
      ${unlocked.map((u, i) => html`<div key=${u.kind + u.at} class="ms-done" style=${i ? '' : 'border-top: 0'}>
        <span class="ms-trophy"><${Icon} name="trophy" size=${18} /></span>
        <span style="flex: 1; display: flex; flex-direction: column; gap: 2px"><span style="font-weight: 600">${u.name}</span><span class="small muted">${u.title}</span></span>
        <span class="small muted">${fmtDate(u.date)}</span>
      </div>`)}
    </section>` : null}`;
}

function Overview() {
  const d = useStore();
  const finished = d.sessions.filter((s) => s.finishedAt).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return html`<div class="screen">
    <div class="header">
      <h1 class="title">Progress</h1>
      <${ProgressTabs} active="overview" />
    </div>
    <div class="main" style="gap: 12px">
      ${finished.length ? html`
        <${MonthCalendar} finished=${finished} plans=${d.plans} />
        <${VolumeChart} finished=${finished} plans=${d.plans} />
        <${Milestones} sessions=${d.sessions} />`
        : html`<${EmptyState}><p class="muted">Finish your first workout to see your calendar, volume and milestones here.</p></${EmptyState}>`}
    </div>
    <${Nav} active="progress" />
  </div>`;
}

function WorkoutHistory() {
  const d = useStore();
  const [limit, setLimit] = useState(30);
  const exById = exMap();
  const list = d.sessions.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const shown = list.slice(0, limit);
  return html`<div class="screen">
    <div class="header">
      <h1 class="title">Progress</h1>
      <${ProgressTabs} active="workouts" />
    </div>
    <div class="main">
      ${list.length ? null : html`<${EmptyState}><p class="muted">No workouts logged yet. Finished workouts show up here.</p></${EmptyState}>`}
      ${shown.map((s) => {
        const plan = d.plans.find((p) => p.id === s.planId);
        const done = s.entries.filter((e) => e.status === 'done');
        const tags = [];
        if (!s.finishedAt) tags.push(['In progress', '']);
        else {
          const recs = sessionSummary(s, d.sessions, exById, plan, volCtx()).records;
          if (recs) tags.push([recs + (recs === 1 ? ' record' : ' records'), 'rec']);
        }
        const swaps = s.entries.filter((e) => e.kind === 'swapped' && e.status === 'done').length;
        const added = s.entries.filter((e) => e.kind === 'added' && e.status === 'done').length;
        const skipped = s.entries.filter((e) => e.status === 'skipped').length;
        if (swaps) tags.push([swaps + ' swapped', '']);
        if (added) tags.push([added + ' added', '']);
        if (skipped) tags.push([skipped + ' skipped', 'warn']);
        return html`<button key=${s.id} class="card card-pad" style="text-align: left; padding: 14px; gap: 6px"
          onClick=${() => go(s.finishedAt ? { name: 'session', id: s.id } : { name: 'workout', id: s.id })}>
          <span style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px">
            <span style="font-size: 17px; font-weight: 600">${fmtDate(s.startedAt, true)} · ${hhmm(s.startedAt)}</span>
            <span class="small muted">${planName(plan)}</span>
          </span>
          <span class="small muted">${done.length} ${done.length === 1 ? 'exercise' : 'exercises'} done${sessionDataText(s) ? ' · ' + sessionDataText(s) : ''}</span>
          ${tags.length ? html`<span class="tags">${tags.map(([t, k]) => html`<span key=${t} class=${'tag ' + k}>${t}</span>`)}</span>` : null}
        </button>`;
      })}
      ${list.length > limit ? html`<button class="btn" onClick=${() => setLimit(limit + 30)}>Show more</button>` : null}
    </div>
    <${Nav} active="progress" />
  </div>`;
}

function SessionDetail({ id, from }) {
  const d = useStore();
  const [confirm, setConfirm] = useState(false);
  const session = d.sessions.find((s) => s.id === id);
  useEffect(() => { if (!session) go({ name: 'progress' }); }, [session]);
  if (!session) return null;
  const exById = exMap();
  const plan = d.plans.find((p) => p.id === session.planId);
  const sum = sessionSummary(session, d.sessions, exById, plan, volCtx());
  const recById = Object.fromEntries(sum.rows.filter((r) => r.record).map((r) => [r.entryId, r.record]));
  const done = doneInOrder(session);
  const skipped = session.entries.filter((e) => e.status !== 'done').sort((a, b) => a.order - b.order);
  const reminders = session.entries.filter((e) => hasReminder(e.reminder)).sort((a, b) => a.order - b.order);
  const name = (exId) => (exById[exId] || {}).name || 'Exercise';
  const finished = d.sessions.filter((s) => s.finishedAt).sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  const isLatest = finished[0] && finished[0].id === session.id;

  const edit = () => go({ name: 'workout', id });
  const del = () => {
    setConfirm(false);
    go({ name: from === 'home' ? 'home' : 'progress' });
    removeSession(session);
    toast('Workout deleted.');
  };

  return html`<div class="screen">
    <div class="header" style="gap: 6px">
      <button class="btn btn-ghost link" style="align-self: flex-start; margin-left: -10px; padding: 0 8px; font-size: 16px" onClick=${() => go({ name: from === 'home' ? 'home' : 'progress' })}><${Icon} name="back" size=${20} sw=${2.2} />${from === 'home' ? 'Today' : d.progressTab === 'overview' ? 'Progress' : 'Workouts'}</button>
      <h1 class="title">${planName(plan)}</h1>
      <span class="small muted">${fmtDate(session.startedAt, true)} · ${hhmm(session.startedAt)}${session.mode === 'double' ? html` <span class="mode-tag double">Double progression</span>` : null}</span>
    </div>
    <div class="main">
      <${SessionCard} key=${session.id} session=${session} note="Fill in when you like: it saves as you type." />
      <span class="section-label">Done, in this order · ${done.length}</span>
      ${done.length ? html`<div class="card">
        ${done.map((e, i) => {
          const tags = [];
          const rec = recById[e.id];
          if (rec) tags.push([rec.kind === 'weight' ? 'New record ' + fmtLoad(rec.value, exById[e.exerciseId]) : 'New record ' + rec.value + ' reps', 'rec']);
          if (e.kind === 'swapped') tags.push(['Replaces ' + name(e.replacesExerciseId), '']);
          if (e.kind === 'added') tags.push(['Added', '']);
          if (e.plannedSets && e.sets.length !== e.plannedSets) tags.push([e.sets.length + ' of ' + e.plannedSets + ' sets', 'warn']);
          if (e.appliedScheme) tags.push(['Now ' + e.appliedScheme, '']);
          return html`<div key=${e.id} class="log-row">
            <span class="small muted num" style="width: 18px; flex-shrink: 0; font-weight: 600">${i + 1}</span>
            <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px">
              <span style="font-size: 15px; font-weight: 600">${name(e.exerciseId)}</span>
              <span class="small num" style="color: var(--text-2)">${setsText(e.sets, exById[e.exerciseId])}</span>
              ${tags.length ? html`<span class="tags">${tags.map(([t, k]) => html`<span key=${t} class=${'tag ' + k}>${t}</span>`)}</span>` : null}
            </div>
            <${ExIcon} id=${e.exerciseId} />
          </div>`;
        })}
      </div>` : html`<p class="small muted" style="margin: 0 4px">No exercises were confirmed.</p>`}

      ${skipped.length ? html`<span class="section-label">Skipped · ${skipped.length}</span>
        <div class="card card-pad" style="padding: 12px 14px; color: var(--text-2)">${skipped.map((e) => name(e.exerciseId)).join(' · ')}</div>` : null}

      ${reminders.length ? html`<span class="section-label">Reminders set for next time</span>
        <div class="card" style="padding: 4px 14px">
          ${reminders.map((e) => html`<div key=${e.id} class="small" style="padding: 8px 0; color: var(--text-2)"><strong style="color: var(--text)">${name(e.exerciseId)}</strong> · ${reminderText(e.reminder)}</div>`)}
        </div>` : null}

      <${SummaryCards} sum=${sum} plan=${plan} live=${false} />

      <div class="grid-2" style="margin-top: 10px">
        <button class="btn btn-big" onClick=${edit}>Edit workout</button>
        <button class="btn btn-big btn-warn" onClick=${() => setConfirm(true)}><${Icon} name="trash" size=${18} /> Delete</button>
      </div>
    </div>
    ${confirm ? html`<div class="overlay center">
      <div class="dialog" role="alertdialog" aria-labelledby="del-title">
        <h2 id="del-title">Delete this workout?</h2>
        <p style="line-height: 1.45">${fmtDate(session.startedAt, true)}, ${planName(plan)} disappears from the log, with its reminders. Starting weights and records are recalculated without it.</p>
        ${isLatest ? html`<p class="small muted" style="line-height: 1.45">It is your latest workout, so the rotation goes back: ${planName(plan)} is up next again.</p>` : null}
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px">
          <button class="btn btn-primary btn-big" autofocus onClick=${() => setConfirm(false)}>Keep it</button>
          <button class="btn btn-big btn-warn" onClick=${del}>Delete workout</button>
        </div>
      </div>
    </div>` : null}
  </div>`;
}

function ExerciseProgress() {
  const d = useStore();
  const withHistory = d.exercises.filter((e) => exerciseHistory(d.sessions, e.id).length);
  const [exId, setExId] = useState(() => (withHistory[0] || d.exercises[0] || {}).id);
  const [sel, setSel] = useState(null);
  const [all, setAll] = useState(false);
  const [picker, setPicker] = useState(false);
  const ex = d.exercises.find((e) => e.id === exId);
  const hist = ex ? exerciseHistory(d.sessions, ex.id) : [];
  const planOf = (s) => d.plans.find((p) => p.id === s.planId);
  const inPlans = (id) => activePlans(d.plans).filter((p) => p.items.some((it) => it.exerciseId === id)).map((p) => p.name).join(' + ');

  let body;
  if (!ex) body = html`<${EmptyState}><p class="muted">No exercises yet.</p></${EmptyState}>`;
  else if (!hist.length) body = html`<${EmptyState}><p class="muted">No sessions logged for ${ex.name} yet. Confirm it in a workout and it shows up here.</p></${EmptyState}>`;
  else {
    const bw = hist.every((h) => h.top === 0);
    const unit = bw ? ' reps' : ' kg';
    const val = (h) => (bw ? h.totalReps : h.top);
    const fmtV = (v) => (bw ? v + ' reps' : fmtLoad(v, ex));
    const windowed = hist.slice(-10);
    const first = windowed[0], last = hist[hist.length - 1];
    const diff = round2(val(last) - val(first));
    const pr = personalRecord(hist);

    const pts = hist.slice(-20);
    const N = pts.length;
    const vals = pts.map(val);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = bw ? 2 : 2.5;
    lo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad; hi += pad;
    const W = 340, L = 36, R = 336, T = 12, B = 164;
    const X = (i) => (N === 1 ? (L + R) / 2 : L + 8 + (i / (N - 1)) * (R - L - 16));
    const Y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);
    const s = sel === null || sel >= N ? N - 1 : sel;
    const ticks = [lo, (lo + hi) / 2, hi];
    const colW = N === 1 ? 120 : (R - L - 16) / (N - 1);
    const sx = X(s), sy = Y(vals[s]);
    const tipLeft = Math.min(Math.max(sx - 62, 0), W - 124);
    const tipTop = sy < 80 ? sy + 14 : Math.max(0, sy - 80);
    const recent = hist.slice().reverse().slice(0, all ? hist.length : 5);
    const pct = (x) => (x / W) * 100 + '%';

    body = html`
      <section class="card card-pad">
        <span class="section-label" style="margin: 0">${bw ? 'Total reps, last session' : 'Top-set weight, last session'}</span>
        <div style="display: flex; align-items: baseline; gap: 10px">
          <span class="hero-num num">${fmtV(val(last))}</span>
          <span class="num" style="font-weight: 600; color: var(--text-2)">${(diff > 0 ? '+' : diff < 0 ? '−' : '±') + fmtNum(Math.abs(diff)) + unit}</span>
        </div>
        <span class="small muted">Change over the last ${windowed.length} ${windowed.length === 1 ? 'session' : 'sessions'}, since ${fmtDate(first.session.startedAt)}</span>
      </section>

      <section class="card card-pad" style="flex-direction: row; align-items: center; gap: 14px">
        <span style="width: 44px; height: 44px; flex-shrink: 0; border-radius: 22px; background: rgba(91,155,255,0.14); color: var(--accent); display: flex; align-items: center; justify-content: center"><${Icon} name="trophy" size=${22} /></span>
        <div style="flex: 1; display: flex; flex-direction: column; gap: 2px">
          <span class="section-label" style="margin: 0">Personal record</span>
          <span class="num" style="font-size: 22px; font-weight: 700">${pr.kind === 'weight' ? fmtLoad(pr.value, ex) + ' × ' + pr.reps : pr.value + ' reps'}</span>
          <span class="small num" style="color: var(--text-2)">${pr.kind === 'weight'
            ? 'Set ' + (pr.setIndex + 1) + ' of ' + pr.setCount + ', in a ' + schemeText(pr.item.entry.sets) + ' (' + setsText(pr.item.entry.sets, ex) + ')'
            : 'Most total reps in a session: ' + pr.item.entry.sets.map((x) => x.reps).join(' · ')}</span>
          <span class="small muted">First reached ${fmtDate(pr.item.session.startedAt)} · ${planName(planOf(pr.item.session))}</span>
        </div>
      </section>

      <section class="card card-pad" style="padding: 16px 12px 12px; gap: 10px">
        <h2 style="margin: 0 4px; font-size: 15px; font-weight: 600">${bw ? 'Total reps per session' : 'Top-set weight per session (kg)'}</h2>
        <div class="chart">
          <svg viewBox=${'0 0 ' + W + ' 200'} aria-hidden="true">
            ${ticks.map((t, i) => html`<g key=${i}><line x1=${L} x2=${R} y1=${Y(t)} y2=${Y(t)} stroke="rgba(140,175,255,0.12)" stroke-width="1" />
              <text x=${L - 6} y=${Y(t) + 4} text-anchor="end" font-size="11" fill="#9DA9C0">${bw ? Math.round(t) : fmtNum(Math.round(t * 4) / 4)}</text></g>`)}
            <line x1=${sx} x2=${sx} y1=${T} y2=${B} stroke="rgba(140,175,255,0.35)" stroke-width="1" />
            ${N > 1 ? html`<polyline points=${pts.map((h, i) => X(i).toFixed(1) + ',' + Y(vals[i]).toFixed(1)).join(' ')} fill="none" stroke="#4C8DF5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />` : null}
            ${pts.map((h, i) => html`<circle key=${i} cx=${X(i)} cy=${Y(vals[i])} r=${i === s ? 6 : 4} fill="#4C8DF5" stroke="#16213A" stroke-width="2" />`)}
            <text x=${L} y="190" font-size="11" fill="#9DA9C0">${fmtDate(pts[0].session.startedAt)}</text>
            <text x=${R} y="190" font-size="11" fill="#9DA9C0" text-anchor="end">${fmtDate(pts[N - 1].session.startedAt)}</text>
          </svg>
          ${pts.map((h, i) => html`<button key=${'b' + i} aria-label=${fmtDate(h.session.startedAt) + ', ' + fmtV(vals[i])} onClick=${() => setSel(i)}
            style=${'position:absolute;top:0;height:88%;border:0;padding:0;background:transparent;left:' + pct(X(i) - colW / 2) + ';width:' + pct(colW)}></button>`)}
          <div class="tip" role="status" style=${'left:' + pct(tipLeft) + ';top:' + (tipTop / 200) * 100 + '%'}>
            <span class="tiny muted">${fmtDate(pts[s].session.startedAt) + ' · ' + planName(planOf(pts[s].session))}</span>
            <span class="num" style="font-weight: 600">${fmtV(vals[s])}</span>
            <span class="tiny muted num">${setsText(pts[s].entry.sets, ex)}</span>
          </div>
        </div>
        <p class="tiny muted" style="margin: 0 4px">Tap the chart to see a session.</p>
      </section>

      <span class="section-label">Recent sessions</span>
      ${recent.map((h) => html`<div key=${h.entry.id} class="card card-pad" style="padding: 12px 14px; gap: 4px">
        <div style="display: flex; justify-content: space-between; gap: 8px">
          <span style="font-size: 14px; font-weight: 600">${fmtDate(h.session.startedAt, true)}</span>
          <span class="small muted">${planName(planOf(h.session))}${h.entry.kind === 'swapped' ? ' · as swap' : h.entry.kind === 'added' ? ' · added' : ''}</span>
        </div>
        <span class="small num" style="color: var(--text-2)">${setsText(h.entry.sets, ex)}</span>
      </div>`)}
      ${hist.length > 5 ? html`<button class="btn" onClick=${() => setAll(!all)}>${all ? 'Show less' : 'Show all (' + hist.length + ' sessions)'}</button>` : null}`;
  }

  return html`<div class="screen">
    <div class="header">
      <h1 class="title">Progress</h1>
      <${ProgressTabs} active="exercises" />
      <button class="card" style="min-height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 14px; text-align: left" onClick=${() => setPicker(true)} aria-haspopup="dialog">
        <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px"><span class="col-label" style="text-align: left">EXERCISE</span><span style="font-weight: 600">${ex ? ex.name : '—'}</span></span>
        ${ex ? html`<${ExIcon} id=${ex.id} size=${48} />` : null}
        <span class="muted"><${Icon} name="chevron" /></span>
      </button>
    </div>
    <div class="main" style="gap: 12px">${body}</div>
    ${picker ? html`<${Sheet} title="Choose an exercise" onClose=${() => setPicker(false)}>
      ${d.exercises.filter((e) => !e.archived).sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
        const n = exerciseHistory(d.sessions, e.id).length;
        return html`<${ExPickRow} key=${e.id} ex=${e} sub=${n ? n + (n === 1 ? ' session' : ' sessions') : inPlans(e.id) ? 'Workout ' + inPlans(e.id) : ''}
          onClick=${() => { setExId(e.id); setSel(null); setAll(false); setPicker(false); }} />`;
      })}
    <//>` : null}
    <${Nav} active="progress" />
  </div>`;
}

// ======================================================================
// Settings
// ======================================================================

// How an exercise logs its weight. Only volume, total lifted and milestones use the real load.
const LOAD_OPTIONS = [
  ['total', 'Total', 'The weight you set: machines, cables'],
  ['each', 'Each dumbbell', 'One dumbbell’s weight; counted × 2'],
  ['plates', 'Plates per side + bar', 'The plates on one side; counted × 2 + the bar'],
  ['bodyweight', 'Body weight + added', 'Kg added with a belt; negative if assisted']
];
function LoadPicker({ ex, onChange }) {
  const kind = loadOf(ex);
  const bar = barOf(ex);
  const preset = BARS.find((b) => b.kg === bar);
  const [other, setOther] = useState(!preset);
  const [barText, setBarText] = useState(fmtNum(bar));
  const commitBar = () => {
    const v = parseNum(barText);
    if (Number.isNaN(v) || v < 0) { setBarText(fmtNum(bar)); return; }
    onChange({ load: 'plates', bar: round2(v) });
  };
  return html`<div class="field">How you log the weight
    <div class="load-list" role="radiogroup" aria-label="How you log the weight">
      ${LOAD_OPTIONS.map(([k, title, sub]) => html`<div key=${k} class=${'load-item' + (kind === k ? ' on' : '')}>
        <button role="radio" aria-checked=${kind === k} class="load-opt" onClick=${() => onChange(k === 'plates' ? { load: k, bar } : { load: k })}>
          <span class="radio-dot" aria-hidden="true"></span>
          <span class="load-text"><span class="load-title">${title}</span><span class="tiny muted">${sub}</span></span>
        </button>
        ${k === 'plates' && kind === 'plates' ? html`<div class="load-bar">
          <span class="small" style="font-weight: 600; color: var(--text-2)">Bar weight</span>
          <div class="chips">
            ${BARS.map((b) => html`<button key=${b.label} class=${'chip-btn' + (!other && bar === b.kg ? ' on' : '')} aria-pressed=${!other && bar === b.kg}
              onClick=${() => { setOther(false); setBarText(fmtNum(b.kg)); onChange({ load: 'plates', bar: b.kg }); }}>${b.label} ${fmtNum(b.kg)} kg</button>`)}
            <button class=${'chip-btn' + (other ? ' on' : '')} aria-pressed=${other} onClick=${() => setOther(true)}>Other…</button>
          </div>
          ${other ? html`<label class="load-other">Bar
            <input class="input" inputmode="decimal" enterkeyhint="done" aria-label="Bar weight in kg" value=${barText}
              onInput=${(e) => setBarText(e.target.value.replace(/[^0-9.,]/g, ''))} onBlur=${commitBar} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} /> kg</label>` : null}
          <span class="tiny muted" style="font-weight: 400">Example: 10 kg per side → ${fmtNum(20 + bar)} kg lifted.</span>
        </div>` : null}
      </div>`)}
    </div>
    <span class="tiny muted" style="font-weight: 400; line-height: 1.4">Only volume, total lifted and milestones use the real load. Your numbers, records and suggestions stay as you log them.</span>
  </div>`;
}

// The per-exercise switch for automatic "more weight" suggestions (on unless switched off).
function SuggestSwitch({ ex, onChange }) {
  const on = !ex.noSuggest;
  return html`<div class="row" style="padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 12px; gap: 12px">
    <span style="display: flex; flex-direction: column; gap: 2px">
      <span style="font-weight: 600">Suggest more weight</span>
      <span class="tiny muted" style="line-height: 1.4">${on
        ? 'A green ↑ appears after two times in a row with every planned rep done at the same weight.'
        : 'Off: no automatic ↑ for ' + ex.name + ', in any workout. Your own reminders still work.'}</span>
    </span>
    <button class=${'switch' + (on ? ' on' : '')} role="switch" aria-checked=${on} aria-label="Suggest more weight" onClick=${() => onChange(!on)}><span></span></button>
  </div>`;
}

// A whole number field saved when you leave it; empty or invalid goes back to the saved value.
function IntField({ label, value, onSave, min = 1, max = 50 }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = parseInt(text, 10);
    if (!(n >= min && n <= max)) { setText(String(value)); return; }
    if (n !== value) onSave(n);
  };
  return html`<label class="field">${label}
    <input class="input" inputmode="numeric" enterkeyhint="done" value=${text}
      onInput=${(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))} onBlur=${commit} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />
  </label>`;
}

// Classic: sets and reps. Double progression: sets and the reps range. Choosing one decides how the
// exercise works when Settings is on Double progression; the values of both are kept.
function ProgressionFields({ ex, save }) {
  const dbl = !!ex.double;
  const cs = classicScheme(ex);
  const choose = (on) => {
    if (on === dbl) return;
    if (!on) { save({ double: false }); return; }
    const r = hasRange(ex) ? { min: ex.repMin, max: ex.repMax } : defaultRange(cs.reps);
    save({ double: true, repMin: r.min, repMax: r.max, dSets: doubleSets(ex) });
  };
  // The edited end wins: a bottom above the top moves the top up, and the other way round.
  const setRange = (which, n) => {
    let a = which === 'min' ? n : ex.repMin, b = which === 'max' ? n : ex.repMax;
    if (a > b) { if (which === 'min') b = a; else a = b; }
    save({ repMin: a, repMax: b });
  };
  return html`<div class="field">Progression
    <div class="seg" role="radiogroup" aria-label="Progression of this exercise">
      <button role="radio" aria-checked=${!dbl} class=${!dbl ? 'on' : ''} onClick=${() => choose(false)}>Classic</button>
      <button role="radio" aria-checked=${dbl} class=${dbl ? 'on' : ''} onClick=${() => choose(true)}>Double progression</button>
    </div>
  </div>
  ${dbl ? html`<div class="grid-3">
      <${IntField} key=${'ds' + ex.id} label="Sets" value=${doubleSets(ex)} onSave=${(n) => save({ dSets: n })} />
      <${IntField} key=${'rmin' + ex.id} label="Reps from" value=${ex.repMin} onSave=${(n) => setRange('min', n)} />
      <${IntField} key=${'rmax' + ex.id} label="Reps to" value=${ex.repMax} onSave=${(n) => setRange('max', n)} />
    </div>`
    : html`<div class="grid-2">
      <${IntField} key=${'cs' + ex.id} label="Sets" value=${cs.sets} onSave=${(n) => save({ sets: n })} />
      <${IntField} key=${'cr' + ex.id} label="Reps" value=${cs.reps} onSave=${(n) => save({ reps: n })} />
    </div>`}`;
}

function ExerciseEditor({ ex, inPlans }) {
  const d = useStore();
  const [name, setName] = useState(ex.name);
  const [setup, setSetup] = useState(ex.setup || '');
  const save = (patch) => saveExercise({ ...ex, ...patch });
  const commitName = () => {
    const n = name.trim();
    if (!n) { setName(ex.name); return; }
    const clash = state.exercises.some((e) => e.id !== ex.id && e.name.trim().toLowerCase() === n.toLowerCase());
    if (clash) { toast('Another exercise already has this name.'); setName(ex.name); return; }
    if (n !== ex.name) save({ name: n });
  };
  const blurOnEnter = (e) => { if (e.key === 'Enter') e.target.blur(); };
  return html`<div style="padding: 12px 12px 14px; display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--line)">
    <label class="field">Name (renames it everywhere, history included)
      <input class="input" value=${name} onInput=${(e) => setName(e.target.value)} onBlur=${commitName} onKeyDown=${blurOnEnter} />
    </label>
    <span class="section-label" style="margin: 4px 0 0">Sets and reps</span>
    <${ProgressionFields} ex=${ex} save=${save} />
    <span class="section-label" style="margin: 4px 0 0">Weight</span>
    <${LoadPicker} key=${ex.id} ex=${ex} onChange=${(patch) => save(patch)} />
    <div class="field">Equipment (+/− steps)
      <div class="seg" role="radiogroup" aria-label="Equipment">
        <button role="radio" aria-checked=${ex.equipment !== 'dumbbell'} class=${ex.equipment !== 'dumbbell' ? 'on' : ''} onClick=${() => save({ equipment: 'machine' })}>Machine / barbell</button>
        <button role="radio" aria-checked=${ex.equipment === 'dumbbell'} class=${ex.equipment === 'dumbbell' ? 'on' : ''} onClick=${() => save({ equipment: 'dumbbell' })}>Dumbbells</button>
      </div>
      <span class="tiny muted" style="font-weight: 400">${ex.equipment === 'dumbbell'
        ? '+/− steps: ' + fmtNum(d.settings.stepDbSmall) + ' kg up to ' + fmtNum(d.settings.dbThreshold) + ' kg, then ' + fmtNum(d.settings.stepDbLarge) + ' kg'
        : '+/− steps: ' + fmtNum(d.settings.stepMachine) + ' kg'}</span>
    </div>
    <span class="section-label" style="margin: 4px 0 0">More</span>
    <label class="field">Machine setup (shown with an extra tap)
      <input class="input" placeholder="e.g. seat 4, pad XL" value=${setup} onInput=${(e) => setSetup(e.target.value)} onBlur=${() => { if (setup !== (ex.setup || '')) save({ setup }); }} onKeyDown=${blurOnEnter} />
    </label>
    <${SuggestSwitch} ex=${ex} onChange=${(on) => save({ noSuggest: !on })} />
    ${inPlans.length
      ? html`<p class="tiny muted">In ${inPlans.map((n) => 'Workout ' + n).join(' and ')}. To archive it, remove it from the plan first.</p>`
      : html`<button class="btn btn-warn" style="align-self: flex-start" onClick=${() => { save({ archived: true }); toast(ex.name + ' archived. Its history is kept.'); }}>Archive</button>`}
  </div>`;
}

// Finds "Machine Low Row" from "mach", "low" or "ow r": any part of the name, capitals ignored.
const matchesName = (name, q) => name.toLowerCase().includes(q.trim().toLowerCase());

function Exercises() {
  const d = useStore();
  const [openId, setOpenId] = useState(null);
  const [newName, setNewName] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const plans = activePlans(d.plans);
  const inPlans = (id) => plans.filter((p) => p.items.some((it) => it.exerciseId === id)).map((p) => p.name);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const active = d.exercises.filter((e) => !e.archived).sort(byName);
  const archived = d.exercises.filter((e) => e.archived).sort(byName);
  const shown = query.trim() ? active.filter((e) => matchesName(e.name, query)) : active;
  const create = () => {
    const n = newName.trim();
    if (!n) return;
    if (d.exercises.some((e) => e.name.trim().toLowerCase() === n.toLowerCase())) { toast(n + ' is already in the catalog.'); return; }
    const ex = { id: uid(), name: n, equipment: 'machine', setup: '', notes: '', archived: false, load: 'total', sets: 3, reps: 8, dSets: 3 };
    saveExercise(ex);
    setNewName('');
    setQuery('');
    setOpenId(ex.id);
  };
  return html`<div class="screen">
    <div class="header" style="gap: 6px">
      <button class="btn btn-ghost link" style="align-self: flex-start; margin-left: -10px; padding: 0 8px; font-size: 16px" onClick=${() => go({ name: 'settings' })}><${Icon} name="back" size=${20} sw=${2.2} />Settings</button>
      <h1 class="title">Exercises</h1>
      <label class="search">
        <${Icon} name="search" size=${18} sw=${2.2} />
        <input type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck=${false} placeholder="Search exercises" aria-label="Search exercises"
          value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />
        ${query ? html`<button class="icon-btn" aria-label="Clear the search" onClick=${() => setQuery('')}><${Icon} name="x" size=${18} /></button>` : null}
      </label>
    </div>
    <div class="main">
      ${query.trim() ? html`<span class="small muted">${shown.length} of ${active.length}</span>` : null}
      ${shown.map((ex) => {
        const open = openId === ex.id;
        const ps = inPlans(ex.id);
        const last = lastDone(d.sessions, ex.id);
        const wTxt = last ? (last.top === 0 && loadOf(ex) !== 'bodyweight' ? 'bodyweight' : 'last ' + fmtLoad(last.top, ex)) : 'no weight yet';
        const scheme = ex.double && hasRange(ex) ? 'Double ' + doubleSets(ex) + ' × ' + rangeText(ex) : schemeTextOf(ex, 'classic');
        return html`<div key=${ex.id} class=${'card' + (open ? ' ex-card open' : '')}>
          <button class="ex-head" style="min-height: 60px" aria-expanded=${open} onClick=${() => setOpenId(open ? null : ex.id)}>
            <div class="ex-head-text">
              <span class="ex-name">${ex.name}</span>
              <span class="small muted">${loadLabel(ex)} · ${scheme} · ${ps.length ? 'Workout ' + ps.join(' + ') : 'not in a plan'} · ${wTxt}</span>
            </div>
          </button>
          ${open ? html`<${ExerciseEditor} key=${ex.id} ex=${ex} inPlans=${ps} />` : null}
        </div>`;
      })}
      ${query.trim() && !shown.length ? html`<p class="small muted" style="text-align: center; padding: 12px 0">No exercise matches “${query.trim()}”.</p>` : null}
      <span class="section-label" style="margin-top: 18px">Add</span>
      <div style="display: flex; gap: 8px">
        <input class="input" style="flex: 1" placeholder="New exercise name" aria-label="New exercise name" value=${newName} onInput=${(e) => setNewName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') create(); }} />
        <button class="btn" onClick=${create}>Add</button>
      </div>
      <${ImportButton} label="Add exercises from file" cls="btn" onFile=${addExercisesFromFile} />
      ${archived.length ? html`<button class="btn btn-ghost" onClick=${() => setShowArchived(!showArchived)}>${showArchived ? 'Hide' : 'Show'} archived (${archived.length})</button>` : null}
      ${showArchived ? archived.map((ex) => html`<div key=${ex.id} class="card row">
        <span class="muted">${ex.name}</span>
        <button class="btn" onClick=${() => { saveExercise({ ...ex, archived: false }); toast(ex.name + ' restored.'); }}>Restore</button>
      </div>`) : null}
    </div>
    <${Nav} active="settings" />
  </div>`;
}

function NumberSetting({ label, value, onSave, width = 56 }) {
  const [text, setText] = useState(fmtNum(value));
  useEffect(() => setText(fmtNum(value)), [value]);
  const commit = () => {
    const v = parseNum(text);
    if (Number.isNaN(v) || v <= 0) { setText(fmtNum(value)); return; }
    onSave(round2(v));
  };
  return html`<input class="input" style=${'width:' + width + 'px; text-align: center; padding: 0 6px'} inputmode="decimal" aria-label=${label} value=${text}
    onInput=${(e) => setText(e.target.value)} onBlur=${commit} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />`;
}

// Body weight: empty clears it. Saved when you leave the field.
function BodyWeightInput({ value }) {
  const [text, setText] = useState(value === null || value === undefined ? '' : fmtNum(value));
  useEffect(() => setText(value === null || value === undefined ? '' : fmtNum(value)), [value]);
  const commit = () => {
    const v = parseNum(text);
    const next = text.trim() === '' ? null : Number.isNaN(v) || v <= 0 || v > 400 ? undefined : round2(v);
    if (next === undefined) { setText(value === null || value === undefined ? '' : fmtNum(value)); return; }
    if (next !== (value ?? null)) setBodyWeight(next);
  };
  return html`<input class="input" style="width: 80px; text-align: center; padding: 0 6px" inputmode="decimal" enterkeyhint="done" aria-label="Body weight in kg" placeholder="—" value=${text}
    onInput=${(e) => setText(e.target.value.replace(/[^0-9.,]/g, ''))} onBlur=${commit} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />`;
}

function Settings() {
  const d = useStore();
  const s = d.settings;
  const plans = activePlans(d.plans);
  const next = plannedPlanId(d.plans, s);
  const toggles = [
    ['keepAwake', 'Keep screen awake', 'The display stays on while a workout is open'],
    ['autoAdvance', 'Auto-advance', 'Open the next exercise after Done or Skip'],
    ['showQuote', 'Daily quote', 'A new line on Today each day']
  ];
  return html`<div class="screen">
    <div class="header"><h1 class="title">Settings</h1></div>
    <div class="main" style="gap: 6px">
      <span class="section-label">Progression</span>
      <div class="card card-pad" style="gap: 10px">
        <div class="seg" role="radiogroup" aria-label="Progression" style="background: var(--bg)">
          <button role="radio" aria-checked=${s.progression !== 'double'} class=${s.progression !== 'double' ? 'on' : ''} onClick=${() => saveSettings({ progression: 'classic' })}>Classic</button>
          <button role="radio" aria-checked=${s.progression === 'double'} class=${s.progression === 'double' ? 'on' : ''} onClick=${() => saveSettings({ progression: 'double' })}>Double progression</button>
        </div>
        <span class="tiny muted" style="line-height: 1.4">Exercises set to Double progression use their range and their own weights. The others work as in Classic. A workout already open keeps its mode.</span>
      </div>

      <span class="section-label">Exercises</span>
      <button class="card row" style="text-align: left; width: 100%" onClick=${() => go({ name: 'exercises' })}>
        <span style="display: flex; flex-direction: column; gap: 2px"><span>Exercises</span>
          <span class="tiny muted">${d.exercises.filter((e) => !e.archived).length} in the catalog · sets, reps, progression, weight</span></span>
        <span class="muted"><${Icon} name="next" size=${20} /></span>
      </button>

      <span class="section-label">You</span>
      <div class="card card-pad" style="gap: 8px">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
          <span>Body weight</span>
          <span style="display: flex; align-items: center; gap: 6px" class="small muted"><${BodyWeightInput} value=${s.bodyWeight} /> kg</span>
        </div>
        <span class="tiny muted" style="line-height: 1.4">Used for Dips and Pull-ups in volume and total lifted. Each workout keeps the value of the day it starts.</span>
      </div>

      <span class="section-label">Weight steps (+/−)</span>
      <div class="card card-pad" style="gap: 14px">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
          <span>Machines & barbell</span>
          <span style="display: flex; align-items: center; gap: 6px" class="small muted"><${NumberSetting} label="Machine step in kg" value=${s.stepMachine} onSave=${(v) => saveSettings({ stepMachine: v })} width=${72} /> kg</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px">
          <span>Dumbbells</span>
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap" class="small muted">
            <${NumberSetting} label="Dumbbell small step in kg" value=${s.stepDbSmall} onSave=${(v) => saveSettings({ stepDbSmall: v })} /> kg up to
            <${NumberSetting} label="Dumbbell threshold in kg" value=${s.dbThreshold} onSave=${(v) => saveSettings({ dbThreshold: v })} /> kg, then
            <${NumberSetting} label="Dumbbell large step in kg" value=${s.stepDbLarge} onSave=${(v) => saveSettings({ stepDbLarge: v })} /> kg
          </div>
        </div>
        <span class="tiny muted">Each exercise is set to Machine / barbell or Dumbbells in Exercises. Tap a weight during a workout to type any value.</span>
      </div>

      <span class="section-label">Workout and Today</span>
      <div class="card">
        ${toggles.map(([key, label, hint]) => html`<div key=${key} class="row">
          <span style="display: flex; flex-direction: column; gap: 2px"><span>${label}</span><span class="tiny muted">${hint}</span></span>
          <button class=${'switch' + (s[key] ? ' on' : '')} role="switch" aria-checked=${!!s[key]} aria-label=${label} onClick=${() => saveSettings({ [key]: !s[key] })}><span></span></button>
        </div>`)}
      </div>

      <span class="section-label">Rotation</span>
      <div class="card card-pad" style="gap: 10px">
        <span style="font-size: 15px; font-weight: 500">Next workout</span>
        <div class="seg" role="radiogroup" aria-label="Next workout" style="background: var(--bg)">
          ${plans.map((p) => html`<button key=${p.id} role="radio" aria-checked=${p.id === next} class=${p.id === next ? 'on' : ''} onClick=${() => saveSettings({ nextPlanId: p.id })}>${planName(p)}</button>`)}
        </div>
        <span class="tiny muted">Switches automatically after each workout. Change it here only to break the rotation.</span>
      </div>

      <span class="section-label">Data</span>
      <div class="card card-pad" style="gap: 10px">
        <p class="small" style="line-height: 1.45; color: var(--text-2)">Plans and logs are stored on this iPhone only. Export a backup now and then, for example to iCloud Drive.</p>
        <span class="small muted">Last backup: ${s.lastBackup ? fmtDate(s.lastBackup, true) : 'never'} · ${d.sessions.filter((x) => x.finishedAt).length} workouts logged</span>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
          <button class="btn btn-primary" onClick=${exportBackup}>Export backup</button>
          <${ImportButton} label="Import backup" cls="btn" />
        </div>
      </div>
      <p class="tiny muted" style="text-align: center; margin-top: 12px">Lift Happens ${VERSION}</p>
    </div>
    <${Nav} active="settings" />
  </div>`;
}

// ======================================================================
// App root
// ======================================================================

function App() {
  const d = useStore();
  if (d.loadError) {
    return html`<div class="boot-error">
      <h1>Could not open your data</h1>
      <p>Your plans and workouts are still on this iPhone. This is usually temporary: try again.</p>
      <button class="btn btn-primary btn-big" onClick=${() => location.reload()}>Try again</button>
      <pre>${d.loadError}</pre>
    </div>`;
  }
  if (!d.loaded) return html`<div class="boot"><img src="icons/face.png" width="120" alt="" /><span>Lift Happens</span></div>`;
  let screen;
  if (!d.plans.length) screen = html`<${Welcome} />`;
  else {
    const r = d.route;
    if (r.name === 'workout') screen = html`<${Workout} key=${r.id} id=${r.id} />`;
    else if (r.name === 'summary') screen = html`<${Summary} id=${r.id} edited=${!!r.edited} auto=${!!r.auto} />`;
    else if (r.name === 'plans') screen = html`<${Plans} />`;
    else if (r.name === 'progress') screen = html`<${Progress} />`;
    else if (r.name === 'session') screen = html`<${SessionDetail} key=${r.id} id=${r.id} from=${r.from} />`;
    else if (r.name === 'settings') screen = html`<${Settings} />`;
    else if (r.name === 'exercises') screen = html`<${Exercises} />`;
    else screen = html`<${Home} />`;
  }
  return html`${screen}${d.toast ? html`<div class="toast" role="status">
    <span>${d.toast.msg}</span>
    ${d.toast.action ? html`<button class="toast-action" onClick=${() => { setState({ toast: null }); d.toast.action.run(); }}>${d.toast.action.label}</button>` : null}
  </div>` : null}`;
}

async function boot() {
  window.__liftStarted = true;
  render(html`<${App} />`, document.getElementById('app'));
  try {
    const data = await db.loadAll();
    const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    // Up to 1.5.7, "Edit" reopened a finished workout (finishedAt cleared, kept in firstFinishedAt).
    // Editing no longer reopens: give such workouts back their original finish time.
    for (let i = 0; i < data.sessions.length; i++) {
      const s = data.sessions[i];
      if (!s.finishedAt && s.firstFinishedAt) {
        const fixed = { ...s, finishedAt: s.firstFinishedAt };
        delete fixed.firstFinishedAt;
        data.sessions[i] = fixed;
        try { await db.put('sessions', fixed); } catch (err) { console.warn('Could not save the fixed workout', err); }
      }
    }
    const open = data.sessions.find((s) => !s.finishedAt);
    const set = data.plans.length || data.exercises.length ? await upgradeData(data.exercises, data.plans, settings) : { exercises: data.exercises, plans: data.plans, settings };
    setState({
      loaded: true,
      exercises: set.exercises,
      plans: set.plans,
      sessions: data.sessions,
      settings: set.settings,
      // Reopen a workout left open (e.g. after the app was closed mid-session).
      route: open ? { name: 'workout', id: open.id } : { name: 'home' }
    });
    ensureDailyQuote();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.loaded) ensureDailyQuote();
    });
    db.requestPersistence();
  } catch (err) {
    console.error(err);
    // Never fall through to the empty Welcome screen: that could lead to overwriting real data.
    setState({ loadError: String(err && err.message ? err.message : err) });
  }
  window.__liftReady = true;
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

boot();
