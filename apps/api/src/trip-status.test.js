import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRIP_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  DRIVER_PHASES,
  START_TRIP_STATUS,
  ACTIVE_ASSIGNMENT_STATUSES,
  isTripStatus,
  nextStatuses,
  canTransition,
  isTerminal,
  isActiveAssignment,
} from './trip-status.js';

// The documented state machine (docs/diagrams-data-menu-flow.md §7) as
// [from, to] pairs. Everything not listed here must be rejected.
// The driver phases (board task #105, AND1-A3) extend the machine; the legacy
// jump edges (ASSIGNED → LOADED, IN_TRANSIT → DELIVERED) are kept.
const VALID_TRANSITIONS = [
  ['DRAFT', 'ASSIGNED'],
  ['ASSIGNED', 'EN_ROUTE'],
  ['EN_ROUTE', 'AT_PICKUP'],
  ['AT_PICKUP', 'LOADED'],
  ['ASSIGNED', 'LOADED'],
  ['LOADED', 'IN_TRANSIT'],
  ['IN_TRANSIT', 'AT_DELIVERY'],
  ['AT_DELIVERY', 'DELIVERED'],
  ['IN_TRANSIT', 'DELIVERED'],
  ['DELIVERED', 'POD_UPLOADED'],
  ['POD_UPLOADED', 'INVOICED'],
  ['INVOICED', 'SETTLED'],
  ['DRAFT', 'CANCELLED'],
  ['ASSIGNED', 'CANCELLED'],
];

test('accepts every documented transition', () => {
  for (const [from, to] of VALID_TRANSITIONS) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to} must be allowed`);
  }
});

test('rejects transitions that skip a step', () => {
  const illegal = [
    ['DRAFT', 'SETTLED'],
    ['DRAFT', 'LOADED'],
    ['DRAFT', 'IN_TRANSIT'],
    ['ASSIGNED', 'IN_TRANSIT'],
    ['ASSIGNED', 'DELIVERED'],
    ['LOADED', 'DELIVERED'],
    ['IN_TRANSIT', 'POD_UPLOADED'],
    ['DELIVERED', 'INVOICED'],
    ['POD_UPLOADED', 'SETTLED'],
  ];
  for (const [from, to] of illegal) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to} must be rejected`);
  }
});

