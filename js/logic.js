// Pure logic for Lift Happens: no DOM, no storage. Tested with node (tests/logic.test.mjs).

export const DEFAULT_SETTINGS = {
  nextPlanId: null,
  stepMachine: 1.25,
  stepDbSmall: 1,
  dbThreshold: 10,
  stepDbLarge: 2,
  keepAwake: true,
  autoAdvance: true,
  showQuote: true,
  dailyQuote: null,
  lastBackup: null,
  backupSnoozeUntil: null,
  // Body weight: the current value, plus the first one ever entered (used for workouts logged before it).
  bodyWeight: null,
  bodyWeightFirst: null,
  bodyWeightFirstDay: null,
  // 1.9.0: how each exercise logs its weight was set up once, by name (see setUpLoads).
  loadsSetUp: false
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
  const t = String(text).trim().replace(',', '.').replace(/[\u2212\u2013]/g, '-');
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

// Below 0 only where it means something: assisted body-weight exercises (counterweight).
export function decrease(equipment, w, s, allowNegative = false) {
  const base = w === null || w === undefined ? 0 : w;
  const v = round2(base - stepDown(equipment, base <= 0 ? -base : base, s));
  return allowNegative ? v : Math.max(0, v);
}

// ---------- how an exercise logs its weight ----------

// total: the weight set (machines, cables) · each: one dumbbell of a pair (counted × 2)
// plates: the plates on one side (counted × 2, plus the bar) · bodyweight: kg added on body weight (negative = assisted)
export const LOADS = ['total', 'each', 'plates', 'bodyweight'];
export const BARS = [{ label: 'Barbell', kg: 20 }, { label: 'EZ', kg: 10 }, { label: 'Smith', kg: 13.6 }];
export function loadOf(ex) {
  if (ex && LOADS.includes(ex.load)) return ex.load;
  return ex && ex.equipment === 'dumbbell' ? 'each' : 'total';
}
export const barOf = (ex) => (ex && typeof ex.bar === 'number' && ex.bar >= 0 ? ex.bar : 20);

// The weight actually moved by one rep, for volume, total lifted and milestones only.
export function realLoad(w, ex, bodyWeight) {
  const v = w === null || w === undefined || Number.isNaN(Number(w)) ? 0 : Number(w);
  const kind = loadOf(ex);
  if (kind === 'each') return Math.max(0, v * 2);
  if (kind === 'plates') return Math.max(0, v * 2 + barOf(ex));
  if (kind === 'bodyweight') return Math.max(0, (bodyWeight || 0) + v);
  return Math.max(0, v);
}
export const entryVolume = (e, ex, bodyWeight) => (e.sets || []).reduce((a, x) => a + realLoad(x.weight, ex, bodyWeight) * (x.reps || 0), 0);

const MINUS = '\u2212';
// A weight as typed in the field: −10 for assisted, 2.5, 0.
export const signedNum = (v) => (Number(v) < 0 ? MINUS + fmtNum(-v) : fmtNum(v));
// A weight in words, following how the exercise is logged: "BW −10 kg", "BW +2.5 kg", "12.5 kg".
export function fmtLoad(v, ex) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  if (loadOf(ex) === 'bodyweight') return n === 0 ? 'BW' : 'BW ' + (n > 0 ? '+' : MINUS) + fmtNum(Math.abs(n)) + ' kg';
  return fmtWeight(n);
}
// Short description of how an exercise logs its weight, for lists.
export function loadLabel(ex) {
  const kind = loadOf(ex);
  if (kind === 'each') return 'Each dumbbell × 2';
  if (kind === 'plates') return 'Plates per side + ' + fmtNum(barOf(ex)) + ' kg bar';
  if (kind === 'bodyweight') return 'Body weight + added';
  return 'Total weight';
}

