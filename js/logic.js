// Pure logic for Lift Happens: no DOM, no storage. Tested with node (tests/logic.test.mjs).

export const DEFAULT_SETTINGS = {
  nextPlanId: null,
  stepMachine: 1.25,
  stepDbSmall: 1,
  dbThreshold: 10,
  stepDbLarge: 2,
  keepAwake: true,
  autoAdvance: true,
  lastBackup: null
};

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export const round2 = (v) => Math.round(v * 100) / 100;

export function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '';
  return String(round2(Number(v)));
}

export function fmtWeight(v) {
  if (v === null || v === undefined || v === '') return '—';
  return Number(v) === 0 ? 'BW' : fmtNum(v) + ' kg';
}

export function parseNum(text) {
  if (text === null || text === undefined) return NaN;
  const t = String(text).trim().replace(',', '.');
  if (t === '') return NaN;
  return Number(t);
}

const ts = (iso) => (iso ? Date.parse(iso) : 0);

// ---------- weight steps ----------

export function stepUp(equipment, w, s = DEFAULT_SETTINGS) {
  if (equipment !== 'dumbbell') return s.stepMachine;
  return w < s.dbThreshold ? s.stepDbSmall : s.stepDbLarge;
}

export function stepDown(equipment, w, s = DEFAULT_SETTINGS) {
  if (equipment !== 'dumbbell') return s.stepMachine;
  return w <= s.dbThreshold ? s.stepDbSmall : s.stepDbLarge;
}

export function increase(equipment, w, s) {
  const base = w === null || w === undefined ? 0 : w;
  return round2(base + stepUp(equipment, base, s));
}

export function decrease(equipment, w, s) {
  const base = w === null || w === undefined ? 0 : w;
  return Math.max(0, round2(base - stepDown(equipment, base, s)));
}

// ---------- history ----------

// The moment an entry counts as done: its own doneAt, else its session's times.
export function entryTime(entry, session) {
  return ts(entry.doneAt) || ts(session.finishedAt) || ts(session.startedAt);
}

