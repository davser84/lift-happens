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

// ---------- 1.9.0: real load, body weight, session data, this week ----------

import {
  loadOf, barOf, realLoad, fmtLoad, signedNum, setUpLoads, sessionDataText, thisWeek, closestMilestone, daysBetween, agoText,
  sessionVolume as vol190, computeMilestones as ms190, sessionSummary as sum190, setsText as st190, parseNum as pn190,
  decrease as dec190, personalRecord as pr190, exerciseHistory as eh190, validateImport as vi190, DEFAULT_SETTINGS as DS190
} from '../js/logic.js';

const EXS = {
  squat: { id: 'squat', name: 'Squat', equipment: 'machine', load: 'plates', bar: 20 },
  ez: { id: 'ez', name: 'EZ-Bar Curl', equipment: 'machine', load: 'plates', bar: 10 },
  curl: { id: 'curl', name: 'Dumbbell Biceps Curl', equipment: 'dumbbell', load: 'each' },
  dips: { id: 'dips', name: 'Dips', equipment: 'machine', load: 'bodyweight' },
  press: { id: 'press', name: 'Leg Press', equipment: 'machine', load: 'total' }
};
const doneEntry = (exerciseId, sets, extra = {}) => ({ id: exerciseId + Math.random(), exerciseId, kind: 'planned', status: 'done', doneAt: null, sets, ...extra });

test('real load: total, both dumbbells, plates on both sides plus the bar, body weight plus added', () => {
  assert.equal(realLoad(80, EXS.press, 80), 80);
  assert.equal(realLoad(16, EXS.curl, 80), 32);
  assert.equal(realLoad(10, EXS.squat, 80), 40);
  assert.equal(realLoad(0, EXS.squat, 80), 20);
  assert.equal(realLoad(10, EXS.ez, 80), 30);
  assert.equal(realLoad(2.5, EXS.dips, 80), 82.5);
  assert.equal(realLoad(-10, EXS.dips, 80), 70);
  assert.equal(realLoad(-10, EXS.dips, null), 0, 'no body weight yet: never below 0');
  assert.equal(loadOf({ equipment: 'dumbbell' }), 'each');
  assert.equal(loadOf({ equipment: 'machine' }), 'total');
  assert.equal(loadOf(undefined), 'total');
  assert.equal(barOf({ load: 'plates' }), 20);
  assert.equal(barOf({ load: 'plates', bar: 13.6 }), 13.6);
});

test('weights in words follow the load type; minus sign typed or from the stepper', () => {
  assert.equal(fmtLoad(-10, EXS.dips), 'BW −10 kg');
  assert.equal(fmtLoad(2.5, EXS.dips), 'BW +2.5 kg');
  assert.equal(fmtLoad(0, EXS.dips), 'BW');
  assert.equal(fmtLoad(12.5, EXS.squat), '12.5 kg');
  assert.equal(signedNum(-7.5), '−7.5');
  assert.equal(signedNum(5), '5');
  assert.equal(st190([{ weight: -10, reps: 8 }, { weight: 0, reps: 8 }, { weight: 2.5, reps: 6 }], EXS.dips), 'BW −10 × 8 · BW × 8 · BW +2.5 × 6');
  assert.equal(st190([{ weight: 10, reps: 8 }], EXS.squat), '10 × 8');
  assert.equal(pn190('−7,5'), -7.5);
  assert.equal(dec190('machine', 0, DS190, true), -1.25);
  assert.equal(dec190('machine', -10, DS190, true), -11.25);
  assert.equal(dec190('machine', 0, DS190), 0, 'other exercises stop at 0');
});