// 1.9.0, once: how the existing exercises log their weight (by id, else by name). Exercises that
// already have a load type are left alone. "Barbell Curl" is an EZ bar: renamed. Adds Smith Machine Squat.
const LOAD_SETUP = [
  { ids: ['squat', 'deadlift', 'incline_bench'], names: ['squat', 'deadlift', 'incline bench press', 'decline bench press', 'bench press'], load: 'plates', bar: 20 },
  { ids: ['ez_preacher_curl', 'ez_tri_ext', 'barbell_curl'], names: ['ez-bar preacher curl', 'lying ez-bar triceps extension', 'barbell curl', 'ez-bar curl'], load: 'plates', bar: 10 },
  { ids: ['db_curl', 'db_preacher_curl', 'db_shrugs', 'lat_raise', 'db_tri_ext'], names: ['dumbbell biceps curl', 'dumbbell preacher curl', 'dumbbell shrugs', 'lateral raises', 'lying dumbbell triceps extension'], load: 'each' },
  { ids: ['dips', 'pullups'], names: ['dips', 'pull-ups', 'pull ups', 'pullups'], load: 'bodyweight' }
];
export function setUpLoads(exercises) {
  const norm = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const changed = [];
  const names = new Set(exercises.map((e) => norm(e.name)));
  for (const ex of exercises) {
    if (LOADS.includes(ex.load)) continue;
    const rule = LOAD_SETUP.find((r) => r.ids.includes(ex.id)) || LOAD_SETUP.find((r) => r.names.includes(norm(ex.name)));
    const next = { ...ex, load: rule ? rule.load : 'total' };
    if (rule && rule.bar !== undefined) next.bar = rule.bar;
    if (norm(ex.name) === 'barbell curl' && !names.has('ez-bar curl')) next.name = 'EZ-Bar Curl';
    changed.push(next);
  }
  const added = [];
  if (!names.has('smith machine squat') && !exercises.some((e) => e.id === 'smith_squat')) {
    added.push({ id: 'smith_squat', name: 'Smith Machine Squat', equipment: 'machine', setup: '', notes: '', archived: false, startWeight: null, noSuggest: false, load: 'plates', bar: 13.6 });
  }
  return { changed, added };
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
    // Never logged and no plan weight: the exercise's starting weight, if it has one.
    weights = spread(opts.fallbackWeight === null || opts.fallbackWeight === undefined ? [] : [opts.fallbackWeight], count);
  }
  return weights.map((w) => ({ weight: w, reps: item.reps }));
}

// Starting sets for an exercise that is not (or no longer) the plan item: swap or add.
export function setsFromHistory(exerciseId, count, reps, sessions, opts = {}) {
  const prev = lastDone(sessions, exerciseId, opts);
  const fb = opts.fallbackWeight === null || opts.fallbackWeight === undefined ? [] : [opts.fallbackWeight];
  const weights = prev ? spread(prev.entry.sets.map((x) => x.weight), count) : spread(fb, count);
  return weights.map((w) => ({ weight: w, reps: reps }));
}

