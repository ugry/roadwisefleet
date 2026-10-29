/**
 * Self-test for the F2 matchers (`fa-f2-kpi.mjs`). Board task eila/tasks#145.
 *
 * The acceptance suite runs `selfTest()` inside F2 on every run, so a matcher
 * that stops discriminating turns the criterion red instead of quietly passing.
 * This file is the same contract under `node --test`, for local/CI use:
 *
 *   node --test apps/api/scripts/fa-f2-kpi.test.mjs
 *
 * Deliberately no database, no HTTP and no network: it tests only that each
 * matcher ACCEPTS the shape it is meant to accept and REJECTS the shapes this
 * criterion has been wrong about before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERED_STATUSES,
  TERMINAL_STATUSES,
  checkAlertLinks,
  kpiOf,
  onTimeFromRows,
  reconcileActiveTrips,
  reconcileOnTime,
  reconcilePendingPay,
  selfTest,
  unwrapDashboard,
} from './fa-f2-kpi.mjs';

test('every self-test case discriminates (the whole point of the module)', () => {
  const report = selfTest();
  const failing = report.rows.filter((r) => !r.ok);
  assert.deepEqual(failing, [], `self-test case(s) failed: ${failing.map((r) => `${r.name} (${r.evidence})`).join('; ')}`);
  assert.ok(report.ok);
});

test('unwrapDashboard unwraps {dashboard} exactly once and accepts a bare payload', () => {
  assert.equal(unwrapDashboard({ dashboard: { kpis: { activeTrips: { value: 7 } } } }).kpis.activeTrips.value, 7);
  assert.equal(unwrapDashboard({ kpis: { activeTrips: { value: 9 } } }).kpis.activeTrips.value, 9);
  assert.deepEqual(unwrapDashboard({ dashboard: 'nope' }).dashboard, 'nope');
  assert.deepEqual(unwrapDashboard(null), {});
  assert.equal(kpiOf({ kpis: { onTimePct: null } }, 'onTimePct'), null);
});

test('activeTrips reconciles against the non-terminal count, not against all trips', () => {
  assert.ok(reconcileActiveTrips({ value: 48 }, 48).ok);
  // The bug this task exists for: comparing the KPI against every trip. A
  // CANCELLED/SETTLED trip makes the two counts differ, so the wrong
  // expectation must be rejected rather than silently accepted.
  assert.equal(reconcileActiveTrips({ value: 48 }, 50).ok, false);
  assert.equal(reconcileActiveTrips({}, 0).ok, false);
  assert.deepEqual(TERMINAL_STATUSES, ['SETTLED', 'CANCELLED']);
});

test('on-time is derived from timestamps and is null — never 0 — with no sample', () => {
  const none = onTimeFromRows([]);
  assert.equal(none.value, null);
  assert.equal(none.sample, 0);

  const mixed = onTimeFromRows([
    { deliveredAt: '2026-05-01T10:00:00Z', plannedAt: '2026-05-01T12:00:00Z' }, // on time
    { deliveredAt: '2026-05-01T13:00:00Z', plannedAt: '2026-05-01T12:00:00Z' }, // late
    { deliveredAt: '2026-05-01T10:00:00Z', plannedAt: null }, // not comparable
    { deliveredAt: null, plannedAt: '2026-05-01T12:00:00Z' }, // not comparable
  ]);
  assert.deepEqual({ value: mixed.value, onTime: mixed.onTime, sample: mixed.sample }, { value: 50, onTime: 1, sample: 2 });

  // A server that renders "no comparable trip" as 0% is wrong, not merely odd.
  assert.equal(reconcileOnTime({ value: 0, onTime: 0, sample: 0 }, none).ok, false);
  assert.ok(reconcileOnTime({ value: null, onTime: 0, sample: 0 }, none).ok);
  assert.equal(reconcileOnTime({ value: 50.4, onTime: 1, sample: 2 }, mixed).ok, false);
});

test('pendingPayEur reconciles a Prisma Decimal string numerically', () => {
  assert.ok(reconcilePendingPay({ value: '1234.5', count: 3 }, { value: 1234.5, count: 3 }).ok);
  assert.equal(reconcilePendingPay({ value: '1234.5', count: 2 }, { value: 1234.5, count: 3 }).ok, false);
  assert.equal(reconcilePendingPay({ value: null, count: 0 }, { value: 0, count: 0 }).ok, false);
});

test('an alert passes only when its link resolves AND names the trip it carries', () => {
  const alert = { id: 'unassigned:t1', kind: 'trip_unassigned', tripId: 't1', link: '/app/trips/t1' };
  const opts = { tripIds: ['t1'], linkStatus: { '/app/trips/t1': 200 }, orgId: 'org-1' };
  assert.ok(checkAlertLinks([alert], opts).ok);

  // names a different trip than the one it carries
  assert.equal(checkAlertLinks([{ ...alert, link: '/app/trips/t2' }], opts).ok, false);
  // carries a trip the org does not own
  assert.equal(checkAlertLinks([{ ...alert, tripId: 'foreign', link: '/app/trips/foreign' }], opts).ok, false);
  // route is dead
  assert.equal(checkAlertLinks([alert], { ...opts, linkStatus: { '/app/trips/t1': 404 } }).ok, false);
  // never probed over HTTP — absence of evidence is not a pass
  assert.equal(checkAlertLinks([alert], { ...opts, linkStatus: {} }).ok, false);
  // empty list must not pass vacuously
  assert.equal(checkAlertLinks([], opts).ok, false);
});

test('DELIVERED_STATUSES matches the payload contract the suite reconciles against', () => {
  assert.deepEqual(DELIVERED_STATUSES, ['DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED']);
});