test('session volume uses the real load and the workout’s own body weight, else the first one entered', () => {
  const s = { id: 's', finishedAt: 'x', bodyWeight: 80, entries: [
    doneEntry('squat', [{ weight: 10, reps: 8 }]), // 40 × 8 = 320
    doneEntry('curl', [{ weight: 16, reps: 8 }]), // 32 × 8 = 256
    doneEntry('dips', [{ weight: -10, reps: 8 }]), // 70 × 8 = 560
    { ...doneEntry('press', [{ weight: 100, reps: 8 }]), status: 'skipped' }
  ] };
  assert.equal(vol190(s, { exercises: EXS }), 1136);
  const old = { ...s, bodyWeight: undefined };
  assert.equal(vol190(old, { exercises: EXS, bodyWeight: 90 }), 1136 + 80);
  assert.equal(vol190(old, {}), 10 * 8 + 16 * 8 + 0, 'without exercises: the logged numbers, never below 0');
});

test('summary: volume with the real load; assisted dips with less counterweight are heavier and a record', () => {
  const plan = { id: 'b', items: [{ id: 'i1', exerciseId: 'dips', sets: 1, reps: 8, weight: null }, { id: 'i2', exerciseId: 'squat', sets: 1, reps: 8, weight: null }] };
  const prev = { id: 'p', planId: 'b', startedAt: '2026-11-16T17:00:00Z', finishedAt: '2026-11-16T18:00:00Z', bodyWeight: 80, entries: [
    doneEntry('dips', [{ weight: -10, reps: 8 }], { planItemId: 'i1' }), doneEntry('squat', [{ weight: 10, reps: 8 }], { planItemId: 'i2' })] };
  const now = { id: 'n', planId: 'b', startedAt: '2026-11-19T17:00:00Z', finishedAt: '2026-11-19T18:00:00Z', bodyWeight: 80, entries: [
    doneEntry('dips', [{ weight: -7.5, reps: 8 }], { planItemId: 'i1' }), doneEntry('squat', [{ weight: 12.5, reps: 8 }], { planItemId: 'i2' })] };
  const sum = sum190(now, [prev, now], EXS, plan);
  assert.equal(sum.volLast, 70 * 8 + 40 * 8);
  assert.equal(sum.volToday, 72.5 * 8 + 45 * 8);
  const dips = sum.rows.find((r) => r.exerciseId === 'dips');
  assert.equal(dips.load, 'bodyweight');
  assert.equal(dips.delta, 2.5);
  assert.equal(dips.record.kind, 'weight');
  assert.equal(sum.heavier, 2);
  const h = eh190([prev, now], 'dips');
  assert.equal(pr190(h).kind, 'weight');
  assert.equal(pr190(h).value, -7.5);
});

test('milestones: total lifted with the real load; less assistance counts as a record', () => {
  const mk = (i, w) => ({ id: 'w' + i, planId: 'a', startedAt: '2026-11-0' + i + 'T10:00:00Z', finishedAt: '2026-11-0' + i + 'T11:00:00Z', bodyWeight: 80,
    entries: [doneEntry('dips', [{ weight: w, reps: 10 }])] });
  const ms = ms190([mk(1, -10), mk(2, -7.5), mk(3, -5)], new Date('2026-11-04T10:00:00Z'), { exercises: EXS });
  assert.equal(ms.totals.lifted, 700 + 725 + 750);
  assert.equal(ms.totals.records, 2);
  assert.ok(ms.unlocked.some((u) => u.kind === 'lifted' && u.at === 1000));
});

test('1.9.0 setup: load types by id or name, EZ-Bar Curl renamed, Smith Machine Squat added, own choices kept', () => {
  const list = [
    { id: 'squat', name: 'Squat', equipment: 'machine' },
    { id: 'incline_bench', name: 'Decline Bench Press', equipment: 'machine' },
    { id: 'barbell_curl', name: 'Barbell Curl', equipment: 'machine' },
    { id: 'x1', name: 'Lying EZ-Bar Triceps Extension', equipment: 'machine' },
    { id: 'lat_raise', name: 'Lateral Raises', equipment: 'dumbbell' },
    { id: 'x2', name: 'Pull-ups', equipment: 'machine' },
    { id: 'shoulder_press', name: 'Shoulder Press', equipment: 'machine' },
    { id: 'x3', name: 'Dips', equipment: 'machine', load: 'total' }
  ];
  const { changed, added } = setUpLoads(list);
  const by = Object.fromEntries(changed.map((e) => [e.id, e]));
  assert.deepEqual([by.squat.load, by.squat.bar], ['plates', 20]);
  assert.deepEqual([by.incline_bench.load, by.incline_bench.bar], ['plates', 20]);
  assert.deepEqual([by.barbell_curl.load, by.barbell_curl.bar, by.barbell_curl.name], ['plates', 10, 'EZ-Bar Curl']);
  assert.deepEqual([by.x1.load, by.x1.bar], ['plates', 10]);
  assert.equal(by.lat_raise.load, 'each');
  assert.equal(by.x2.load, 'bodyweight');
  assert.equal(by.shoulder_press.load, 'total');
  assert.equal(by.x3, undefined, 'an exercise with a load type is left alone');
  assert.equal(added.length, 1);
  assert.deepEqual([added[0].name, added[0].load, added[0].bar], ['Smith Machine Squat', 'plates', 13.6]);
  assert.equal(setUpLoads([...list, ...added]).added.length, 0);
});