export function createSession(plan, sessions, now = new Date(), exercisesById = {}) {
  const id = uid();
  const opts = { excludeSessionId: id };
  const startW = (exId) => (exercisesById[exId] ? exercisesById[exId].startWeight : null);
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
      plannedSets: item.sets,
      reminder: null,
      sets: startingSets(item, sessions, { ...opts, fallbackWeight: startW(item.exerciseId) })
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

// Each exercise is compared with the last time it was done, in any workout.
// Total volume is compared with the previous workout of the same type (A with A, B with B),
// counting only exercises done both times; the first workout of a type uses the plan's weights.
export function sessionSummary(session, sessions, exercisesById, plan = null, opts0 = {}) {
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
      exerciseId: e.exerciseId,
      load: loadOf(ex),
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
  const bwOf = (s) => s.bodyWeight ?? opts0.bodyWeight ?? null;
  const volOf = (e, s) => entryVolume(e, exercisesById[e.exerciseId], bwOf(s));
  const prevSame = previousSameType(session, sessions);
  let volBase = null;
  if (prevSame) {
    const prevBy = {}, hereBy = {};
    for (const e of prevSame.entries || []) if (e.status === 'done' && e.sets && e.sets.length) prevBy[e.exerciseId] = (prevBy[e.exerciseId] || 0) + volOf(e, prevSame);
    for (const e of done) hereBy[e.exerciseId] = (hereBy[e.exerciseId] || 0) + volOf(e, session);
    for (const k of Object.keys(hereBy)) if (k in prevBy) { volLast += prevBy[k]; volToday += hereBy[k]; }
    volBase = 'previous';
  } else if (plan) {
    for (const e of done) {
      const item = e.kind === 'planned' ? plan.items.find((it) => it.id === e.planItemId) : null;
      if (!item || item.weight === null || item.weight === undefined) continue;
      volLast += realLoad(item.weight, exercisesById[e.exerciseId], bwOf(session)) * item.reps * item.sets;
      volToday += volOf(e, session);
    }
    if (volLast > 0) volBase = 'plan';
  }
  return {
    rows,
    volLast,
    volToday,
    volBase,
    volPrev: prevSame ? { id: prevSame.id, startedAt: prevSame.startedAt } : null,
    volPct: volLast > 0 ? (volToday / volLast - 1) * 100 : null,
    heavier, lighter, same, records,
    setsLogged: done.reduce((a, e) => a + e.sets.length, 0),
    skipped: session.entries.filter((e) => e.status === 'skipped').length
  };
}

// The latest finished workout of the same type that started before this one.
export function previousSameType(session, sessions) {
  const t = ts(session.startedAt);
  let best = null;
  for (const s of sessions) {
    if (s.id === session.id || s.planId !== session.planId || !s.finishedAt || ts(s.startedAt) >= t) continue;
    if (!best || ts(s.startedAt) > ts(best.startedAt)) best = s;
  }
  return best;
}

// ---------- plan updates from a workout ----------

// When an exercise is confirmed with a different number of sets, or with the same reps in every set
// but a different number than the plan, returns { from, to } to offer updating the plan; else null.
// Uneven reps (e.g. 8, 8, 6) are a tired last set, not a new scheme: then only the set count counts.
export function schemeChange(entry, item) {
  if (!entry || !item || entry.kind !== 'planned' || !entry.sets || !entry.sets.length) return null;
  const reps = entry.sets[0].reps;
  const even = entry.sets.every((x) => x.reps === reps);
  const to = { sets: entry.sets.length, reps: even ? reps : item.reps };
  if (to.sets === item.sets && to.reps === item.reps) return null;
  return { from: { sets: item.sets, reps: item.reps }, to };
}

// ---------- automatic suggestion: more weight ----------

// Suggests more weight when the last two times the exercise was done (in any workout) used the same
// weights set by set and every planned set was done with at least the plan's reps.
// Never for an exercise switched off, a bodyweight one, a swapped or added one, or once today's
// weight is already higher than last time.
export function suggestIncrease(sessions, entry, item, exercise, currentSessionId) {
  if (!entry || !item || entry.kind !== 'planned' || entry.status !== 'open') return false;
  if (exercise && exercise.noSuggest) return false;
  const h = exerciseHistory(sessions, entry.exerciseId, { excludeSessionId: currentSessionId });
  if (h.length < 2) return false;
  const [a, b] = h.slice(-2);
  const wa = a.entry.sets.map((x) => x.weight || 0);
  const wb = b.entry.sets.map((x) => x.weight || 0);
  const lastTop = Math.max.apply(null, wb);
  if (lastTop <= 0) return false;
  if (wa.length !== wb.length || wa.some((w, i) => w !== wb[i])) return false;
  const full = (e) => e.sets.length >= item.sets && e.sets.every((x) => (x.reps || 0) >= item.reps);
  if (!full(a.entry) || !full(b.entry)) return false;
  const nowTop = Math.max.apply(null, entry.sets.map((x) => x.weight || 0));
  return !(nowTop > lastTop);
}

// ---------- backup reminder ----------

const DAY = 86400000;
// Days since the last backup (or since the first workout, if there never was one); null = no workouts yet.
export function daysSinceBackup(settings, sessions, now = Date.now()) {
  const finished = sessions.filter((s) => s.finishedAt);
  if (!finished.length) return null;
  const since = settings.lastBackup ? ts(settings.lastBackup) : Math.min.apply(null, finished.map((s) => ts(s.startedAt)));
  return Math.floor((now - since) / DAY);
}
// The Home reminder: 30 days without a backup, unless "Not now" was tapped in the last 7 days.
export function backupDue(settings, sessions, now = Date.now()) {
  const days = daysSinceBackup(settings, sessions, now);
  if (days === null || days < 30) return false;
  return !(settings.backupSnoozeUntil && ts(settings.backupSnoozeUntil) > now);
}

// ---------- calendar and consistency ----------

// Monday of the local week a date falls in, as a day key.
export function weekKey(date) {
  const d = new Date(date);
  const back = (d.getDay() + 6) % 7;
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}
function prevWeekKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return localDayKey(new Date(y, m - 1, d - 7));
}
// Weeks in a row with at least 2 workouts, up to this week (this week counts once it has 2).
export function weeksInARow(sessions, now = new Date()) {
  const per = {};
  for (const s of sessions) if (s.finishedAt) { const k = weekKey(s.startedAt); per[k] = (per[k] || 0) + 1; }
  let k = weekKey(now);
  if ((per[k] || 0) < 2) k = prevWeekKey(k);
  let n = 0;
  while ((per[k] || 0) >= 2) { n++; k = prevWeekKey(k); }
  return n;
}
// Total volume of a workout with the real load: both dumbbells, bar and plates on both sides,
// body weight (the workout's own, else ctx.bodyWeight). ctx.exercises: exercises by id.
export function sessionVolume(s, ctx = {}) {
  const byId = ctx.exercises || {};
  const bw = s.bodyWeight ?? ctx.bodyWeight ?? null;
  return (s.entries || []).filter((e) => e.status === 'done').reduce((a, e) => a + entryVolume(e, byId[e.exerciseId], bw), 0);
}

