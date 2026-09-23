import test from 'node:test';
import assert from 'node:assert/strict';

import { PILOT_ORG_ID, PILOT_TRIP_IDS, planDemoReset } from './demo-reset.js';

test('keeps the seeded trips and removes everything else', () => {
  const trips = [
    { id: 'pilot-trip-1' },
    { id: 'cmuct8ise000jqn9slm4pk0qg' },
    { id: 'pilot-trip-2' },
    { id: 'cmuct2o0l0003qn9nrulmnsp3' },
  ];

  assert.deepEqual(planDemoReset(trips), {
    keep: ['pilot-trip-1', 'pilot-trip-2'],
    remove: ['cmuct8ise000jqn9slm4pk0qg', 'cmuct2o0l0003qn9nrulmnsp3'],
  });
});

test('preserves input order within each bucket', () => {
  const trips = [
    { id: 'residual-a' },
    { id: 'pilot-trip-2' },
    { id: 'residual-b' },
    { id: 'pilot-trip-1' },
  ];

  assert.deepEqual(planDemoReset(trips), {
    keep: ['pilot-trip-2', 'pilot-trip-1'],
    remove: ['residual-a', 'residual-b'],
  });
});

test('a clean dataset removes nothing', () => {
  const plan = planDemoReset([{ id: 'pilot-trip-1' }, { id: 'pilot-trip-2' }]);
  assert.deepEqual(plan, { keep: ['pilot-trip-1', 'pilot-trip-2'], remove: [] });
});

test('an empty or missing dataset is a no-op', () => {
  assert.deepEqual(planDemoReset([]), { keep: [], remove: [] });
  assert.deepEqual(planDemoReset(undefined), { keep: [], remove: [] });
});

test('ignores entries without a usable id and never schedules them for deletion', () => {
  const trips = [{}, { id: 42 }, { id: '' }, { id: null }, { id: undefined }, { id: 'pilot-trip-1' }];
  assert.deepEqual(planDemoReset(trips), { keep: ['pilot-trip-1'], remove: [] });
});

test('reports a repeated id once', () => {
  const trips = [{ id: 'residual-a' }, { id: 'residual-a' }, { id: 'pilot-trip-1' }];
  assert.deepEqual(planDemoReset(trips), { keep: ['pilot-trip-1'], remove: ['residual-a'] });
});

test('accepts a custom keep list', () => {
  assert.deepEqual(planDemoReset([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['b']), {
    keep: ['b'],
    remove: ['a', 'c'],
  });
});

test('does not mutate the caller-supplied keep list', () => {
  const keepIds = ['pilot-trip-1'];
  planDemoReset([{ id: 'pilot-trip-1' }, { id: 'other' }], keepIds);
  assert.deepEqual(keepIds, ['pilot-trip-1']);
});

test('the seed contract constants are stable and frozen', () => {
  assert.equal(PILOT_ORG_ID, 'pilot-org');
  assert.deepEqual([...PILOT_TRIP_IDS], ['pilot-trip-1', 'pilot-trip-2']);
  assert.throws(() => PILOT_TRIP_IDS.push('pilot-trip-3'), TypeError);
});