test('backups keep the load type and the bar', () => {
  const data = vi190({ app: 'lift-happens', exercises: [{ id: 'a', name: 'Squat', load: 'plates', bar: 13.6 }, { id: 'b', name: 'Dips', load: 'bodyweight' }, { id: 'c', name: 'X', load: 'weird' }], plans: [] });
  assert.deepEqual([data.exercises[0].load, data.exercises[0].bar], ['plates', 13.6]);
  assert.equal(data.exercises[1].load, 'bodyweight');
  assert.equal(data.exercises[2].load, undefined);
  assert.equal(data.settings.loadsSetUp, false);
});

test('session data line, this week and the closest milestone', () => {
  assert.equal(sessionDataText({ duration: 62, heartRate: 132, mood: 4 }), '62 min · ♥ 132 · 💪');
  assert.equal(sessionDataText({ duration: 45 }), '45 min');
  assert.equal(sessionDataText({ mood: 5 }), '🔥');
  assert.equal(sessionDataText({}), '');
  const now = new Date(2026, 10, 22, 9, 0); // Sunday
  const ss = [
    { id: 'a', planId: 'A', startedAt: new Date(2026, 10, 17, 18).toISOString(), finishedAt: 'x' },
    { id: 'b', planId: 'B', startedAt: new Date(2026, 10, 19, 18).toISOString(), finishedAt: 'x' },
    { id: 'c', planId: 'A', startedAt: new Date(2026, 10, 14, 18).toISOString(), finishedAt: 'x' },
    { id: 'd', planId: 'A', startedAt: new Date(2026, 10, 22, 8).toISOString(), finishedAt: null }
  ];
  const wk = thisWeek(ss, now);
  assert.deepEqual(wk.days.map((x) => x.date), [16, 17, 18, 19, 20, 21, 22]);
  assert.deepEqual(wk.days.map((x) => (x.session ? x.session.id : null)), [null, 'a', null, 'b', null, null, null]);
  assert.equal(wk.count, 2);
  assert.equal(closestMilestone([{ kind: 'workouts', progress: 0.8 }, { kind: 'lifted', progress: 0.3 }]).kind, 'workouts');
  assert.equal(daysBetween(new Date(2026, 10, 19, 23), new Date(2026, 10, 22, 1)), 3);
  assert.equal(agoText(0), 'today');
  assert.equal(agoText(1), 'yesterday');
  assert.equal(agoText(3), '3 days ago');
});

// ---------- 1.10.0: double progression ----------

import {
  createSession as cs110, startingSets as ss110, doubleReady, atTop, schemeChange as sc110, suggestIncrease as si110,
  sessionSummary as sum110, defaultRange, isDoubleEx, entryMode, startOpts, validateImport as vi110, DEFAULT_SETTINGS as DS110
} from '../js/logic.js';