// ---------- milestones ----------

export const MILESTONES = {
  workouts: [
    { at: 1, title: 'It begins', line: 'The first one is the hardest. Allegedly.' },
    { at: 5, title: 'Habit forming', line: 'Five workouts. The front desk has started to nod at you.' },
    { at: 10, title: 'Double digits', line: 'Ten sessions in. The barbell is starting to recognise you.' },
    { at: 25, title: 'Regular', line: 'Twenty-five workouts. You now have opinions about benches.' },
    { at: 50, title: 'Half-century', line: 'Fifty workouts. Your gym bag has seen things.' },
    { at: 100, title: 'Centurion', line: 'A hundred workouts. Somewhere, a dumbbell whispers your name.' }
  ],
  lifted: [
    { at: 1000, title: 'About a small car', line: 'One tonne moved, one rep at a time. The car didn’t even notice.' },
    { at: 6000, title: 'About an elephant', line: 'Six tonnes: one adult elephant. Please don’t try it all at once.' },
    { at: 40000, title: 'About a loaded truck', line: 'Forty tonnes. Truck drivers would like a word.' },
    { at: 100000, title: 'About a blue whale', line: 'A hundred tonnes: one blue whale, lifted in instalments.' },
    { at: 400000, title: 'About a jumbo jet', line: 'Four hundred tonnes. Cleared for take-off.' },
    { at: 1000000, title: 'Kilotonne club', line: 'A thousand tonnes. The floor has filed a complaint.' }
  ],
  weeks: [
    { at: 4, title: 'Officially a habit', line: 'Four weeks in a row. Skipping would feel weird now.' },
    { at: 8, title: 'Two months straight', line: 'Eight weeks without a gap. Consistency is your new personality.' },
    { at: 12, title: 'A full quarter', line: 'Twelve weeks in a row. Quarterly results: excellent.' },
    { at: 26, title: 'Half a year', line: 'Twenty-six weeks in a row. Even the calendar is impressed.' },
    { at: 52, title: 'A whole year', line: 'Fifty-two weeks. That’s not a habit any more, that’s a lifestyle.' }
  ],
  records: [
    { at: 10, title: 'Record collector', line: 'Ten personal bests. Your past self is getting nervous.' },
    { at: 25, title: 'Personal best machine', line: 'Twenty-five records. Breaking them is becoming routine.' },
    { at: 50, title: 'Record factory', line: 'Fifty records. At this point the old ones are just suggestions.' },
    { at: 100, title: 'Hall of fame', line: 'A hundred personal bests. Frame this one.' }
  ]
};
// After the last step each kind repeats every `every`, with these lines in turn.
const REPEAT = { workouts: 50, lifted: 1000000, weeks: 52, records: 50 };
export const REPEAT_LINES = [
  'Still going. The weights never stood a chance.',
  'Another round number. You collect these now.',
  'Steady as a squat rack.',
  'Nobody asked you to keep going. You did anyway.',
  'The plan is working. Don’t tell it, it will get cocky.',
  'Same gym, stronger you.'
];
const tonnes = (kg) => fmtNum(Math.round(kg / 100) / 10) + ' t';
export function milestoneName(kind, at) {
  if (kind === 'workouts') return at === 1 ? 'First workout' : at + ' workouts';
  if (kind === 'lifted') return tonnes(at) + ' lifted';
  if (kind === 'weeks') return at + ' weeks in a row with 2+ workouts';
  return at + ' new records';
}
// The n-th step of a kind (0-based): the fixed ones, then repeats.
function step(kind, n) {
  const list = MILESTONES[kind];
  if (n < list.length) return list[n];
  const k = n - list.length + 1;
  const at = list[list.length - 1].at + k * REPEAT[kind];
  const title = kind === 'lifted' ? tonnes(at) : kind === 'weeks' ? Math.round(at / 52) + ' years' : 'Keep it up';
  return { at, title, line: REPEAT_LINES[(k - 1) % REPEAT_LINES.length] };
}