// All done entries of one exercise, oldest first.
export function exerciseHistory(sessions, exerciseId, opts = {}) {
  const out = [];
  for (const s of sessions) {
    if (opts.excludeSessionId && s.id === opts.excludeSessionId) continue;
    if (opts.before && ts(s.startedAt) >= opts.before) continue;
    for (const e of s.entries || []) {
      if (e.exerciseId !== exerciseId || e.status !== 'done' || !e.sets || !e.sets.length) continue;
      const weights = e.sets.map((x) => (x.weight === null || x.weight === undefined ? 0 : x.weight));
      out.push({
        session: s,
        entry: e,
        time: entryTime(e, s),
        top: Math.max.apply(null, weights),
        totalReps: e.sets.reduce((a, x) => a + (x.reps || 0), 0),
        volume: e.sets.reduce((a, x) => a + (x.weight || 0) * (x.reps || 0), 0)
      });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export function lastDone(sessions, exerciseId, opts = {}) {
  const h = exerciseHistory(sessions, exerciseId, opts);
  return h.length ? h[h.length - 1] : null;
}

// ---------- starting values ----------

function spread(weights, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (!weights.length) out.push(null);
    else out.push(i < weights.length ? weights[i] : weights[weights.length - 1]);
  }
  return out;
}

// Starting sets for a plan item, following the spec's four-step rule.
export function startingSets(item, sessions, opts = {}) {
  const count = Math.max(1, item.sets || 1);
  const prev = lastDone(sessions, item.exerciseId, opts);
  const planW = item.weight === null || item.weight === undefined ? null : item.weight;
  let weights;
  if (planW !== null && (!prev || ts(item.weightEditedAt) > prev.time)) {
    weights = spread([planW], count);
  } else if (prev) {
    weights = spread(prev.entry.sets.map((x) => x.weight), count);
  } else if (planW !== null) {
    weights = spread([planW], count);
  } else {
    weights = spread([], count);
  }
  return weights.map((w) => ({ weight: w, reps: item.reps }));
}

// Starting sets for an exercise that is not (or no longer) the plan item: swap or add.
export function setsFromHistory(exerciseId, count, reps, sessions, opts = {}) {
  const prev = lastDone(sessions, exerciseId, opts);
  const weights = prev ? spread(prev.entry.sets.map((x) => x.weight), count) : spread([], count);
  return weights.map((w) => ({ weight: w, reps: reps }));
}

export function createSession(plan, sessions, now = new Date()) {
  const id = uid();
  const opts = { excludeSessionId: id };
  return {
    id,
    planId: plan.id,
    startedAt: now.toISOString(),
    finishedAt: null,
    note: '',
    entries: plan.items.map((item, i) => ({
      id: uid(),
      order: i,
      exerciseId: item.exerciseId,
      planItemId: item.id,
      kind: 'planned',
      replacesExerciseId: null,
      status: 'open',
      doneAt: null,
      sets: startingSets(item, sessions, opts)
    }))
  };
}

export function hasEmptyWeight(entry) {
  return entry.sets.some((x) => x.weight === null || x.weight === undefined || Number.isNaN(x.weight));
}

// ---------- rotation ----------

export function activePlans(plans) {
  return plans.filter((p) => !p.archived).slice().sort((a, b) => a.order - b.order);
}

export function nextPlanAfter(plans, planId) {
  const list = activePlans(plans);
  if (!list.length) return null;
  const i = list.findIndex((p) => p.id === planId);
  return list[(i + 1) % list.length].id;
}

export function plannedPlanId(plans, settings) {
  const list = activePlans(plans);
  if (!list.length) return null;
  if (settings.nextPlanId && list.some((p) => p.id === settings.nextPlanId)) return settings.nextPlanId;
  return list[0].id;
}

// ---------- summary after a workout ----------

export function sessionSummary(session, sessions, exercisesById, plan = null) {
  const before = ts(session.startedAt);
  const opts = { excludeSessionId: session.id, before };
  let volLast = 0, volToday = 0, heavier = 0, lighter = 0, same = 0, records = 0;
  const rows = [];
  for (const e of session.entries) {
    if (e.status !== 'done') continue;
    const ex = exercisesById[e.exerciseId];
    const hist = exerciseHistory(sessions, e.exerciseId, opts);
    let prev = hist.length ? hist[hist.length - 1] : null;
    let vsPlan = false;
    // First time ever: compare with the plan's starting weight, if it has one.
    if (!prev && e.kind === 'planned' && plan) {
      const item = plan.items.find((it) => it.id === e.planItemId);
      if (item && item.weight !== null && item.weight !== undefined) {
        prev = { top: item.weight, totalReps: item.sets * item.reps, volume: item.weight * item.reps * item.sets };
        vsPlan = true;
      }
    }
    const weights = e.sets.map((x) => x.weight || 0);
    const top = Math.max.apply(null, weights);
    const totalReps = e.sets.reduce((a, x) => a + (x.reps || 0), 0);
    const bodyweight = top === 0 && (!prev || prev.top === 0);
    let delta = null;
    if (prev) {
      delta = bodyweight ? totalReps - prev.totalReps : round2(top - prev.top);
      if (delta > 0) heavier++; else if (delta < 0) lighter++; else same++;
      if (!bodyweight) {
        volLast += prev.volume;
        volToday += e.sets.reduce((a, x) => a + (x.weight || 0) * (x.reps || 0), 0);
      }
    }
    let record = null;
    if (hist.length) {
      if (bodyweight) {
        const best = Math.max.apply(null, hist.map((h) => h.totalReps));
        if (totalReps > best) record = { kind: 'reps', value: totalReps, previous: best };
      } else {
        const best = Math.max.apply(null, hist.map((h) => h.top));
        if (top > best) {
          const setIndex = weights.indexOf(top);
          record = { kind: 'weight', value: top, reps: e.sets[setIndex].reps, setIndex, setCount: e.sets.length, previous: best };
        }
      }
    }
    if (record) records++;
    rows.push({
      entryId: e.id,
      name: ex ? ex.name : 'Exercise',
      kind: e.kind,
      vsPlan,
      bodyweight,
      top,
      prevTop: prev ? prev.top : null,
      totalReps,
      prevReps: prev ? prev.totalReps : null,
      delta,
      record
    });
  }
  const done = session.entries.filter((e) => e.status === 'done');
  return {
    rows,
    volLast,
    volToday,
    volPct: volLast > 0 ? (volToday / volLast - 1) * 100 : null,
    heavier, lighter, same, records,
    setsLogged: done.reduce((a, e) => a + e.sets.length, 0),
    skipped: session.entries.filter((e) => e.status === 'skipped').length
  };
}

// ---------- personal record ----------

export function personalRecord(history) {
  if (!history.length) return null;
  const anyWeight = history.some((h) => h.top > 0);
  if (anyWeight) {
    let best = history[0];
    for (const h of history) if (h.top > best.top) best = h;
    const setIndex = best.entry.sets.findIndex((x) => (x.weight || 0) === best.top);
    return { kind: 'weight', value: best.top, reps: best.entry.sets[setIndex].reps, setIndex, setCount: best.entry.sets.length, item: best };
  }
  let best = history[0];
  for (const h of history) if (h.totalReps > best.totalReps) best = h;
  return { kind: 'reps', value: best.totalReps, item: best };
}

export function schemeText(sets) {
  const reps = sets.map((x) => x.reps);
  const same = reps.every((r) => r === reps[0]);
  return sets.length + ' × ' + (same ? reps[0] : reps.join('/'));
}

export function setsText(sets) {
  return sets.map((x) => (x.weight ? fmtNum(x.weight) : 'BW') + ' × ' + x.reps).join(' · ');
}

// ---------- import / export ----------

export function validateImport(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a Lift Happens file.');
  if (data.app !== 'lift-happens') throw new Error('Not a Lift Happens file.');
  if (!Array.isArray(data.exercises) || !Array.isArray(data.plans)) throw new Error('The file has no exercises or plans.');
  const exIds = new Set(data.exercises.map((e) => e.id));
  for (const p of data.plans) {
    if (!p.id || !p.name || !Array.isArray(p.items)) throw new Error('A plan in the file is incomplete.');
    for (const it of p.items) if (!exIds.has(it.exerciseId)) throw new Error('Plan ' + p.name + ' refers to an unknown exercise.');
  }
  return {
    exercises: data.exercises.map((e) => ({
      id: e.id, name: String(e.name), equipment: e.equipment === 'dumbbell' ? 'dumbbell' : 'machine',
      setup: e.setup || '', notes: e.notes || '', archived: !!e.archived
    })),
    plans: data.plans.map((p, i) => ({
      id: p.id, name: String(p.name), order: typeof p.order === 'number' ? p.order : i, archived: !!p.archived,
      items: p.items.map((it) => ({
        id: it.id || uid(), exerciseId: it.exerciseId,
        sets: Math.max(1, parseInt(it.sets, 10) || 1), reps: Math.max(1, parseInt(it.reps, 10) || 1),
        weight: it.weight === null || it.weight === undefined || it.weight === '' ? null : Number(it.weight),
        weightEditedAt: it.weightEditedAt || null
      }))
    })),
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {})
  };
}

export function buildExport(state, now = new Date()) {
  return {
    app: 'lift-happens',
    version: 1,
    kind: 'backup',
    exportedAt: now.toISOString(),
    exercises: state.exercises,
    plans: state.plans,
    sessions: state.sessions,
    settings: state.settings
  };
}
