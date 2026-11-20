import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js';
import * as db from './db.js';
import {
  DEFAULT_SETTINGS, uid, round2, fmtNum, fmtWeight, parseNum, increase, decrease,
  createSession, startingSets, setsFromHistory, hasEmptyWeight, activePlans, nextPlanAfter,
  plannedPlanId, sessionSummary, exerciseHistory, personalRecord, schemeText, setsText,
  validateImport, buildExport, pickDailyQuote, localDayKey,
  pendingReminder, applyScheme, currentScheme, SCHEMES, schemeLabel, hasReminder, nextPlanAfterDelete, mergeExercisesFile, schemeChange
} from './logic.js';
import { QUOTES } from './quotes.js';
import { exerciseIconSrc } from './exercise-icons.js';

const VERSION = '1.7.0';

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
  progressTab: 'workouts',
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
function toast(msg) {
  clearTimeout(toastTimer);
  setState({ toast: msg });
  toastTimer = setTimeout(() => setState({ toast: null }), 2800);
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
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  next: 'M9 6l6 6-6 6',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3'
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

// Exercise picker with "create new" field; used by Workout (swap/add) and Plans (add/replace).
function ExercisePicker({ title, sub, exclude, onPick, onClose, showLast }) {
  const [name, setName] = useState('');
  const list = state.exercises.filter((e) => !e.archived && !exclude.has(e.id)).sort((a, b) => a.name.localeCompare(b.name));
  const create = () => {
    const n = name.trim();
    if (!n) return;
    const ex = { id: uid(), name: n, equipment: 'machine', setup: '', notes: '', archived: false };
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
      return html`<button key=${e.id} class="sheet-item" onClick=${() => onPick(e.id)}>
        <span>${e.name}</span><span class="small muted num">${last}</span>
      </button>`;
    }) : html`<p class="small muted" style="padding: 10px">No other exercises in the catalog yet. Create one above.</p>`}
  <//>`;
}