// Walks the finished workouts in order and returns the totals, every milestone reached (with the
// workout that reached it) and the next one of each kind.
export function computeMilestones(sessions, now = new Date(), ctx = {}) {
  const done = sessions.filter((s) => s.finishedAt).sort((a, b) => ts(a.startedAt) - ts(b.startedAt));
  const value = { workouts: 0, lifted: 0, weeks: 0, records: 0 };
  const idx = { workouts: 0, lifted: 0, weeks: 0, records: 0 };
  const unlocked = [];
  const best = {};
  const perWeek = {}, streakOfWeek = {};
  const reach = (kind, s) => {
    while (step(kind, idx[kind]).at <= value[kind]) {
      const m = step(kind, idx[kind]);
      unlocked.push({ kind, at: m.at, name: milestoneName(kind, m.at), title: m.title, line: m.line, sessionId: s.id, date: s.startedAt });
      idx[kind]++;
    }
  };
  for (const s of done) {
    value.workouts++;
    value.lifted += sessionVolume(s, ctx);
    for (const e of s.entries || []) {
      if (e.status !== 'done' || !e.sets || !e.sets.length) continue;
      const top = Math.max.apply(null, e.sets.map((x) => x.weight || 0));
      const reps = e.sets.reduce((a, x) => a + (x.reps || 0), 0);
      const b = best[e.exerciseId];
      if (b) {
        if (top === 0 && b.top === 0 ? reps > b.reps : top > b.top) value.records++;
        b.top = Math.max(b.top, top); b.reps = Math.max(b.reps, reps);
      } else best[e.exerciseId] = { top, reps };
    }
    const wk = weekKey(s.startedAt);
    perWeek[wk] = (perWeek[wk] || 0) + 1;
    if (perWeek[wk] === 2) {
      streakOfWeek[wk] = (streakOfWeek[prevWeekKey(wk)] || 0) + 1;
      value.weeks = Math.max(value.weeks, streakOfWeek[wk]);
    }
    for (const kind of ['workouts', 'lifted', 'weeks', 'records']) reach(kind, s);
  }
  const next = ['workouts', 'lifted', 'weeks', 'records'].map((kind) => {
    const m = step(kind, idx[kind]);
    const current = kind === 'weeks' ? weeksInARow(sessions, now) : value[kind];
    return { kind, at: m.at, name: milestoneName(kind, m.at), title: m.title, value: current, progress: Math.min(1, current / m.at) };
  });
  return { totals: { ...value, weeksNow: weeksInARow(sessions, now) }, unlocked, next };
}

// ---------- "lifted so far" comparison ----------