const LP = { id: 'lp', name: 'Leg Press', equipment: 'machine', load: 'total', double: true, repMin: 6, repMax: 10 };
const FP = { id: 'fp', name: 'Face Pull', equipment: 'machine', load: 'total', double: false, repMin: 10, repMax: 15 };
const EXS110 = { lp: LP, fp: FP };
const PLAN110 = { id: 'b', items: [{ id: 'i1', exerciseId: 'lp', sets: 3, reps: 8, weight: null }, { id: 'i2', exerciseId: 'fp', sets: 3, reps: 12, weight: null }] };
let n110 = 0;
const done110 = (exerciseId, sets, mode, extra = {}) => ({ id: 'e' + (++n110), exerciseId, planItemId: exerciseId === 'lp' ? 'i1' : 'i2', kind: 'planned', status: 'done', doneAt: null, sets, ...(mode ? { mode } : {}), ...extra });
const sess110 = (day, entries, mode) => ({ id: 's' + day, planId: 'b', startedAt: '2026-11-' + day + 'T18:00:00Z', finishedAt: '2026-11-' + day + 'T19:00:00Z', entries, ...(mode ? { mode } : {}) });
const W = (w, reps) => reps.map((r) => ({ weight: w, reps: r }));

test('double progression: which exercises, the default range, the mode of an entry', () => {
  assert.equal(DS110.progression, 'classic');
  assert.equal(isDoubleEx(LP), true);
  assert.equal(isDoubleEx(FP), false, 'switched off');
  assert.equal(isDoubleEx({ double: true, repMin: 10, repMax: 6 }), false, 'invalid range');
  assert.equal(entryMode('double', LP), 'double');
  assert.equal(entryMode('double', FP), 'classic');
  assert.equal(entryMode('classic', LP), 'classic');
  assert.deepEqual(defaultRange(8), { min: 6, max: 10 });
  assert.deepEqual(defaultRange(12), { min: 10, max: 15 });
  assert.deepEqual(defaultRange(15), { min: 12, max: 20 });
});

test('starting values: Classic and Double kept apart; first time in Double = Classic weights, reps at the bottom', () => {
  const classic = sess110('10', [done110('lp', W(80, [8, 8, 8])), done110('fp', W(25, [12, 12, 12]))]);
  // First Double workout: weights from Classic, reps at 6; Face Pull as in Classic.
  let s = cs110(PLAN110, [classic], new Date('2026-11-12T18:00:00Z'), EXS110, 'double');
  assert.equal(s.mode, 'double');
  assert.deepEqual(s.entries.map((e) => e.mode), ['double', 'classic']);
  assert.deepEqual(s.entries[0].sets, W(80, [6, 6, 6]));
  assert.deepEqual(s.entries[1].sets, W(25, [12, 12, 12]));
  // After a Double workout: Double starts from it, Classic still from the last Classic one.
  const dbl = sess110('12', [done110('lp', W(85, [9, 8, 7]), 'double'), done110('fp', W(27.5, [12, 12, 12]), 'classic')], 'double');
  s = cs110(PLAN110, [classic, dbl], new Date('2026-11-14T18:00:00Z'), EXS110, 'double');
  assert.deepEqual(s.entries[0].sets, W(85, [9, 8, 7]));
  assert.deepEqual(s.entries[1].sets, W(27.5, [12, 12, 12]), 'Face Pull shares everything');
  s = cs110(PLAN110, [classic, dbl], new Date('2026-11-14T18:00:00Z'), EXS110, 'classic');
  assert.deepEqual(s.entries.map((e) => e.mode), ['classic', 'classic']);
  assert.deepEqual(s.entries[0].sets, W(80, [8, 8, 8]), 'Classic: last Classic weights, plan reps');
  // Only Double history so far: Classic falls back to it (weights), with the plan's reps.
  const onlyDbl = ss110(PLAN110.items[0], [dbl], startOpts('classic', LP, {}));
  assert.deepEqual(onlyDbl, W(85, [8, 8, 8]));
  // An extra set copies the last one, reps included.
  const four = ss110({ ...PLAN110.items[0], sets: 4 }, [dbl], startOpts('double', LP, {}));
  assert.deepEqual(four, W(85, [9, 8, 7, 7]));
});

