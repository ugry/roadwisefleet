/**
 * Dependency-free unit tests for the GPS ingest contract (board #106, AND1-A4).
 * Runs in the no-install CI job `node --test apps/api/src/`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPS_MAX_BATCH,
  gpsStreamPayload,
  parseGpsBatch,
  parseGpsPoint,
  parseGpsTime,
} from './gps-ingest.js';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function validPoint(overrides = {}) {
  return { id: 'p1', lat: 52.1, lng: 13.4, at: new Date(NOW - 60_000).toISOString(), ...overrides };
}

test('parseGpsTime accepts epoch millis and ISO strings, rejects junk', () => {
  assert.equal(parseGpsTime(NOW), NOW);
  assert.equal(parseGpsTime(new Date(NOW).toISOString()), NOW);
  assert.equal(parseGpsTime('not-a-time'), null);
  assert.equal(parseGpsTime(null), null);
  assert.equal(parseGpsTime(Number.NaN), null);
});

test('parseGpsPoint normalizes a valid point to a Date and an integer accuracy', () => {
  const parsed = parseGpsPoint(validPoint({ accuracyM: 12.6 }), { now: NOW });
  assert.equal(parsed.ok, true);
  assert.ok(parsed.point.at instanceof Date);
  assert.equal(parsed.point.at.getTime(), NOW - 60_000);
  assert.equal(parsed.point.accuracyM, 13);
  assert.equal(parsed.point.clientId, 'p1');
});

test('parseGpsPoint is fail-fast on the first bad field', () => {
  const cases = [
    [{ ...validPoint(), lat: 91 }, 'points[].lat_out_of_range'],
    [{ ...validPoint(), lng: -181 }, 'points[].lng_out_of_range'],
    [{ ...validPoint(), id: '' }, 'points[].id_required'],
    [{ ...validPoint(), at: 'nope' }, 'points[].at_invalid'],
    [{ ...validPoint(), accuracyM: -1 }, 'points[].accuracy_invalid'],
  ];
  for (const [point, detail] of cases) {
    const parsed = parseGpsPoint(point, { now: NOW });
    assert.equal(parsed.ok, false, detail);
    assert.equal(parsed.detail, detail);
  }
});

test('a timestamp far in the future is a clock problem, small skew is tolerated', () => {
  const skewed = parseGpsPoint(validPoint({ at: new Date(NOW + 5 * 60_000).toISOString() }), { now: NOW });
  assert.equal(skewed.ok, true, 'a 5-minute skew is accepted');
  const future = parseGpsPoint(validPoint({ at: new Date(NOW + 60 * 60_000).toISOString() }), { now: NOW });
  assert.equal(future.ok, false);
  assert.equal(future.detail, 'points[].at_in_future');
});

test('parseGpsBatch rejects an empty or oversized batch', () => {
  assert.deepEqual(parseGpsBatch({ points: [] }, { now: NOW }), {
    ok: false,
    error: 'invalid_gps',
    detail: 'points.empty',
  });
  const big = { points: Array.from({ length: GPS_MAX_BATCH + 1 }, (_, i) => validPoint({ id: `p${i}` })) };
  const parsed = parseGpsBatch(big, { now: NOW });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.detail, 'points.batch_too_large');
});

test('parseGpsBatch collapses duplicate client ids (oldest first) so the insert cannot self-collide', () => {
  const body = {
    points: [
      validPoint({ id: 'dup', at: new Date(NOW - 120_000).toISOString() }),
      validPoint({ id: 'other' }),
      validPoint({ id: 'dup', at: new Date(NOW - 60_000).toISOString() }),
    ],
  };
  const parsed = parseGpsBatch(body, { now: NOW });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.points.length, 2);
  assert.equal(parsed.duplicates, 1);
  assert.deepEqual(parsed.points.map((p) => p.clientId), ['dup', 'other']);
  // first-wins: the surviving dup is the earlier of the two
  assert.equal(parsed.points[0].at.getTime(), NOW - 120_000);
});

test('parseGpsBatch requires the points array and reports the first bad point', () => {
  assert.equal(parseGpsBatch(null, { now: NOW }).detail, 'body.object_required');
  assert.equal(parseGpsBatch({}, { now: NOW }).detail, 'points.array_required');
  assert.equal(parseGpsBatch({ points: [validPoint(), { id: 'x', lat: 999, lng: 0, at: NOW }] }, { now: NOW }).detail, 'points[].lat_out_of_range');
});

test('gpsStreamPayload is PII-free position data only', () => {
  const payload = gpsStreamPayload({ clientId: 'p1', at: new Date(NOW), lat: '52.1', lng: '13.4', accuracyM: 8 });
  assert.deepEqual(payload, { id: 'p1', at: new Date(NOW).toISOString(), lat: 52.1, lng: 13.4, accuracyM: 8 });
});
