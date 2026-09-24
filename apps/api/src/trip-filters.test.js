/**
 * Trip-list filters (board task #34, FAv1-F3) — dependency-free coverage for
 * `src/trip-filters.js`. Runs under the no-install CI job (`node --test
 * apps/api/src/`): no Fastify, no Prisma, no database.
 *
 * The acceptance criterion this file protects is "filters combine correctly":
 * each filter is asserted alone, then two at once, then all of them, and every
 * rejection path (unknown status, bad date, inverted range, over-long text).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_QUERY_LENGTH, buildTripWhere, parseTripFilters, serializeTripFilters } from './trip-filters.js';

test('no query means no filters and the unchanged org-only where clause', () => {
  const parsed = parseTripFilters(undefined);
  assert.deepEqual(parsed, { ok: true, filters: {} });
  assert.deepEqual(buildTripWhere({ orgId: 'org1' }), { orgId: 'org1' });
  assert.deepEqual(buildTripWhere({ orgId: 'org1', filters: {} }), { orgId: 'org1' });
});

test('a single status is accepted', () => {
  const parsed = parseTripFilters({ status: 'IN_TRANSIT' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.filters.statuses, ['IN_TRANSIT']);
  assert.deepEqual(buildTripWhere({ orgId: 'org1', filters: parsed.filters }), {
    orgId: 'org1',
    status: { in: ['IN_TRANSIT'] },
  });
});

test('comma-separated and repeated statuses are merged and de-duplicated', () => {
  const parsed = parseTripFilters({ status: 'DRAFT,ASSIGNED', });
  assert.deepEqual(parsed.filters.statuses, ['DRAFT', 'ASSIGNED']);
  const repeated = parseTripFilters({ status: ['DELIVERED', 'DRAFT,DELIVERED'] });
  assert.deepEqual(repeated.filters.statuses, ['DELIVERED', 'DRAFT']);
});

test('an unknown status is rejected, never silently dropped', () => {
  for (const bad of ['BOOKED', 'DRAFT,NOPE', { x: 1 }]) {
    const parsed = parseTripFilters({ status: bad });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, 'invalid_filter');
    assert.equal(parsed.detail, 'status');
  }
});

test('driverId is trimmed and empty means "no filter"', () => {
  assert.deepEqual(parseTripFilters({ driverId: '  d1 ' }).filters, { driverId: 'd1' });
  assert.deepEqual(parseTripFilters({ driverId: '   ' }).filters, {});
  assert.deepEqual(buildTripWhere({ orgId: 'o', filters: { driverId: 'd1' } }), { orgId: 'o', driverId: 'd1' });
});

test('a date-only range covers the whole UTC day', () => {
  const parsed = parseTripFilters({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.filters.from.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(parsed.filters.to.toISOString(), '2026-09-30T23:59:59.999Z');
  const where = buildTripWhere({ orgId: 'o', filters: parsed.filters });
  assert.equal(where.createdAt.gte.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(where.createdAt.lte.toISOString(), '2026-09-30T23:59:59.999Z');
});

test('a full ISO timestamp is used as given', () => {
  const parsed = parseTripFilters({ from: '2026-09-01T08:30:00.000Z' });
  assert.equal(parsed.filters.from.toISOString(), '2026-09-01T08:30:00.000Z');
  assert.equal(parsed.filters.to, undefined);
});

test('bad dates and an inverted range are rejected', () => {
  for (const bad of [{ from: 'yesterday' }, { to: '2026-13-40' }]) {
    const parsed = parseTripFilters(bad);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.detail, Object.keys(bad)[0]);
  }
  const inverted = parseTripFilters({ from: '2026-09-30', to: '2026-09-01' });
  assert.deepEqual(inverted, { ok: false, error: 'invalid_filter', detail: 'range' });
});

test('free text builds one case-insensitive OR over route, customer and driver', () => {
  const parsed = parseTripFilters({ q: '  Berlin ' });
  assert.deepEqual(parsed.filters, { q: 'Berlin' });
  const where = buildTripWhere({ orgId: 'o', filters: parsed.filters });
  assert.deepEqual(where.OR, [
    { order: { origin: { contains: 'Berlin', mode: 'insensitive' } } },
    { order: { destination: { contains: 'Berlin', mode: 'insensitive' } } },
    { order: { cargo: { contains: 'Berlin', mode: 'insensitive' } } },
    { order: { customer: { name: { contains: 'Berlin', mode: 'insensitive' } } } },
    { driver: { name: { contains: 'Berlin', mode: 'insensitive' } } },
  ]);
});

test('an over-long free-text query is rejected', () => {
  const parsed = parseTripFilters({ q: 'x'.repeat(MAX_QUERY_LENGTH + 1) });
  assert.deepEqual(parsed, { ok: false, error: 'invalid_filter', detail: 'q' });
});

test('two filters combine with AND, and every filter combines at once', () => {
  const two = parseTripFilters({ status: 'IN_TRANSIT', driverId: 'd1' });
  assert.deepEqual(buildTripWhere({ orgId: 'o', filters: two.filters }), {
    orgId: 'o',
    status: { in: ['IN_TRANSIT'] },
    driverId: 'd1',
  });

  const all = parseTripFilters({ status: 'DRAFT,CANCELLED', driverId: 'd1', from: '2026-09-01', to: '2026-09-30', q: 'Berlin' });
  const where = buildTripWhere({ orgId: 'org9', filters: all.filters });
  assert.equal(where.orgId, 'org9');
  assert.deepEqual(where.status, { in: ['DRAFT', 'CANCELLED'] });
  assert.equal(where.driverId, 'd1');
  assert.equal(where.createdAt.gte.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(where.createdAt.lte.toISOString(), '2026-09-30T23:59:59.999Z');
  assert.equal(where.OR.length, 5);
});

test('serializeTripFilters echoes the applied filters as strings', () => {
  const parsed = parseTripFilters({ status: 'DRAFT,ASSIGNED', driverId: 'd1', from: '2026-09-01', q: 'x' });
  assert.deepEqual(serializeTripFilters(parsed.filters), {
    status: 'DRAFT,ASSIGNED',
    driverId: 'd1',
    from: '2026-09-01T00:00:00.000Z',
    q: 'x',
  });
  assert.deepEqual(serializeTripFilters(undefined), {});
});