function lastWeightText(exId) {
  const h = exerciseHistory(state.sessions, exId);
  if (!h.length) {
    const ex = state.exercises.find((e) => e.id === exId);
    return ex && ex.startWeight !== null && ex.startWeight !== undefined ? 'start ' + fmtWeight(ex.startWeight) : '';
  }
  const last = h[h.length - 1];
  return last.top === 0 ? 'bodyweight' : 'last ' + fmtNum(last.top) + ' kg';
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
    setState({ exercises: data.exercises, plans: data.plans, sessions: data.sessions, settings: data.settings, route: { name: 'home' } });
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
  const name = 'lift-happens-backup-' + now.toISOString().slice(0, 10) + '.json';
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
    saveSettings({ lastBackup: now.toISOString() });
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
  const exById = exMap();
  const finished = d.sessions.filter((s) => s.finishedAt).sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  const last = finished[0];
  const lastPlan = last ? d.plans.find((p) => p.id === last.planId) : null;
  const afterToday = plan ? plans.find((p) => p.id === nextPlanAfter(d.plans, plan.id)) : null;

  const start = () => {
    if (!plan) return;
    if (!plan.items.length) { toast('This plan has no exercises yet. Add some in Plans.'); return; }
    const s = createSession(plan, d.sessions, new Date(), exMap());
    saveSession(s);
    go({ name: 'workout', id: s.id });
  };
  const discard = () => {
    if (window.confirm('Discard the workout in progress? Its log will be deleted.')) removeSession(open);
  };

  const names = plan ? plan.items.map((it) => (exById[it.exerciseId] || {}).name).filter(Boolean) : [];
  const preview = names.slice(0, 4).join(' · ') + (names.length > 4 ? ' + ' + (names.length - 4) + ' more' : '');

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
    <div class="main" style="gap: 16px; padding-top: 16px">
      ${open ? html`<section class="card card-pad card-live" style="gap: 12px">
        <span class="section-label live-label" style="margin: 0"><span class="live-dot" aria-hidden="true"></span>In progress</span>
        <h2 style="font-size: 28px; font-weight: 700">${planName(d.plans.find((p) => p.id === open.planId))}</h2>
        <p class="small muted">Started ${fmtDate(open.startedAt, true)} · ${open.entries.filter((e) => e.status !== 'open').length} of ${open.entries.length} exercises handled</p>
        <button class="btn btn-go btn-big" onClick=${() => go({ name: 'workout', id: open.id })}>Resume workout</button>
        <button class="btn btn-ghost btn-danger-text" onClick=${discard}>Discard this workout</button>
      </section>` : html`<section class="card card-pad" style="padding: 20px; gap: 14px">
        <span class="section-label" style="margin: 0">Today</span>
        <div>
          <h2 style="font-size: 40px; font-weight: 700; line-height: 1">${planName(plan)}</h2>
          <p class="muted" style="margin-top: 6px">${plan ? plan.items.length + ' exercises' : 'No plan'}</p>
        </div>
        ${preview ? html`<p class="small" style="line-height: 1.5; color: var(--text-2)">${preview}</p>` : null}
        <button class="btn btn-primary btn-big" style="min-height: 56px; font-size: 17px" onClick=${start}>Start workout</button>
        ${plans.filter((p) => p.id !== todayId).map((p) => html`<button key=${p.id} class="btn btn-ghost" onClick=${() => setOverride(p.id)}>Do ${planName(p)} instead</button>`)}
      </section>`}
      <section style="display: flex; flex-direction: column; gap: 8px">
        <span class="section-label">Rotation</span>
        <div style="display: flex; gap: 8px">
          ${last ? html`<button class="card card-pad tile-link" style="flex: 1; padding: 14px; gap: 4px; text-align: left" aria-label=${'Last workout: ' + planName(lastPlan) + ', ' + fmtDate(last.finishedAt, true) + '. Open its log'}
              onClick=${() => go({ name: 'session', id: last.id, from: 'home' })}>
              <span class="small muted" style="display: flex; justify-content: space-between; align-items: center; width: 100%">Last workout <${Icon} name="next" size=${16} /></span>
              <span style="font-size: 17px; font-weight: 600">${planName(lastPlan)}</span>
              <span class="tiny muted">${fmtDate(last.finishedAt, true)}</span>
            </button>` : html`<div class="card card-pad" style="flex: 1; padding: 14px; gap: 4px">
              <span class="small muted">Last workout</span>
              <span style="font-size: 17px; font-weight: 600">—</span>
            </div>`}
          <div class="card card-pad" style="flex: 1; padding: 14px; gap: 4px">
            <span class="small muted">After this one</span>
            <span style="font-size: 17px; font-weight: 600">${afterToday ? planName(afterToday) : '—'}</span>
          </div>
        </div>
      </section>
    </div>
    <${Nav} active="home" />
  </div>`;
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
  const [noteOpen, setNoteOpen] = useState({});
  const [menu, setMenu] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [drag, setDrag] = useState(null);
  const [planAsk, setPlanAsk] = useState(null);
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
    // Different sets or reps than the plan: offer to update the plan (asked again only if they change again).
    const curPlan = state.plans.find((p) => p.id === getSession(id).planId);
    const item = curPlan ? curPlan.items.find((it) => it.id === e.planItemId) : null;
    const ch = schemeChange(e, item);
    if (ch && e.planAsked !== schemeLabel(ch.to)) {
      setPlanAsk({ entryId: eid, itemId: item.id, name: (exById[e.exerciseId] || {}).name || 'Exercise', planLabel: planName(curPlan), ...ch });
    }
  };

  const answerPlan = (update) => {
    const a = planAsk;
    setPlanAsk(null);
    if (!a) return;
    const label = schemeLabel(a.to);
    patchEntry(a.entryId, (x) => (update ? { ...x, plannedSets: a.to.sets, appliedScheme: label, planAsked: label } : { ...x, planAsked: label }));
    if (!update) return;
    const cur = state.plans.find((p) => p.id === getSession(id).planId);
    if (!cur) return;
    savePlan({ ...cur, items: cur.items.map((it) => (it.id === a.itemId ? { ...it, sets: a.to.sets, reps: a.to.reps } : it)) });
    toast(planName(cur) + ' updated: ' + a.name + ' is now ' + label + '.');
  };

  const skip = (e) => {
    clearEdit();
    if (e.kind === 'added') {
      patchEntries((list) => list.filter((x) => x.id !== e.id));
      setOpenId(null);
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
  };

  const planItemOf = (e) => (plan ? plan.items.find((it) => it.id === e.planItemId) : null);

  const pickSwap = (entryId, exId) => {
    setSheet(null);
    patchEntry(entryId, (e) => {
      const item = planItemOf(e);
      const count = item ? item.sets : e.sets.length;
      const reps = item ? item.reps : e.sets[0].reps;
      return {
        ...e, kind: 'swapped', status: 'open', doneAt: null,
        replacesExerciseId: e.kind === 'swapped' ? e.replacesExerciseId : e.exerciseId,
        exerciseId: exId, plannedSets: count, appliedScheme: null,
        sets: setsFromHistory(exId, count, reps, state.sessions, { ...opts, fallbackWeight: (exById[exId] || {}).startWeight })
      };
    });
    setOpenId(entryId);
  };

  const undoSwap = (e) => {
    const item = planItemOf(e);
    patchEntry(e.id, (x) => ({
      ...x, kind: 'planned', exerciseId: x.replacesExerciseId, replacesExerciseId: null, status: 'open', doneAt: null,
      plannedSets: item ? item.sets : x.plannedSets, appliedScheme: null,
      sets: item
        ? startingSets(item, state.sessions, { ...opts, fallbackWeight: (exById[x.replacesExerciseId] || {}).startWeight })
        : setsFromHistory(x.replacesExerciseId, x.sets.length, x.sets[0].reps, state.sessions, { ...opts, fallbackWeight: (exById[x.replacesExerciseId] || {}).startWeight })
    }));
  };

  const pickAdd = (exId) => {
    setSheet(null);
    const newId = uid();
    patchEntries((list) => {
      const order = list.reduce((m, x) => Math.max(m, x.order), -1) + 1;
      return [...list, {
        id: newId, order, exerciseId: exId, planItemId: null, kind: 'added', replacesExerciseId: null,
        status: 'open', doneAt: null, plannedSets: null, reminder: null, sets: setsFromHistory(exId, 3, 8, state.sessions, { ...opts, fallbackWeight: (exById[exId] || {}).startWeight })
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
    if (Number.isNaN(v) || v < 0) return;
    patchSet(ed.entryId, ed.i, ed.f === 'w' ? { weight: round2(v) } : { reps: Math.round(v) });
  };

  const finalize = (skipOpen) => {
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
    go({ name: 'summary', id });
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
  const applyRem = (e, sc) => {
    const item = planItemOf(e);
    const toPlan = e.kind === 'planned' && item && plan;
    patchEntry(e.id, (x) => ({ ...x, sets: applyScheme(x.sets, sc), plannedSets: sc.sets, appliedScheme: schemeLabel(sc) }));
    if (toPlan) {
      const cur = state.plans.find((p) => p.id === plan.id);
      savePlan({ ...cur, items: cur.items.map((it) => (it.id === item.id ? { ...it, sets: sc.sets, reps: sc.reps } : it)) });
      toast(planName(plan) + ' updated: ' + (exById[e.exerciseId] || {}).name + ' is now ' + schemeLabel(sc) + '.');
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
    const item = planItemOf(e);
    const incoming = e.status === 'open' ? pendingReminder(d.sessions, e.exerciseId, id) : null;
    const inRem = incoming ? incoming.reminder : null;
    const outRem = hasReminder(e.reminder) ? e.reminder : null;
    const planned = e.plannedSets ?? (item ? item.sets : null);
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
    const open = openId === e.id;
    const isDone = e.status === 'done';
    const isSkipped = e.status === 'skipped';
    const canSwipe = e.status === 'open' && !open;
    const dx = drag && drag.id === e.id ? drag.dx : 0;
    const ws = e.sets.map((x) => x.weight);
    const known = ws.filter((w) => w !== null && w !== undefined);
    const lo = known.length ? Math.min.apply(null, known) : null;
    const hi = known.length ? Math.max.apply(null, known) : null;
    const wTxt = known.length < ws.length ? 'weight to enter' : hi === 0 ? 'bodyweight' : lo === hi ? fmtNum(lo) + ' kg' : fmtNum(lo) + '–' + fmtNum(hi) + ' kg';
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
            <span class="small muted num">${e.sets.length} × ${rTxt} · ${wTxt}</span>
            ${tags.length ? html`<span class="ex-tag">${tags.join(' · ')}</span>` : null}
            ${inChips.length ? html`<span class="rem-chips">${inChips.map((c) => html`<span key=${c} class="rem-chip"><${Icon} name="bell" size=${12} sw=${2.4} />${c}</span>`)}</span>` : null}
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
          ${inRem ? html`<div class="rem-box">
            <span class="rem-label">Reminder from ${fmtDate(incoming.session.startedAt)}</span>
            ${inRem.dir === 'up' ? html`<strong>↑ Increase the weight</strong>` : null}
            ${inRem.dir === 'down' ? html`<strong>↓ Decrease the weight</strong>` : null}
            ${inRem.scheme ? html`<div class="rem-row">
              <strong>Switch to ${schemeLabel(inRem.scheme)}</strong>
              ${e.appliedScheme === schemeLabel(inRem.scheme)
                ? html`<span class="small" style="color: #8AB8FF">${e.kind === 'planned' && item ? 'Plan updated ✓' : 'Applied today ✓'}</span>`
                : nowScheme && nowScheme.sets === inRem.scheme.sets && nowScheme.reps === inRem.scheme.reps
                  ? html`<span class="small muted">Already ${schemeLabel(inRem.scheme)}</span>`
                  : html`<button class="btn btn-primary" onClick=${() => applyRem(e, inRem.scheme)}>${e.kind === 'planned' && item ? 'Apply' : 'Apply today'}</button>`}
            </div>` : null}
            ${inRem.scheme && e.appliedScheme !== schemeLabel(inRem.scheme) && e.kind === 'planned' && item ? html`<span class="tiny muted">Apply changes today’s sets and ${planName(plan)} from now on.</span>` : null}
            ${inRem.note && inRem.note.trim() ? html`<em style="color: var(--text-2)">“${inRem.note.trim()}”</em>` : null}
            <span class="tiny muted">Cleared when you tap Done.</span>
          </div>` : null}
          <div class="set-grid"><span></span><span class="col-label">KG</span><span class="col-label">REPS</span><span></span></div>
          ${e.sets.map((s, i) => {
            const editW = edit && edit.entryId === e.id && edit.i === i && edit.f === 'w';
            const editR = edit && edit.entryId === e.id && edit.i === i && edit.f === 'r';
            const empty = s.weight === null || s.weight === undefined;
            return html`<div key=${i} class="set-grid">
              <span class="set-num">${i + 1}</span>
              <div class=${'stepper' + (empty ? ' empty' : '')}>
                <button class="icon-btn" aria-label=${'Decrease weight, set ' + (i + 1)} onClick=${() => patchSet(e.id, i, { weight: decrease(ex.equipment, latestEntry(e.id).sets[i].weight, settings) })}><${Icon} name="minus" size=${18} sw=${2.2} /></button>
                <input class="step-field" inputmode="decimal" enterkeyhint="done" autocomplete="off" aria-label=${'Weight in kg, set ' + (i + 1)} placeholder="enter"
                  value=${editW ? edit.draft : (empty ? '' : fmtNum(s.weight))}
                  onFocus=${(ev) => startEdit(ev, e.id, i, 'w', empty ? '' : fmtNum(s.weight))}
                  onInput=${onEditInput} onBlur=${commitEdit} onKeyDown=${onEditKey} />
                <button class="icon-btn" aria-label=${'Increase weight, set ' + (i + 1)} onClick=${() => patchSet(e.id, i, { weight: increase(ex.equipment, latestEntry(e.id).sets[i].weight, settings) })}><${Icon} name="plus" size=${18} sw=${2.2} /></button>
              </div>
              <div class="stepper">
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
            <span class="tiny muted">Change scheme</span>
            <div class="grid-4">
              ${SCHEMES.map((sc) => {
                const label = schemeLabel(sc);
                const isCurrent = nowScheme && nowScheme.sets === sc.sets && nowScheme.reps === sc.reps;
                const on = myRem.scheme && myRem.scheme.sets === sc.sets && myRem.scheme.reps === sc.reps;
                return html`<button key=${label} class=${'chip-btn' + (on ? ' on' : '') + (isCurrent ? ' current' : '')} disabled=${!!isCurrent} aria-pressed=${!!on}
                  aria-label=${isCurrent ? label + ', current scheme' : label} onClick=${() => setReminder(e.id, { scheme: on ? null : sc })}>${label}</button>`;
              })}
            </div>
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
          <span class="small muted">${fmtDate(session.startedAt, true)}${editing ? ' · ' + hhmm(session.startedAt) : ''}</span>
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

    ${planAsk ? html`<div class="overlay center">
      <div class="dialog" role="alertdialog" aria-labelledby="plan-ask-title">
        <h2 id="plan-ask-title">Update ${planAsk.planLabel}?</h2>
        <p style="line-height: 1.45"><strong>${planAsk.name}</strong>: plan ${schemeLabel(planAsk.from)} → this workout ${schemeLabel(planAsk.to)}.</p>
        <p class="small muted" style="line-height: 1.45">Update plan: ${planAsk.planLabel} uses ${schemeLabel(planAsk.to)} from the next time. Only this workout: the plan stays ${schemeLabel(planAsk.from)}.</p>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px">
          <button class="btn btn-primary btn-big" autofocus onClick=${() => answerPlan(true)}>Update plan</button>
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
  const maxAbs = Math.max(0, ...sum.rows.filter((r) => r.delta !== null && !r.bodyweight).map((r) => Math.abs(r.delta)));
  const volPct = sum.volPct === null ? '—' : (sum.volPct > 0 ? '+' : sum.volPct < 0 ? '−' : '±') + Math.abs(sum.volPct).toFixed(1) + '%';
  const kg = (v) => Math.round(v).toLocaleString('en') + ' kg';
  const here = live ? 'today' : 'this workout';
  let volTitle = 'Total volume vs last ' + planName(plan);
  let volText;
  if (sum.volBase === 'previous' && sum.volLast > 0) {
    volText = 'Last ' + planName(plan) + ' (' + fmtDate(sum.volPrev.startedAt, true) + '): ' + kg(sum.volLast) + ' · ' + here + ': ' + kg(sum.volToday) + ' (weight × reps, exercises done both times)';
  } else if (sum.volBase === 'previous') {
    volText = 'No exercises in common with the last ' + planName(plan) + ' (' + fmtDate(sum.volPrev.startedAt, true) + ').';
  } else if (sum.volBase === 'plan') {
    volTitle = 'Total volume vs plan';
    volText = 'First ' + planName(plan) + ': compared with the plan’s starting weights. Plan: ' + kg(sum.volLast) + ' · ' + here + ': ' + kg(sum.volToday) + ' (weight × reps)';
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
          <h2 style="font-size: 15px; font-weight: 600">Top-set weight vs last time</h2>
          <div class="legend"><span><i style="background: var(--up)"></i>Heavier</span><span><i style="background: var(--down)"></i>Lighter</span></div>
        </div>
        <span class="small muted">${sum.heavier} heavier · ${sum.lighter} lighter · ${sum.same} same${sum.records ? ' · ' + sum.records + (sum.records === 1 ? ' new record' : ' new records') : ''}</span>
        <div>
          ${sum.rows.length ? sum.rows.map((r) => {
            let detail, delta, bw = 0, dir = null;
            if (r.delta === null) { detail = r.bodyweight ? r.totalReps + ' reps' : fmtNum(r.top) + ' kg · first time'; delta = 'new'; }
            else if (r.bodyweight) { detail = 'reps ' + r.prevReps + ' → ' + r.totalReps; delta = r.delta > 0 ? '+' + r.delta + ' reps' : r.delta < 0 ? '−' + (-r.delta) + ' reps' : 'same'; }
            else {
              detail = (r.delta !== 0 ? fmtNum(r.prevTop) + ' → ' + fmtNum(r.top) + ' kg' : fmtNum(r.top) + ' kg') + (r.vsPlan ? ' · vs plan' : '');
              delta = r.delta > 0 ? '+' + fmtNum(r.delta) + ' kg' : r.delta < 0 ? '−' + fmtNum(-r.delta) + ' kg' : 'same';
              if (r.delta !== 0 && maxAbs > 0) { bw = Math.max(4, Math.round((Math.abs(r.delta) / maxAbs) * 50)); dir = r.delta > 0 ? 'up' : 'down'; }
            }
            const rec = r.record ? (r.record.kind === 'weight'
              ? 'New record! ' + fmtNum(r.record.value) + ' kg × ' + r.record.reps + ', set ' + (r.record.setIndex + 1) + ' of ' + r.record.setCount + ' (best was ' + fmtNum(r.record.previous) + ' kg)'
              : 'New record! ' + r.record.value + ' reps (best was ' + r.record.previous + ')') : null;
            return html`<div key=${r.entryId} class="sum-row">
              <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0">
                <span style="font-size: 14px; font-weight: 500">${r.name}</span>
                <span class="tiny muted num">${detail}</span>
                ${rec ? html`<span class="record"><${Icon} name="trophy" size=${12} sw=${2.4} />${rec}</span>` : null}
              </div>
              <div class="dbar" aria-hidden="true"><div class="zero"></div>${dir ? html`<div class=${dir} style=${'width:' + bw + '%'}></div>` : null}</div>
              <span class="small num" style="text-align: right; font-weight: 600">${delta}</span>
            </div>`;
          }) : html`<p class="small muted">No exercises were confirmed.</p>`}
        </div>
      </section>`;
}

function Summary({ id, edited }) {
  const d = useStore();
  const session = d.sessions.find((s) => s.id === id);
  useEffect(() => { if (!session) go({ name: 'home' }); }, [session]);
  if (!session) return null;
  const plan = d.plans.find((p) => p.id === session.planId);
  const next = d.plans.find((p) => p.id === d.settings.nextPlanId);
  const sum = sessionSummary(session, d.sessions, exMap(), plan);
  const reopen = () => go({ name: 'workout', id });

  return html`<div class="screen">
    <div class="main" style="padding: calc(var(--safe-top) + var(--top-gap)) 20px calc(var(--safe-bottom) + 24px); gap: 18px">
      <${AppFace} size=${140} wink=${true} style="align-self: center" />
      <div style="display: flex; align-items: center; gap: 12px">
        <span class="check-badge" style="width: 44px; height: 44px; border-radius: 22px"><${Icon} name="check" size=${24} sw=${3} /></span>
        <div style="display: flex; flex-direction: column; gap: 2px">
          <h1 style="font-size: 24px; font-weight: 700">${planName(plan)} saved</h1>
          <span class="small muted">${sum.setsLogged} sets logged · ${sum.skipped} skipped · next up: ${planName(next)}</span>
          <span class="small muted">Saved automatically. You can close the app.</span>
        </div>
      </div>

      <${SummaryCards} sum=${sum} plan=${plan} live=${true} />

      ${edited ? null : html`<p class="small muted" style="line-height: 1.5">Today’s weights are the starting point next time you do these exercises, in any workout. Sets and reps still come from the plan.</p>`}
      <button class="btn btn-primary btn-big" onClick=${() => go({ name: 'home' })}><${Icon} name="home" /> Back to Home</button>
      <button class="btn btn-ghost" onClick=${reopen}>Edit this workout</button>
    </div>
  </div>`;
}

// ======================================================================
// Plans
// ======================================================================

function Plans() {
  const d = useStore();
  const plans = activePlans(d.plans);
  const [tabId, setTabId] = useState(() => plannedPlanId(d.plans, d.settings));
  const [draft, setDraft] = useState(null);
  const [openItem, setOpenItem] = useState(null);
  const [sheet, setSheet] = useState(null);
  const exById = exMap();
  const saved = plans.find((p) => p.id === tabId) || plans[0];
  if (!saved) return html`<div class="screen"><div class="main"><p class="muted">No plans.</p></div><${Nav} active="plans" /></div>`;
  const plan = draft ? draft.plan : saved;
  const exOf = (eid) => (draft && draft.exercises[eid]) || exById[eid] || { id: eid, name: 'Unknown', equipment: 'machine', setup: '' };

  const base = () => draft || { plan: JSON.parse(JSON.stringify(saved)), exercises: {} };
  const editPlan = (fn) => { const b = base(); setDraft({ ...b, plan: fn(b.plan) }); };
  const editItem = (itemId, patch) => editPlan((p) => ({ ...p, items: p.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }));
  const editEx = (eid, patch) => { const b = base(); setDraft({ ...b, exercises: { ...b.exercises, [eid]: { ...exOf(eid), ...patch } } }); };

  const switchTab = (pid) => {
    if (pid === tabId) return;
    if (draft && !window.confirm('Discard unsaved changes to ' + planName(saved) + '?')) return;
    setDraft(null); setOpenItem(null); setTabId(pid);
  };

  const save = async () => {
    if (!draft) return;
    const now = new Date().toISOString();
    const items = draft.plan.items.map((it) => {
      const old = saved.items.find((o) => o.id === it.id);
      const sets = Math.max(1, parseInt(it.sets, 10) || (old ? old.sets : 3));
      const reps = Math.max(1, parseInt(it.reps, 10) || (old ? old.reps : 8));
      const wNum = parseNum(it.weight);
      const weight = it.weight === '' || it.weight === null || it.weight === undefined || Number.isNaN(wNum) ? null : round2(wNum);
      const changed = !old || old.weight !== weight || old.exerciseId !== it.exerciseId;
      return { id: it.id, exerciseId: it.exerciseId, sets, reps, weight, weightEditedAt: changed && weight !== null ? now : (old ? old.weightEditedAt : null) };
    });
    for (const ex of Object.values(draft.exercises)) {
      await saveExercise({ ...ex, name: (ex.name || '').trim() || exById[ex.id].name });
    }
    await savePlan({ ...draft.plan, items });
    setDraft(null);
    toast(planName(saved) + ' saved. It applies from the next workout.');
  };

  const move = (i, dir) => editPlan((p) => {
    const items = p.items.slice();
    const j = i + dir;
    if (j < 0 || j >= items.length) return p;
    const t = items[i]; items[i] = items[j]; items[j] = t;
    return { ...p, items };
  });

  const inPlan = new Set(plan.items.map((it) => it.exerciseId));
  const pick = (exId) => {
    const sh = sheet;
    setSheet(null);
    if (sh.mode === 'replace') editItem(sh.itemId, { exerciseId: exId, weight: '' });
    else {
      const newId = uid();
      editPlan((p) => ({ ...p, items: [...p.items, { id: newId, exerciseId: exId, sets: '3', reps: '8', weight: '' }] }));
      setOpenItem(newId);
    }
  };

  return html`<div class="screen">
    <div class="header">
      <div class="header-row">
        <h1 class="title">Plans</h1>
        ${draft ? html`<div style="display: flex; gap: 6px">
          <button class="btn btn-ghost" onClick=${() => { setDraft(null); setOpenItem(null); }}>Discard</button>
          <button class="btn btn-primary" onClick=${save}>Save</button>
        </div>` : html`<span class="small muted">All changes saved</span>`}
      </div>
      <div class="seg" role="tablist" aria-label="Plan">
        ${plans.map((p) => html`<button key=${p.id} role="tab" aria-selected=${p.id === saved.id} class=${p.id === saved.id ? 'on' : ''} onClick=${() => switchTab(p.id)}>${planName(p)}</button>`)}
      </div>
      <p class="small muted" style="line-height: 1.45">The plan sets exercises, order, sets and reps. Weight is optional: leave it empty to enter it at the gym.</p>
    </div>
    <div class="main">
      ${plan.items.length ? null : html`<${EmptyState}><p class="muted">No exercises in ${planName(plan)} yet. Add the first one below.</p></${EmptyState}>`}
      ${plan.items.map((it, i) => {
        const ex = exOf(it.exerciseId);
        const open = openItem === it.id;
        const wNum = parseNum(it.weight);
        const wTxt = it.weight === '' || it.weight === null || it.weight === undefined || Number.isNaN(wNum) ? '—' : fmtWeight(wNum);
        return html`<div key=${it.id} class=${'card' + (open ? ' ex-card open' : '')}>
          <button class="ex-head" style="min-height: 56px" aria-expanded=${open} onClick=${() => setOpenItem(open ? null : it.id)}>
            <span class="small muted num" style="width: 18px; align-self: flex-start; padding-top: 2px">${i + 1}</span>
            <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
              <span style="font-size: 16px; font-weight: 600; line-height: 1.25">${ex.name}</span>
              <span class="small num" style="color: var(--text-2)">${(it.sets || '?') + ' × ' + (it.reps || '?') + (wTxt === '—' ? '' : ' · ' + wTxt)}</span>
            </span>
            <${ExIcon} id=${ex.id} />
          </button>
          ${open ? html`<div style="padding: 12px 12px 14px; display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--line)">
            <label class="field">Exercise name (renames it everywhere)
              <input class="input" value=${ex.name} onInput=${(e) => editEx(ex.id, { name: e.target.value })} />
            </label>
            <div class="grid-3">
              <label class="field">Sets<input class="input" inputmode="numeric" value=${it.sets} onInput=${(e) => editItem(it.id, { sets: e.target.value.replace(/[^0-9]/g, '') })} /></label>
              <label class="field">Reps<input class="input" inputmode="numeric" value=${it.reps} onInput=${(e) => editItem(it.id, { reps: e.target.value.replace(/[^0-9]/g, '') })} /></label>
              <label class="field">Weight kg<input class="input" inputmode="decimal" placeholder="optional" value=${it.weight === null || it.weight === undefined ? '' : it.weight} onInput=${(e) => editItem(it.id, { weight: e.target.value.replace(/[^0-9.,]/g, '') })} /></label>
            </div>
            <div class="field">Equipment
              <div class="seg" role="radiogroup" aria-label="Equipment">
                <button role="radio" aria-checked=${ex.equipment !== 'dumbbell'} class=${ex.equipment !== 'dumbbell' ? 'on' : ''} onClick=${() => editEx(ex.id, { equipment: 'machine' })}>Machine / barbell</button>
                <button role="radio" aria-checked=${ex.equipment === 'dumbbell'} class=${ex.equipment === 'dumbbell' ? 'on' : ''} onClick=${() => editEx(ex.id, { equipment: 'dumbbell' })}>Dumbbells</button>
              </div>
              <span class="tiny muted" style="font-weight: 400">${ex.equipment === 'dumbbell'
                ? '+/− steps: ' + fmtNum(d.settings.stepDbSmall) + ' kg up to ' + fmtNum(d.settings.dbThreshold) + ' kg, then ' + fmtNum(d.settings.stepDbLarge) + ' kg'
                : '+/− steps: ' + fmtNum(d.settings.stepMachine) + ' kg'}</span>
            </div>
            <label class="field">Machine setup (shown with an extra tap)
              <input class="input" placeholder="e.g. seat 4, pad XL" value=${ex.setup || ''} onInput=${(e) => editEx(ex.id, { setup: e.target.value })} />
            </label>
            <div class="btn-row">
              <button class="icon-btn" style="background: var(--card-2)" aria-label=${'Move ' + ex.name + ' up'} onClick=${() => move(i, -1)}><${Icon} name="up" size=${18} sw=${2.2} /></button>
              <button class="icon-btn" style="background: var(--card-2)" aria-label=${'Move ' + ex.name + ' down'} onClick=${() => move(i, 1)}><${Icon} name="down" size=${18} sw=${2.2} /></button>
              <button class="btn" onClick=${() => setSheet({ mode: 'replace', itemId: it.id, from: ex.name })}>Replace</button>
              <button class="btn btn-warn" onClick=${() => { editPlan((p) => ({ ...p, items: p.items.filter((x) => x.id !== it.id) })); setOpenItem(null); }}>Remove</button>
            </div>
          </div>` : null}
        </div>`;
      })}
      <button class="btn-dashed" style="margin-top: 6px" onClick=${() => setSheet({ mode: 'add' })}><${Icon} name="plus" size=${18} sw=${2.2} /> Add exercise to ${planName(plan)}</button>
      ${draft ? html`<p class="tiny muted" style="text-align: center; margin-top: 6px">Unsaved changes. Tap Save at the top.</p>` : null}
    </div>
    ${sheet ? html`<${ExercisePicker} title=${sheet.mode === 'replace' ? 'Replace ' + sheet.from + ' with…' : 'Add to ' + planName(plan)}
      sub="Weights follow the exercise everywhere it is used." exclude=${inPlan}
      onClose=${() => setSheet(null)} onPick=${pick} />` : null}
    <${Nav} active="plans" />
  </div>`;
}

// ======================================================================
// Progress
// ======================================================================

function Progress() {
  const d = useStore();
  return d.progressTab === 'exercises' ? html`<${ExerciseProgress} />` : html`<${WorkoutHistory} />`;
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
          const recs = sessionSummary(s, d.sessions, exById, plan).records;
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
          <span class="small muted">${done.length} ${done.length === 1 ? 'exercise' : 'exercises'} done</span>
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
  const sum = sessionSummary(session, d.sessions, exById, plan);
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
      <button class="btn btn-ghost link" style="align-self: flex-start; margin-left: -10px; padding: 0 8px; font-size: 16px" onClick=${() => go({ name: from === 'home' ? 'home' : 'progress' })}><${Icon} name="back" size=${20} sw=${2.2} />${from === 'home' ? 'Today' : 'Workouts'}</button>
      <h1 class="title">${planName(plan)}</h1>
      <span class="small muted">${fmtDate(session.startedAt, true)} · ${hhmm(session.startedAt)}</span>
    </div>
    <div class="main">
      <span class="section-label">Done, in this order · ${done.length}</span>
      ${done.length ? html`<div class="card">
        ${done.map((e, i) => {
          const tags = [];
          const rec = recById[e.id];
          if (rec) tags.push([rec.kind === 'weight' ? 'New record ' + fmtNum(rec.value) + ' kg' : 'New record ' + rec.value + ' reps', 'rec']);
          if (e.kind === 'swapped') tags.push(['Replaces ' + name(e.replacesExerciseId), '']);
          if (e.kind === 'added') tags.push(['Added', '']);
          if (e.plannedSets && e.sets.length !== e.plannedSets) tags.push([e.sets.length + ' of ' + e.plannedSets + ' sets', 'warn']);
          if (e.appliedScheme) tags.push(['Now ' + e.appliedScheme, '']);
          return html`<div key=${e.id} class="log-row">
            <span class="small muted num" style="width: 18px; flex-shrink: 0; font-weight: 600">${i + 1}</span>
            <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px">
              <span style="font-size: 15px; font-weight: 600">${name(e.exerciseId)}</span>
              <span class="small num" style="color: var(--text-2)">${setsText(e.sets)}</span>
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
    const windowed = hist.slice(-10);
    const first = windowed[0], last = hist[hist.length - 1];
    const diff = round2(val(last) - val(first));
    const pr = personalRecord(hist);

    const pts = hist.slice(-20);
    const N = pts.length;
    const vals = pts.map(val);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = bw ? 2 : 2.5;
    lo = Math.max(0, lo - pad); hi += pad;
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
          <span class="hero-num num">${fmtNum(val(last)) + unit}</span>
          <span class="num" style="font-weight: 600; color: var(--text-2)">${(diff > 0 ? '+' : diff < 0 ? '−' : '±') + fmtNum(Math.abs(diff)) + unit}</span>
        </div>
        <span class="small muted">Change over the last ${windowed.length} ${windowed.length === 1 ? 'session' : 'sessions'}, since ${fmtDate(first.session.startedAt)}</span>
      </section>

      <section class="card card-pad" style="flex-direction: row; align-items: center; gap: 14px">
        <span style="width: 44px; height: 44px; flex-shrink: 0; border-radius: 22px; background: rgba(91,155,255,0.14); color: var(--accent); display: flex; align-items: center; justify-content: center"><${Icon} name="trophy" size=${22} /></span>
        <div style="flex: 1; display: flex; flex-direction: column; gap: 2px">
          <span class="section-label" style="margin: 0">Personal record</span>
          <span class="num" style="font-size: 22px; font-weight: 700">${pr.kind === 'weight' ? fmtNum(pr.value) + ' kg × ' + pr.reps : pr.value + ' reps'}</span>
          <span class="small num" style="color: var(--text-2)">${pr.kind === 'weight'
            ? 'Set ' + (pr.setIndex + 1) + ' of ' + pr.setCount + ', in a ' + schemeText(pr.item.entry.sets) + ' (' + setsText(pr.item.entry.sets) + ')'
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
          ${pts.map((h, i) => html`<button key=${'b' + i} aria-label=${fmtDate(h.session.startedAt) + ', ' + fmtNum(vals[i]) + unit} onClick=${() => setSel(i)}
            style=${'position:absolute;top:0;height:88%;border:0;padding:0;background:transparent;left:' + pct(X(i) - colW / 2) + ';width:' + pct(colW)}></button>`)}
          <div class="tip" role="status" style=${'left:' + pct(tipLeft) + ';top:' + (tipTop / 200) * 100 + '%'}>
            <span class="tiny muted">${fmtDate(pts[s].session.startedAt) + ' · ' + planName(planOf(pts[s].session))}</span>
            <span class="num" style="font-weight: 600">${fmtNum(vals[s]) + unit}</span>
            <span class="tiny muted num">${setsText(pts[s].entry.sets)}</span>
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
        <span class="small num" style="color: var(--text-2)">${setsText(h.entry.sets)}</span>
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
        return html`<button key=${e.id} class="sheet-item" onClick=${() => { setExId(e.id); setSel(null); setAll(false); setPicker(false); }}>
          <span>${e.name}</span><span class="small muted">${n ? n + (n === 1 ? ' session' : ' sessions') : inPlans(e.id) ? 'Workout ' + inPlans(e.id) : ''}</span>
        </button>`;
      })}
    <//>` : null}
    <${Nav} active="progress" />
  </div>`;
}

// ======================================================================
// Settings
// ======================================================================

function ExerciseEditor({ ex, inPlans, hasLog }) {
  const [name, setName] = useState(ex.name);
  const [setup, setSetup] = useState(ex.setup || '');
  const [startW, setStartW] = useState(ex.startWeight === null || ex.startWeight === undefined ? '' : fmtNum(ex.startWeight));
  const save = (patch) => saveExercise({ ...ex, ...patch });
  const commitName = () => {
    const n = name.trim();
    if (!n) { setName(ex.name); return; }
    const clash = state.exercises.some((e) => e.id !== ex.id && e.name.trim().toLowerCase() === n.toLowerCase());
    if (clash) { toast('Another exercise already has this name.'); setName(ex.name); return; }
    if (n !== ex.name) save({ name: n });
  };
  const commitStart = () => {
    const v = parseNum(startW);
    const val = startW.trim() === '' || Number.isNaN(v) || v < 0 ? null : round2(v);
    setStartW(val === null ? '' : fmtNum(val));
    if (val !== (ex.startWeight ?? null)) save({ startWeight: val });
  };
  const blurOnEnter = (e) => { if (e.key === 'Enter') e.target.blur(); };
  return html`<div style="padding: 12px 12px 14px; display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--line)">
    <label class="field">Name (renames it everywhere, history included)
      <input class="input" value=${name} onInput=${(e) => setName(e.target.value)} onBlur=${commitName} onKeyDown=${blurOnEnter} />
    </label>
    <div class="field">Equipment
      <div class="seg" role="radiogroup" aria-label="Equipment">
        <button role="radio" aria-checked=${ex.equipment !== 'dumbbell'} class=${ex.equipment !== 'dumbbell' ? 'on' : ''} onClick=${() => save({ equipment: 'machine' })}>Machine / barbell</button>
        <button role="radio" aria-checked=${ex.equipment === 'dumbbell'} class=${ex.equipment === 'dumbbell' ? 'on' : ''} onClick=${() => save({ equipment: 'dumbbell' })}>Dumbbells</button>
      </div>
    </div>
    <label class="field">Starting weight, kg
      <input class="input" inputmode="decimal" placeholder="optional" value=${startW} onInput=${(e) => setStartW(e.target.value.replace(/[^0-9.,]/g, ''))} onBlur=${commitStart} onKeyDown=${blurOnEnter} />
      <span class="tiny muted" style="font-weight: 400">${hasLog ? 'Already logged: the last weight used is proposed instead.' : 'Proposed the first time you do it, until it has been logged.'}</span>
    </label>
    <label class="field">Machine setup
      <input class="input" placeholder="e.g. seat 4, pad XL" value=${setup} onInput=${(e) => setSetup(e.target.value)} onBlur=${() => { if (setup !== (ex.setup || '')) save({ setup }); }} onKeyDown=${blurOnEnter} />
    </label>
    ${inPlans.length
      ? html`<p class="tiny muted">In ${inPlans.map((n) => 'Workout ' + n).join(' and ')}. To archive it, remove it from the plan first.</p>`
      : html`<button class="btn btn-warn" style="align-self: flex-start" onClick=${() => { save({ archived: true }); toast(ex.name + ' archived. Its history is kept.'); }}>Archive</button>`}
  </div>`;
}

function Exercises() {
  const d = useStore();
  const [openId, setOpenId] = useState(null);
  const [newName, setNewName] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const plans = activePlans(d.plans);
  const inPlans = (id) => plans.filter((p) => p.items.some((it) => it.exerciseId === id)).map((p) => p.name);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const active = d.exercises.filter((e) => !e.archived).sort(byName);
  const archived = d.exercises.filter((e) => e.archived).sort(byName);
  const create = () => {
    const n = newName.trim();
    if (!n) return;
    if (d.exercises.some((e) => e.name.trim().toLowerCase() === n.toLowerCase())) { toast(n + ' is already in the catalog.'); return; }
    const ex = { id: uid(), name: n, equipment: 'machine', setup: '', notes: '', archived: false, startWeight: null };
    saveExercise(ex);
    setNewName('');
    setOpenId(ex.id);
  };
  return html`<div class="screen">
    <div class="header" style="gap: 6px">
      <button class="btn btn-ghost link" style="align-self: flex-start; margin-left: -10px; padding: 0 8px; font-size: 16px" onClick=${() => go({ name: 'settings' })}><${Icon} name="back" size=${20} sw=${2.2} />Settings</button>
      <h1 class="title">Exercises</h1>
      <span class="small muted">${active.length} in the catalog. Exercises not in a plan can be added to one, swapped in or added to a workout.</span>
    </div>
    <div class="main">
      <div style="display: flex; gap: 8px; align-items: flex-end">
        <label class="field" style="flex: 1">New exercise
          <input class="input" placeholder="Name" value=${newName} onInput=${(e) => setNewName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') create(); }} />
        </label>
        <button class="btn btn-primary" onClick=${create}>Add</button>
      </div>
      <${ImportButton} label="Add exercises from file" cls="btn" onFile=${addExercisesFromFile} />
      ${active.map((ex) => {
        const open = openId === ex.id;
        const ps = inPlans(ex.id);
        const h = exerciseHistory(d.sessions, ex.id);
        const last = h.length ? h[h.length - 1] : null;
        const planW = plans.flatMap((p) => p.items).find((it) => it.exerciseId === ex.id && it.weight !== null && it.weight !== undefined);
        const wTxt = last ? (last.top === 0 ? 'bodyweight' : 'last ' + fmtNum(last.top) + ' kg')
          : planW ? 'plan ' + fmtWeight(planW.weight)
          : ex.startWeight !== null && ex.startWeight !== undefined ? 'start ' + fmtWeight(ex.startWeight) : 'no weight yet';
        return html`<div key=${ex.id} class=${'card' + (open ? ' ex-card open' : '')}>
          <button class="ex-head" style="min-height: 60px" aria-expanded=${open} onClick=${() => setOpenId(open ? null : ex.id)}>
            <div class="ex-head-text">
              <span class="ex-name">${ex.name}</span>
              <span class="small muted">${ex.equipment === 'dumbbell' ? 'Dumbbells' : 'Machine / barbell'} · ${ps.length ? 'Workout ' + ps.join(' + ') : 'not in a plan'} · ${wTxt}</span>
            </div>
          </button>
          ${open ? html`<${ExerciseEditor} key=${ex.id} ex=${ex} inPlans=${ps} hasLog=${!!last} />` : null}
        </div>`;
      })}
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
      <span class="section-label">Rotation</span>
      <div class="card card-pad" style="gap: 10px">
        <span style="font-size: 15px; font-weight: 500">Next workout</span>
        <div class="seg" role="radiogroup" aria-label="Next workout" style="background: var(--bg)">
          ${plans.map((p) => html`<button key=${p.id} role="radio" aria-checked=${p.id === next} class=${p.id === next ? 'on' : ''} onClick=${() => saveSettings({ nextPlanId: p.id })}>${planName(p)}</button>`)}
        </div>
        <span class="tiny muted">Switches automatically after each workout. Change it here only to break the rotation.</span>
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
        <span class="tiny muted">Each exercise is set to Machine / barbell or Dumbbells in Plans. Tap a weight during a workout to type any value.</span>
      </div>

      <span class="section-label">Workout and Today</span>
      <div class="card">
        ${toggles.map(([key, label, hint]) => html`<div key=${key} class="row">
          <span style="display: flex; flex-direction: column; gap: 2px"><span>${label}</span><span class="tiny muted">${hint}</span></span>
          <button class=${'switch' + (s[key] ? ' on' : '')} role="switch" aria-checked=${!!s[key]} aria-label=${label} onClick=${() => saveSettings({ [key]: !s[key] })}><span></span></button>
        </div>`)}
      </div>

      <span class="section-label">Catalog</span>
      <button class="card row" style="text-align: left; width: 100%" onClick=${() => go({ name: 'exercises' })}>
        <span style="display: flex; flex-direction: column; gap: 2px"><span>Exercises</span>
          <span class="tiny muted">${d.exercises.filter((e) => !e.archived).length} in the catalog · add, rename, archive</span></span>
        <span class="muted"><${Icon} name="next" size=${20} /></span>
      </button>

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
    else if (r.name === 'summary') screen = html`<${Summary} id=${r.id} edited=${!!r.edited} />`;
    else if (r.name === 'plans') screen = html`<${Plans} />`;
    else if (r.name === 'progress') screen = html`<${Progress} />`;
    else if (r.name === 'session') screen = html`<${SessionDetail} key=${r.id} id=${r.id} from=${r.from} />`;
    else if (r.name === 'settings') screen = html`<${Settings} />`;
    else if (r.name === 'exercises') screen = html`<${Exercises} />`;
    else screen = html`<${Home} />`;
  }
  return html`${screen}${d.toast ? html`<div class="toast" role="status">${d.toast}</div>` : null}`;
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
    setState({
      loaded: true,
      exercises: data.exercises,
      plans: data.plans,
      sessions: data.sessions,
      settings,
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