test('top of the range: the message today, the reminder next time (weights unchanged)', () => {
  const today = { exerciseId: 'lp', status: 'open', mode: 'double', sets: W(85, [10, 10, 10]) };
  assert.equal(atTop(today, LP), true);
  assert.equal(atTop({ ...today, sets: W(85, [10, 10, 9]) }, LP), false);
  assert.equal(atTop({ ...today, mode: undefined }, LP), false, 'Classic entry');
  const last = sess110('12', [done110('lp', W(85, [10, 10, 10]), 'double')], 'double');
  const next = { exerciseId: 'lp', status: 'open', mode: 'double', sets: W(85, [10, 10, 10]) };
  const r = doubleReady([last], next, LP, 'now');
  assert.ok(r);
  assert.equal(r.max, 10);
  assert.equal(doubleReady([last], { ...next, sets: [{ weight: 87.5, reps: 10 }, ...W(85, [10, 10])] }, LP, 'now'), null, 'weight raised');
  assert.equal(doubleReady([last], { ...next, mode: 'classic' }, LP, 'now'), null);
  const notTop = sess110('12', [done110('lp', W(85, [10, 10, 9]), 'double')], 'double');
  assert.equal(doubleReady([notTop], next, LP, 'now'), null);
});

test('plan question in Double: only a different set count; Classic suggestion ignores Double', () => {
  const item = PLAN110.items[0];
  assert.equal(sc110({ kind: 'planned', mode: 'double', sets: W(80, [10, 9, 9]) }, item), null);
  const ch = sc110({ kind: 'planned', mode: 'double', sets: W(80, [10, 9, 9, 8]) }, item);
  assert.deepEqual([ch.to.sets, ch.to.reps, ch.setsOnly], [4, 8, true]);
  assert.ok(sc110({ kind: 'planned', sets: W(80, [10, 10, 10]) }, item), 'Classic still asks about reps');
  const c1 = sess110('08', [done110('lp', W(80, [8, 8, 8]))]);
  const c2 = sess110('10', [done110('lp', W(80, [8, 8, 8]))]);
  const d1 = sess110('12', [done110('lp', W(85, [6, 6, 6]), 'double')], 'double');
  const open = { kind: 'planned', status: 'open', exerciseId: 'lp', sets: W(80, [8, 8, 8]) };
  assert.equal(si110([c1, c2, d1], open, item, LP, 'now'), true, 'the last two Classic times count');
  assert.equal(si110([c1, c2], { ...open, mode: 'double' }, item, LP, 'now'), false);
});

test('summary of a Double workout: more reps at the same weight, compared within the mode', () => {
  const c = sess110('08', [done110('lp', W(90, [8, 8, 8]))]);
  const d1 = sess110('10', [done110('lp', W(85, [8, 8, 7]), 'double'), done110('fp', W(25, [12, 12, 12]), 'classic')], 'double');
  const d2 = sess110('12', [done110('lp', W(85, [10, 10, 10]), 'double'), done110('fp', W(25, [12, 12, 12]), 'classic')], 'double');
  const sum = sum110(d2, [c, d1, d2], EXS110, PLAN110);
  assert.equal(sum.mode, 'double');
  const lp = sum.rows.find((r) => r.exerciseId === 'lp');
  assert.equal(lp.delta, 0, 'same weight as the last Double time (not the Classic 90)');
  assert.equal(lp.repsDelta, 7);
  assert.equal(lp.atTop, true);
  assert.equal(lp.range, '6–10');
  assert.equal(sum.moreReps, 1);
  assert.equal(sum.same, 1);
  assert.equal(sum.records, 0, 'records count every workout: 90 kg in Classic is still the best');
});

test('backups keep Double progression and its range', () => {
  const data = vi110({ app: 'lift-happens', exercises: [{ id: 'a', name: 'Leg Press', double: true, repMin: 6, repMax: 10 }, { id: 'b', name: 'X', double: true, repMin: 10, repMax: 6 }], plans: [], settings: { progression: 'double' } });
  assert.deepEqual([data.exercises[0].double, data.exercises[0].repMin, data.exercises[0].repMax], [true, 6, 10]);
  assert.equal(data.exercises[1].double, undefined);
  assert.equal(data.settings.progression, 'double');
});
