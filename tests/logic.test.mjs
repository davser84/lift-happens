// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, increase, decrease, startingSets, createSession, setsFromHistory,
  nextPlanAfter, plannedPlanId, sessionSummary, personalRecord, exerciseHistory, validateImport,
  pickDailyQuote, localDayKey, pendingReminder, applyScheme, currentScheme, nextPlanAfterDelete, hasReminder, mergeExercisesFile,
  schemeChange, previousSameType, suggestIncrease, daysSinceBackup, backupDue, weekKey, weeksInARow,
  computeMilestones, liftedComparison, sessionVolume
} from '../js/logic.js';
import { QUOTES } from '../js/quotes.js';

const S = DEFAULT_SETTINGS;

test('machine steps are 1.25 kg both ways', () => {
  assert.equal(increase('machine', 27.5, S), 28.75);
  assert.equal(decrease('machine', 28.75, S), 27.5);
  assert.equal(decrease('machine', 0, S), 0);
});

test('dumbbell steps: 1 kg up to 10, then 2 kg', () => {
  assert.equal(increase('dumbbell', 8, S), 9);
  assert.equal(increase('dumbbell', 9, S), 10);
  assert.equal(increase('dumbbell', 10, S), 12);
  assert.equal(increase('dumbbell', 12, S), 14);
  assert.equal(decrease('dumbbell', 14, S), 12);
  assert.equal(decrease('dumbbell', 12, S), 10);
  assert.equal(decrease('dumbbell', 10, S), 9);
});

const session = (id, startedAt, entries, finishedAt = startedAt) => ({ id, planId: 'A', startedAt, finishedAt, entries });
const entry = (exerciseId, sets, status = 'done', doneAt = null) => ({ id: exerciseId + Math.random(), exerciseId, status, doneAt, sets });

test('starting weights: plan weight when no history', () => {
  const sets = startingSets({ exerciseId: 'x', sets: 3, reps: 8, weight: 27.5 }, []);
  assert.deepEqual(sets, [{ weight: 27.5, reps: 8 }, { weight: 27.5, reps: 8 }, { weight: 27.5, reps: 8 }]);
});

test('starting weights: empty when no history and no plan weight', () => {
  const sets = startingSets({ exerciseId: 'x', sets: 2, reps: 8, weight: null }, []);
  assert.deepEqual(sets, [{ weight: null, reps: 8 }, { weight: null, reps: 8 }]);
});

test('starting weights: last done session wins, set by set, reps from plan', () => {
  const hist = [session('s1', '2026-11-10T10:00:00Z', [entry('x', [{ weight: 27.5, reps: 8 }, { weight: 27.5, reps: 7 }, { weight: 30, reps: 6 }])])];
  const sets = startingSets({ exerciseId: 'x', sets: 3, reps: 8, weight: 25, weightEditedAt: '2026-11-01T00:00:00Z' }, hist);
  assert.deepEqual(sets.map((s) => s.weight), [27.5, 27.5, 30]);
  assert.deepEqual(sets.map((s) => s.reps), [8, 8, 8]);
});

test('starting weights: plan weight edited after last session wins (deload)', () => {
  const hist = [session('s1', '2026-11-10T10:00:00Z', [entry('x', [{ weight: 40, reps: 8 }])])];
  const sets = startingSets({ exerciseId: 'x', sets: 2, reps: 8, weight: 35, weightEditedAt: '2026-11-12T00:00:00Z' }, hist);
  assert.deepEqual(sets.map((s) => s.weight), [35, 35]);
});

test('starting weights: more sets than last log copy the last set, fewer take the first', () => {
  const hist = [session('s1', '2026-11-10T10:00:00Z', [entry('x', [{ weight: 20, reps: 8 }, { weight: 22.5, reps: 8 }])])];
  assert.deepEqual(startingSets({ exerciseId: 'x', sets: 4, reps: 8, weight: null }, hist).map((s) => s.weight), [20, 22.5, 22.5, 22.5]);
  assert.deepEqual(startingSets({ exerciseId: 'x', sets: 1, reps: 8, weight: null }, hist).map((s) => s.weight), [20]);
});