test('rejects backwards transitions', () => {
  const backwards = [
    ['ASSIGNED', 'DRAFT'],
    ['LOADED', 'ASSIGNED'],
    ['IN_TRANSIT', 'LOADED'],
    ['DELIVERED', 'IN_TRANSIT'],
    ['POD_UPLOADED', 'DELIVERED'],
    ['INVOICED', 'POD_UPLOADED'],
    ['SETTLED', 'INVOICED'],
  ];
  for (const [from, to] of backwards) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to} must be rejected`);
  }
});

test('rejects no-op transitions', () => {
  for (const status of TRIP_STATUSES) {
    assert.equal(canTransition(status, status), false, `${status} -> ${status} must be rejected`);
  }
});

test('CANCELLED is reachable only from DRAFT and ASSIGNED', () => {
  const cancellable = TRIP_STATUSES.filter((status) => canTransition(status, 'CANCELLED'));
  assert.deepEqual(cancellable, ['DRAFT', 'ASSIGNED']);
});

test('terminal states have no outgoing transitions', () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['CANCELLED', 'SETTLED']);

  for (const status of TERMINAL_STATUSES) {
    assert.equal(isTerminal(status), true, `${status} must be terminal`);
    assert.deepEqual([...nextStatuses(status)], []);
    for (const to of TRIP_STATUSES) {
      assert.equal(canTransition(status, to), false, `${status} -> ${to} must be rejected`);
    }
  }

  for (const status of TRIP_STATUSES) {
    if (!TERMINAL_STATUSES.includes(status)) {
      assert.equal(isTerminal(status), false, `${status} must not be terminal`);
      assert.notDeepEqual([...nextStatuses(status)], []);
    }
  }
});

test('rejects unknown statuses in either position', () => {
  for (const bogus of ['BOOKED', 'DISPATCHED', 'COMPLETED', '', 'draft', null, undefined, 42, {}]) {
    assert.equal(isTripStatus(bogus), false, `${String(bogus)} must not be a known status`);
  }
  assert.equal(canTransition('DRAFT', 'BOOKED'), false);
  assert.equal(canTransition('BOOKED', 'ASSIGNED'), false);
  assert.equal(canTransition(undefined, 'ASSIGNED'), false);
  assert.equal(canTransition('DRAFT', undefined), false);
  assert.deepEqual([...nextStatuses('BOOKED')], []);
});

test('transition table matches the documented state machine exhaustively', () => {
  const expected = new Set(VALID_TRANSITIONS.map(([from, to]) => `${from}->${to}`));
  for (const from of TRIP_STATUSES) {
    for (const to of TRIP_STATUSES) {
      const key = `${from}->${to}`;
      assert.equal(canTransition(from, to), expected.has(key), `unexpected result for ${key}`);
    }
  }
});

test('exposes each status exactly once', () => {
  assert.equal(new Set(TRIP_STATUSES).size, TRIP_STATUSES.length);
  assert.deepEqual(
    [...TRIP_STATUSES].sort(),
    [
      'ASSIGNED',
      'AT_DELIVERY',
      'AT_PICKUP',
      'CANCELLED',
      'DELIVERED',
      'DRAFT',
      'EN_ROUTE',
      'INVOICED',
      'IN_TRANSIT',
      'LOADED',
      'POD_UPLOADED',
      'SETTLED',
    ],
  );
  for (const status of TRIP_STATUSES) {
    assert.equal(isTripStatus(status), true);
  }
});

test('the transition table is immutable', () => {
  assert.throws(() => {
    /** @type {any} */ (TRANSITIONS).DRAFT = ['SETTLED'];
  }, TypeError);
  assert.deepEqual([...TRANSITIONS.DRAFT], ['ASSIGNED', 'CANCELLED']);
});

// --- driver phases (board task #105, AND1-A3) -------------------------------

test('the driver phase chain walks one legal step at a time', () => {
  // ASSIGNED → EN_ROUTE (Start Trip) → AT_PICKUP → LOADED → IN_TRANSIT →
  // AT_DELIVERY → DELIVERED → POD_UPLOADED
  const chain = [
    'ASSIGNED',
    'EN_ROUTE',
    'AT_PICKUP',
    'LOADED',
    'IN_TRANSIT',
    'AT_DELIVERY',
    'DELIVERED',
    'POD_UPLOADED',
  ];
  assert.deepEqual([...DRIVER_PHASES], chain);
  for (let i = 0; i < chain.length - 1; i += 1) {
    assert.equal(canTransition(chain[i], chain[i + 1]), true, `${chain[i]} -> ${chain[i + 1]}`);
  }
});

test('Start Trip is EN_ROUTE and EN_ROUTE is only reachable from ASSIGNED', () => {
  assert.equal(START_TRIP_STATUS, 'EN_ROUTE');
  const sources = TRIP_STATUSES.filter((status) => canTransition(status, 'EN_ROUTE'));
  assert.deepEqual(sources, ['ASSIGNED']);
  // A phase cannot be skipped on the new sub-path.
  assert.equal(canTransition('EN_ROUTE', 'LOADED'), false, 'must pass through AT_PICKUP');
});

test('the active-assignment statuses are the in-flight driver phases', () => {
  assert.deepEqual([...ACTIVE_ASSIGNMENT_STATUSES], [
    'ASSIGNED',
    'EN_ROUTE',
    'AT_PICKUP',
    'LOADED',
    'IN_TRANSIT',
    'AT_DELIVERY',
  ]);
  for (const status of ACTIVE_ASSIGNMENT_STATUSES) {
    assert.equal(isActiveAssignment(status), true, `${status} is active`);
  }
  for (const status of ['DRAFT', 'DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED', 'CANCELLED', 'NOPE', null]) {
    assert.equal(isActiveAssignment(status), false, `${String(status)} is not active`);
  }
});
