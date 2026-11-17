// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, increase, decrease, startingSets, createSession, setsFromHistory,
  nextPlanAfter, plannedPlanId, sessionSummary, personalRecord, exerciseHistory, validateImport
} from '../js/logic.js';

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