test('starting weights: skipped and open entries are ignored', () => {
  const hist = [
    session('s1', '2026-11-10T10:00:00Z', [entry('x', [{ weight: 20, reps: 8 }])]),
    session('s2', '2026-11-13T10:00:00Z', [entry('x', [{ weight: 99, reps: 8 }], 'skipped')])
  ];
  assert.equal(startingSets({ exerciseId: 'x', sets: 1, reps: 8, weight: null }, hist)[0].weight, 20);
});

test('weights carry across plans (same exercise id)', () => {
  const hist = [{ id: 's1', planId: 'A', startedAt: '2026-11-10T10:00:00Z', finishedAt: '2026-11-10T11:00:00Z', entries: [entry('face', [{ weight: 26.25, reps: 12 }])] }];
  const planB = { id: 'B', items: [{ id: 'i1', exerciseId: 'face', sets: 3, reps: 12, weight: 25, weightEditedAt: null }] };
  const s = createSession(planB, hist, new Date('2026-11-12T10:00:00Z'));
  assert.deepEqual(s.entries[0].sets.map((x) => x.weight), [26.25, 26.25, 26.25]);
  assert.equal(s.entries[0].status, 'open');
});

test('swap uses the substitute exercise history', () => {
  const hist = [session('s1', '2026-11-10T10:00:00Z', [entry('legpress', [{ weight: 80, reps: 8 }])])];
  assert.deepEqual(setsFromHistory('legpress', 3, 8, hist).map((s) => s.weight), [80, 80, 80]);
  assert.deepEqual(setsFromHistory('new', 2, 8, hist).map((s) => s.weight), [null, null]);
});

test('rotation A -> B -> A, archived plans skipped', () => {
  const plans = [{ id: 'A', order: 0 }, { id: 'B', order: 1 }, { id: 'C', order: 2, archived: true }];
  assert.equal(nextPlanAfter(plans, 'A'), 'B');
  assert.equal(nextPlanAfter(plans, 'B'), 'A');
  assert.equal(plannedPlanId(plans, { nextPlanId: null }), 'A');
  assert.equal(plannedPlanId(plans, { nextPlanId: 'B' }), 'B');
});

test('summary: deltas, volume and all-time records', () => {
  const ex = { x: { name: 'Leg Press' }, y: { name: 'Pull-ups' } };
  const s1 = session('s1', '2026-10-01T10:00:00Z', [entry('x', [{ weight: 85, reps: 8 }])]);
  const s2 = session('s2', '2026-11-01T10:00:00Z', [entry('x', [{ weight: 80, reps: 8 }]), entry('y', [{ weight: 0, reps: 8 }])]);
  const today = session('s3', '2026-11-17T10:00:00Z', [
    entry('x', [{ weight: 82.5, reps: 8 }]),
    entry('y', [{ weight: 0, reps: 9 }])
  ]);
  const all = [s1, s2, today];
  const sum = sessionSummary(today, all, ex);
  const lp = sum.rows.find((r) => r.name === 'Leg Press');
  assert.equal(lp.delta, 2.5);
  assert.equal(lp.record, null, 'heavier than last time but not than the all-time 85');
  const pu = sum.rows.find((r) => r.name === 'Pull-ups');
  assert.equal(pu.bodyweight, true);
  assert.equal(pu.delta, 1);
  assert.equal(pu.record.kind, 'reps');
  assert.equal(sum.volLast, 640);
  assert.equal(sum.volToday, 660);
  assert.equal(sum.heavier, 2);

  const later = session('s4', '2026-11-20T10:00:00Z', [entry('x', [{ weight: 85, reps: 8 }, { weight: 87.5, reps: 6 }])]);
  const sum2 = sessionSummary(later, [...all, later], ex);
  assert.deepEqual({ v: sum2.rows[0].record.value, set: sum2.rows[0].record.setIndex, prev: sum2.rows[0].record.previous }, { v: 87.5, set: 1, prev: 85 });
});