const OBJECTS = [
  { kg: 1000, one: 'small car', many: 'small cars', lines: [
    'About {n} small cars. Parked, not driven.', 'About {n} small cars, one rep at a time.',
    'About {n} small cars. No towing licence needed.', 'About {n} small cars. The car park is jealous.'] },
  { kg: 6000, one: 'elephant', many: 'elephants', lines: [
    'About {n} elephants. They did not volunteer.', 'About {n} elephants, lifted politely.',
    'About {n} elephants. Peanuts not included.', 'About {n} elephants. The herd is impressed.'] },
  { kg: 40000, one: 'loaded truck', many: 'loaded trucks', lines: [
    'About {n} loaded trucks. No forklift involved.', 'About {n} loaded trucks, delivered by hand.',
    'About {n} loaded trucks. The motorway would be jammed.', 'About {n} loaded trucks. Logistics, but make it gains.'] },
  { kg: 100000, one: 'blue whale', many: 'blue whales', lines: [
    'About {n} blue whales. They’d rather be swimming.', 'About {n} blue whales, lifted in instalments.',
    'About {n} blue whales. The ocean wants them back.', 'About {n} blue whales. Marine biologists are confused.'] },
  { kg: 400000, one: 'jumbo jet', many: 'jumbo jets', lines: [
    'About {n} jumbo jets. Cleared for take-off.', 'About {n} jumbo jets, no runway needed.',
    'About {n} jumbo jets. Air traffic control is nervous.', 'About {n} jumbo jets. Please fasten your lifting belt.'] }
];
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
function hashOf(text) { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
// The largest object that fits at least twice; the line changes once a day.
export function liftedComparison(kg, dayKey) {
  if (kg < 1000) return 'Not even a small car yet. Give it a week.';
  if (kg < 2000) return 'About one small car. Everyone starts somewhere.';
  let obj = OBJECTS[0];
  for (const o of OBJECTS) if (kg / o.kg >= 2) obj = o;
  const n = Math.round(kg / obj.kg);
  const word = n <= 20 ? WORDS[n] : String(n);
  return obj.lines[hashOf(dayKey + obj.many) % obj.lines.length].replace('{n}', word);
}

// ---------- personal record ----------

export function personalRecord(history) {
  if (!history.length) return null;
  const anyWeight = history.some((h) => h.top !== 0);
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

export function setsText(sets, ex) {
  const bw = loadOf(ex) === 'bodyweight';
  const w = (v) => (!v ? 'BW' : bw ? 'BW ' + (v > 0 ? '+' : MINUS) + fmtNum(Math.abs(v)) : fmtNum(v));
  return sets.map((x) => w(x.weight) + ' × ' + x.reps).join(' · ');
}

// ---------- your session: duration, heart rate, mood ----------

export const MOODS = ['😫', '😐', '🙂', '💪', '🔥'];
// "62 min · ♥ 132 · 💪" (only what was filled in).
export function sessionDataText(s) {
  const parts = [];
  if (s.duration) parts.push(s.duration + ' min');
  if (s.heartRate) parts.push('♥ ' + s.heartRate);
  if (s.mood >= 1 && s.mood <= MOODS.length) parts.push(MOODS[s.mood - 1]);
  return parts.join(' · ');
}

// ---------- Today: this week and the closest milestone ----------

// Monday to Sunday of the current week: day key and the workout started that day (if any).
export function thisWeek(sessions, now = new Date()) {
  const back = (now.getDay() + 6) % 7;
  const byDay = {};
  for (const s of sessions) if (s.finishedAt) { const k = localDayKey(new Date(s.startedAt)); if (!byDay[k]) byDay[k] = s; }
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back + i);
    const key = localDayKey(d);
    days.push({ key, date: d.getDate(), session: byDay[key] || null });
  }
  const count = sessions.filter((s) => s.finishedAt && weekKey(s.startedAt) === weekKey(now)).length;
  return { days, count, todayKey: localDayKey(now) };
}
// The next milestone closest to being reached (highest share done).
export function closestMilestone(next) {
  let best = null;
  for (const n of next) if (!best || n.progress > best.progress) best = n;
  return best;
}
// Whole days between two dates, by the calendar.
export function daysBetween(a, b) {
  const da = new Date(a), db = new Date(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate()), ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / 86400000);
}
export const agoText = (days) => (days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago');

// ---------- import / export ----------

const numOrNull = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const normName = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');

// The load type of an exercise in a file, when it has one.
function loadFields(e) {
  if (!LOADS.includes(e.load)) return {};
  const out = { load: e.load };
  if (e.load === 'plates') out.bar = numOrNull(e.bar) ?? 20;
  return out;
}

// A file with only exercises: added to the catalog, nothing else changes.
// Exercises whose name (or id) is already in the catalog are skipped.
export function mergeExercisesFile(data, existing) {
  if (!data || data.app !== 'lift-happens' || !Array.isArray(data.exercises)) throw new Error('Not a Lift Happens exercises file.');
  const names = new Set(existing.map((e) => normName(e.name)));
  const ids = new Set(existing.map((e) => e.id));
  const added = [], skipped = [];
  for (const e of data.exercises) {
    const name = String(e.name || '').trim();
    if (!name) continue;
    if (names.has(normName(name)) || (e.id && ids.has(e.id))) { skipped.push(name); continue; }
    const ex = {
      id: e.id || uid(), name, equipment: e.equipment === 'dumbbell' ? 'dumbbell' : 'machine',
      setup: e.setup || '', notes: e.notes || '', archived: false, startWeight: numOrNull(e.startWeight),
      noSuggest: !!e.noSuggest, ...loadFields(e)
    };
    names.add(normName(name)); ids.add(ex.id);
    added.push(ex);
  }
  return { added, skipped };
}

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
      setup: e.setup || '', notes: e.notes || '', archived: !!e.archived,
      startWeight: numOrNull(e.startWeight), noSuggest: !!e.noSuggest, ...loadFields(e)
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

// ---------- daily quote ----------

export function localDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// Picks a quote on the first launch of a day and keeps it until midnight.
// Recently shown quotes are left out, so none comes back too soon.
export function pickDailyQuote(prev, dayKey, poolSize, rand = Math.random) {
  if (!poolSize) return null;
  if (prev && prev.date === dayKey && prev.index < poolSize) return prev;
  const windowSize = Math.max(0, Math.min(100, poolSize - 20));
  const recent = ((prev && prev.recent) || []).filter((i) => i < poolSize).slice(-windowSize);
  const blocked = new Set(recent);
  let candidates = [];
  for (let i = 0; i < poolSize; i++) if (!blocked.has(i)) candidates.push(i);
  if (!candidates.length) candidates = Array.from({ length: poolSize }, (_, i) => i);
  const index = candidates[Math.min(candidates.length - 1, Math.floor(rand() * candidates.length))];
  return { date: dayKey, index, recent: windowSize ? [...recent, index].slice(-windowSize) : [] };
}

// ---------- reminders for next time ----------

export const SCHEMES = [{ sets: 3, reps: 8 }, { sets: 4, reps: 6 }, { sets: 5, reps: 5 }, { sets: 6, reps: 4 }];
export const schemeLabel = (sc) => sc.sets + ' × ' + sc.reps;

export function hasReminder(r) {
  return !!r && (r.dir === 'up' || r.dir === 'down' || !!r.scheme || !!(r.note && r.note.trim()));
}

// The reminder waiting for an exercise: the latest one set in another workout, unless the
// exercise has been confirmed (Done) in a workout started after that one.
// Derived from the log only, so cancelling or deleting a workout also removes its reminders.
export function pendingReminder(sessions, exerciseId, currentSessionId) {
  let best = null;
  for (const s of sessions) {
    if (s.id === currentSessionId) continue;
    for (const e of s.entries || []) {
      if (e.exerciseId !== exerciseId || !hasReminder(e.reminder)) continue;
      if (!best || ts(s.startedAt) > ts(best.session.startedAt)) best = { session: s, entry: e, reminder: e.reminder };
    }
  }
  if (!best) return null;
  const since = ts(best.session.startedAt);
  for (const s of sessions) {
    if (s.id === currentSessionId || s.id === best.session.id || ts(s.startedAt) <= since) continue;
    if ((s.entries || []).some((e) => e.exerciseId === exerciseId && e.status === 'done')) return null;
  }
  return best;
}

// New set count and reps; weights kept set by set (extra sets copy the last one).
export function applyScheme(sets, scheme) {
  const weights = sets.map((x) => x.weight);
  const out = [];
  for (let i = 0; i < scheme.sets; i++) {
    const w = weights.length ? (i < weights.length ? weights[i] : weights[weights.length - 1]) : null;
    out.push({ weight: w, reps: scheme.reps });
  }
  return out;
}

export function currentScheme(sets) {
  if (!sets.length) return null;
  const r = sets[0].reps;
  return sets.every((x) => x.reps === r) ? { sets: sets.length, reps: r } : null;
}

// After deleting a finished workout: if it was the latest one, its plan is up next again.
export function nextPlanAfterDelete(sessions, deleted, settings) {
  if (!deleted.finishedAt) return settings.nextPlanId;
  const later = sessions.some((s) => s.id !== deleted.id && s.finishedAt && ts(s.finishedAt) > ts(deleted.finishedAt));
  return later ? settings.nextPlanId : deleted.planId;
}