test('personal record: first time reached, with set position', () => {
  const s1 = session('s1', '2026-10-01T10:00:00Z', [entry('x', [{ weight: 27.5, reps: 8 }, { weight: 27.5, reps: 8 }, { weight: 28.75, reps: 8 }])]);
  const s2 = session('s2', '2026-11-01T10:00:00Z', [entry('x', [{ weight: 28.75, reps: 8 }, { weight: 28.75, reps: 8 }, { weight: 28.75, reps: 7 }])]);
  const pr = personalRecord(exerciseHistory([s1, s2], 'x'));
  assert.equal(pr.value, 28.75);
  assert.equal(pr.item.session.id, 's1');
  assert.equal(pr.setIndex, 2);
  assert.equal(pr.setCount, 3);
});

test('import validation', () => {
  assert.throws(() => validateImport({ app: 'other' }));
  const ok = validateImport({ app: 'lift-happens', exercises: [{ id: 'e1', name: 'Squat' }], plans: [{ id: 'A', name: 'A', items: [{ exerciseId: 'e1', sets: '3', reps: 8, weight: '' }] }] });
  assert.equal(ok.plans[0].items[0].sets, 3);
  assert.equal(ok.plans[0].items[0].weight, null);
  assert.equal(ok.exercises[0].equipment, 'machine');
  assert.throws(() => validateImport({ app: 'lift-happens', exercises: [], plans: [{ id: 'A', name: 'A', items: [{ exerciseId: 'zz' }] }] }));
});

test('summary: first workout compares with the plan starting weight', () => {
  const plan = { id: 'A', items: [{ id: 'i1', exerciseId: 'x', sets: 3, reps: 8, weight: 27.5 }] };
  const s = { id: 's1', planId: 'A', startedAt: '2026-11-17T10:00:00Z', finishedAt: null,
    entries: [{ id: 'e1', exerciseId: 'x', planItemId: 'i1', kind: 'planned', status: 'done', sets: [{ weight: 27.5, reps: 8 }, { weight: 27.5, reps: 8 }, { weight: 30, reps: 8 }] }] };
  const sum = sessionSummary(s, [s], { x: { name: 'Bench' } }, plan);
  assert.equal(sum.rows[0].vsPlan, true);
  assert.equal(sum.rows[0].delta, 2.5);
  assert.equal(sum.rows[0].record, null);
  assert.equal(sum.volLast, 660);
  assert.equal(sum.volToday, 680);
});

test('daily quote: same all day, new one the next launch day', () => {
  const a = pickDailyQuote(null, '2026-11-17', 150);
  assert.equal(pickDailyQuote(a, '2026-11-17', 150), a);
  const b = pickDailyQuote(a, '2026-11-19', 150);
  assert.equal(b.date, '2026-11-19');
  assert.notEqual(b.index, a.index);
});

test('daily quote: no repeat within the last 100 picks', () => {
  let q = null;
  const seen = [];
  for (let day = 0; day < 400; day++) {
    q = pickDailyQuote(q, 'day-' + day, 150);
    seen.push(q.index);
  }
  for (let i = 100; i < seen.length; i++) {
    assert.ok(!seen.slice(i - 100, i).includes(seen[i]), 'repeat too soon at ' + i);
  }
});

test('quote pool has 150 unique lines', () => {
  assert.equal(QUOTES.length, 150);
  assert.equal(new Set(QUOTES).size, 150);
  assert.match(localDayKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});

const sess = (id, startedAt, entries, finishedAt = startedAt) => ({ id, planId: 'A', startedAt, finishedAt, entries });
const ent = (exerciseId, status, reminder = null) => ({ id: exerciseId + '-' + Math.random(), exerciseId, status, reminder, sets: [{ weight: 20, reps: 8 }] });

test('reminder: shown in the next workout with that exercise, in any plan', () => {
  const s1 = sess('s1', '2026-11-10T10:00:00Z', [ent('x', 'done', { dir: 'up' })]);
  const s2 = sess('s2', '2026-11-12T10:00:00Z', [ent('y', 'done')]);
  const cur = sess('s3', '2026-11-14T10:00:00Z', [ent('x', 'open')], null);
  const r = pendingReminder([s1, s2, cur], 'x', 's3');
  assert.equal(r.reminder.dir, 'up');
  assert.equal(pendingReminder([s1, s2, cur], 'x', 's1'), null, 'not shown in the workout where it was set');
});

test('reminder: cleared once the exercise is Done in a later workout, kept if skipped', () => {
  const s1 = sess('s1', '2026-11-10T10:00:00Z', [ent('x', 'done', { scheme: { sets: 5, reps: 5 } })]);
  const skipped = sess('s2', '2026-11-12T10:00:00Z', [ent('x', 'skipped')]);
  assert.ok(pendingReminder([s1, skipped], 'x', 'now'));
  const done = sess('s3', '2026-11-14T10:00:00Z', [ent('x', 'done')]);
  assert.equal(pendingReminder([s1, skipped, done], 'x', 'now'), null);
  assert.ok(pendingReminder([s1, skipped, done], 'x', 's3'), 'still shown inside the workout where it gets done, until Done');
});

test('reminder: latest one wins, empty reminders ignored', () => {
  const s1 = sess('s1', '2026-11-10T10:00:00Z', [ent('x', 'done', { dir: 'up' })]);
  const s2 = sess('s2', '2026-11-12T10:00:00Z', [ent('x', 'done', { dir: null, scheme: null, note: '  ' })]);
  assert.equal(hasReminder(s2.entries[0].reminder), false);
  assert.equal(pendingReminder([s1, s2], 'x', 'now'), null, 'done in s2 after the reminder of s1');
  const s3 = sess('s3', '2026-11-13T10:00:00Z', [ent('x', 'done', { note: 'seat 4' })]);
  assert.equal(pendingReminder([s1, s2, s3], 'x', 'now').reminder.note, 'seat 4');
});

test('apply scheme keeps weights set by set', () => {
  const sets = [{ weight: 20, reps: 8 }, { weight: 22.5, reps: 8 }, { weight: 25, reps: 8 }];
  assert.deepEqual(applyScheme(sets, { sets: 5, reps: 5 }), [20, 22.5, 25, 25, 25].map((w) => ({ weight: w, reps: 5 })));
  assert.deepEqual(applyScheme(sets, { sets: 2, reps: 10 }), [{ weight: 20, reps: 10 }, { weight: 22.5, reps: 10 }]);
  assert.deepEqual(currentScheme(sets), { sets: 3, reps: 8 });
  assert.equal(currentScheme([{ weight: 1, reps: 8 }, { weight: 1, reps: 7 }]), null);
});

test('rotation goes back only when the latest workout is deleted', () => {
  const a = { id: 'a', planId: 'A', finishedAt: '2026-11-10T11:00:00Z' };
  const b = { id: 'b', planId: 'B', finishedAt: '2026-11-12T11:00:00Z' };
  const settings = { nextPlanId: 'A' };
  assert.equal(nextPlanAfterDelete([a, b], b, settings), 'B');
  assert.equal(nextPlanAfterDelete([a, b], a, settings), 'A');
});

test('start weight is used only until the exercise has a log', () => {
  const item = { id: 'i', exerciseId: 'x', sets: 3, reps: 8, weight: null };
  const ex = { x: { id: 'x', startWeight: 72.5 } };
  const s0 = createSession({ id: 'A', items: [item] }, [], new Date('2026-11-19T10:00:00Z'), ex);
  assert.deepEqual(s0.entries[0].sets.map((x) => x.weight), [72.5, 72.5, 72.5]);
  const logged = [{ id: 'p', planId: 'A', startedAt: '2026-11-18T10:00:00Z', finishedAt: '2026-11-18T11:00:00Z', entries: [{ id: 'e', exerciseId: 'x', status: 'done', sets: [{ weight: 75, reps: 8 }] }] }];
  const s1 = createSession({ id: 'A', items: [item] }, logged, new Date('2026-11-19T10:00:00Z'), ex);
  assert.deepEqual(s1.entries[0].sets.map((x) => x.weight), [75, 75, 75]);
  assert.deepEqual(setsFromHistory('x', 2, 8, [], { fallbackWeight: 12 }).map((x) => x.weight), [12, 12]);
});

test('exercises file is merged by name, duplicates skipped', () => {
  const existing = [{ id: 'face_pull', name: 'Face Pull' }];
  const r = mergeExercisesFile({ app: 'lift-happens', kind: 'exercises', exercises: [
    { id: 'lat', name: 'Lat Pulldown', equipment: 'machine', startWeight: 72.5 },
    { name: ' face pull ' },
    { name: 'Dumbbell Shrugs', equipment: 'dumbbell', startWeight: '26' }
  ] }, existing);
  assert.deepEqual(r.added.map((e) => e.name), ['Lat Pulldown', 'Dumbbell Shrugs']);
  assert.deepEqual(r.skipped, ['face pull']);
  assert.equal(r.added[1].startWeight, 26);
  assert.equal(r.added[1].equipment, 'dumbbell');
  assert.throws(() => mergeExercisesFile({ app: 'x' }, existing));
});

test('summary: volume vs the previous workout of the same type, exercises vs their last time anywhere', () => {
  const ex = { x: { name: 'Face Pull' }, y: { name: 'Leg Press' } };
  const a1 = { id: 'a1', planId: 'A', startedAt: '2026-11-10T10:00:00Z', finishedAt: '2026-11-10T11:00:00Z',
    entries: [entry('x', [{ weight: 100, reps: 8 }]), entry('y', [{ weight: 50, reps: 8 }], 'skipped')] };
  const b1 = { id: 'b1', planId: 'B', startedAt: '2026-11-12T10:00:00Z', finishedAt: '2026-11-12T11:00:00Z',
    entries: [entry('x', [{ weight: 120, reps: 8 }])] };
  const a2 = { id: 'a2', planId: 'A', startedAt: '2026-11-14T10:00:00Z', finishedAt: '2026-11-14T11:00:00Z',
    entries: [entry('x', [{ weight: 110, reps: 8 }]), entry('y', [{ weight: 60, reps: 8 }])] };
  const all = [a1, b1, a2];
  assert.equal(previousSameType(a2, all).id, 'a1');
  const sum = sessionSummary(a2, all, ex);
  assert.equal(sum.volBase, 'previous');
  assert.equal(sum.volPrev.id, 'a1');
  assert.equal(sum.volLast, 800, 'only Face Pull: Leg Press was skipped in the last A');
  assert.equal(sum.volToday, 880);
  assert.equal(Math.round(sum.volPct), 10);
  assert.equal(sum.rows.find((r) => r.name === 'Face Pull').delta, -10, 'exercise compared with B (its last time)');
  // A log reopened later still compares with the workouts before it
  const a3 = { id: 'a3', planId: 'A', startedAt: '2026-11-16T10:00:00Z', finishedAt: '2026-11-16T11:00:00Z', entries: [entry('x', [{ weight: 130, reps: 8 }])] };
  assert.equal(sessionSummary(a2, [...all, a3], ex).volLast, 800);
});

test('summary: first workout of a type compares volume with the plan, else nothing', () => {
  const plan = { id: 'B', items: [{ id: 'i1', exerciseId: 'x', sets: 3, reps: 8, weight: 20 }] };
  const a1 = { id: 'a1', planId: 'A', startedAt: '2026-11-10T10:00:00Z', finishedAt: '2026-11-10T11:00:00Z', entries: [entry('x', [{ weight: 25, reps: 8 }])] };
  const b1 = { id: 'b1', planId: 'B', startedAt: '2026-11-12T10:00:00Z', finishedAt: '2026-11-12T11:00:00Z',
    entries: [{ id: 'e', exerciseId: 'x', planItemId: 'i1', kind: 'planned', status: 'done', sets: [{ weight: 25, reps: 8 }, { weight: 25, reps: 8 }, { weight: 25, reps: 8 }] }] };
  const sum = sessionSummary(b1, [a1, b1], { x: { name: 'Face Pull' } }, plan);
  assert.equal(sum.volBase, 'plan');
  assert.equal(sum.volLast, 480);
  assert.equal(sum.volToday, 600);
  assert.equal(sum.rows[0].delta, 0, 'the exercise row still compares with its last time (A, 25 kg)');
  const none = sessionSummary(b1, [a1, b1], { x: { name: 'Face Pull' } }, { id: 'B', items: [{ id: 'i1', exerciseId: 'x', sets: 3, reps: 8, weight: null }] });
  assert.equal(none.volBase, null);
  assert.equal(none.volPct, null);
});

test('plan update offer: set count or even reps differ from the plan', () => {
  const item = { sets: 3, reps: 8 };
  const e = (reps, kind = 'planned') => ({ kind, sets: reps.map((r) => ({ weight: 20, reps: r })) });
  assert.equal(schemeChange(e([8, 8, 8]), item), null);
  assert.deepEqual(schemeChange(e([12, 12, 12]), item), { from: { sets: 3, reps: 8 }, to: { sets: 3, reps: 12 } });
  assert.deepEqual(schemeChange(e([8, 8, 8, 8]), item), { from: { sets: 3, reps: 8 }, to: { sets: 4, reps: 8 } });
  assert.equal(schemeChange(e([8, 8, 6]), item), null, 'tired last set is not a new scheme');
  assert.deepEqual(schemeChange(e([8, 8, 6, 6]), item).to, { sets: 4, reps: 8 }, 'uneven reps: only the set count changes');
  assert.equal(schemeChange(e([12, 12, 12], 'swapped'), item), null);
  assert.equal(schemeChange(e([12, 12, 12], 'added'), null), null);
});

// ---------- 1.8.0 ----------
const doneSess = (id, day, sets, extra = {}) => ({ id, planId: 'A', startedAt: day + 'T10:00:00', finishedAt: day + 'T11:00:00',
  entries: [{ id: id + 'e', exerciseId: 'x', planItemId: 'i1', kind: 'planned', status: 'done', doneAt: day + 'T10:30:00', sets }], ...extra });
const s3 = (w, r = 8) => [{ weight: w, reps: r }, { weight: w, reps: r }, { weight: w, reps: r }];

test('suggestion: two full times in a row at the same weights', () => {
  const item = { id: 'i1', exerciseId: 'x', sets: 3, reps: 8 };
  const cur = { id: 'c', exerciseId: 'x', planItemId: 'i1', kind: 'planned', status: 'open', sets: s3(50) };
  const two = [doneSess('a', '2026-11-10', s3(50)), doneSess('b', '2026-11-12', s3(50))];
  assert.equal(suggestIncrease(two, cur, item, { id: 'x' }, 'now'), true);
  assert.equal(suggestIncrease(two.slice(1), cur, item, { id: 'x' }, 'now'), false, 'only once');
  assert.equal(suggestIncrease([doneSess('a', '2026-11-10', s3(47.5)), two[1]], cur, item, {}, 'now'), false, 'weight changed');
  assert.equal(suggestIncrease([two[0], doneSess('b', '2026-11-12', [{ weight: 50, reps: 8 }, { weight: 50, reps: 8 }, { weight: 50, reps: 6 }])], cur, item, {}, 'now'), false, 'reps missed');
  assert.equal(suggestIncrease(two, cur, item, { noSuggest: true }, 'now'), false, 'switched off');
  assert.equal(suggestIncrease(two, { ...cur, sets: s3(52.5) }, item, {}, 'now'), false, 'already raised today');
  assert.equal(suggestIncrease(two, { ...cur, kind: 'added' }, item, {}, 'now'), false);
  assert.equal(suggestIncrease([doneSess('a', '2026-11-10', s3(0)), doneSess('b', '2026-11-12', s3(0))], cur, item, {}, 'now'), false, 'bodyweight');
  assert.equal(suggestIncrease([doneSess('a', '2026-11-10', s3(50, 10)), doneSess('b', '2026-11-12', s3(50, 9))], cur, item, {}, 'now'), true, 'more reps than planned is fine');
});

test('backup reminder after 30 days, Not now for 7', () => {
  const now = Date.parse('2026-12-20T12:00:00Z');
  const sess = [doneSess('a', '2026-11-10', s3(50))];
  assert.equal(daysSinceBackup({}, [], now), null);
  assert.equal(backupDue({ lastBackup: '2026-12-01T10:00:00Z' }, sess, now), false);
  assert.equal(backupDue({ lastBackup: '2026-11-15T10:00:00Z' }, sess, now), true);
  assert.equal(backupDue({ lastBackup: null }, sess, now), true, 'never backed up: counts from the first workout');
  assert.equal(backupDue({ lastBackup: '2026-11-15T10:00:00Z', backupSnoozeUntil: '2026-12-25T10:00:00Z' }, sess, now), false);
  assert.equal(backupDue({ lastBackup: '2026-11-15T10:00:00Z', backupSnoozeUntil: '2026-12-19T10:00:00Z' }, sess, now), true);
});

test('weeks in a row with 2+ workouts', () => {
  assert.equal(weekKey('2026-11-22T10:00:00'), '2026-11-16', 'Sunday belongs to the week of Monday 16');
  const ss = ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-12', '2026-11-16', '2026-11-18', '2026-11-23'].map((d, i) => doneSess('s' + i, d, s3(50)));
  assert.equal(weeksInARow(ss, new Date('2026-11-24T12:00:00')), 3, 'this week has 1 so far: count up to last week');
  assert.equal(weeksInARow([...ss, doneSess('t', '2026-11-25', s3(50))], new Date('2026-11-26T12:00:00')), 4);
  assert.equal(weeksInARow(ss, new Date('2026-12-08T12:00:00')), 0);
});

test('milestones: unlocked by the workout that reaches them, next ones with progress', () => {
  const days = ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-12', '2026-11-16', '2026-11-18'];
  const ss = days.map((d, i) => doneSess('s' + i, d, s3(500 + i * 10)));  // 12+ t a workout, a record each time after the first
  const m = computeMilestones(ss, new Date('2026-11-19T12:00:00'));
  assert.equal(m.totals.workouts, 6);
  assert.equal(m.totals.records, 5);
  assert.equal(m.totals.weeks, 3);
  const names = m.unlocked.map((u) => u.name);
  assert.ok(names.includes('First workout') && names.includes('5 workouts') && names.includes('1 t lifted') && names.includes('6 t lifted') && names.includes('40 t lifted'));
  assert.equal(m.unlocked.find((u) => u.name === '5 workouts').sessionId, 's4');
  const next = Object.fromEntries(m.next.map((n) => [n.kind, n]));
  assert.equal(next.workouts.at, 10);
  assert.equal(next.weeks.at, 4);
  assert.equal(next.records.at, 10);
  assert.equal(next.lifted.at, 100000);
  // repeats after the last step
  const many = Array.from({ length: 151 }, (_, i) => doneSess('r' + i, new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), s3(10)));
  const mm = computeMilestones(many, new Date('2026-01-01T12:00:00'));
  assert.ok(mm.unlocked.some((u) => u.name === '150 workouts'));
  assert.equal(mm.next.find((n) => n.kind === 'workouts').at, 200);
});

test('lifted-so-far comparison picks an object that fits at least twice', () => {
  assert.match(liftedComparison(500, '2026-11-20'), /Not even a small car/);
  assert.match(liftedComparison(1500, '2026-11-20'), /one small car/);
  assert.match(liftedComparison(64800, '2026-11-20'), /About eleven elephants/);
  assert.match(liftedComparison(250000, '2026-11-20'), /About (two|three) blue whales/);
  assert.equal(liftedComparison(64800, '2026-11-20'), liftedComparison(64800, '2026-11-20'), 'same line all day');
  assert.equal(sessionVolume(doneSess('a', '2026-11-10', s3(50))), 1200);
});
