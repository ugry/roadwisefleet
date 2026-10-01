/**
 * Dependency-free unit tests for the realtime GPS hub (board #106, AND1-A4).
 * Runs in the no-install CI job `node --test apps/api/src/`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpsHub, formatSseEvent } from './gps-stream.js';

test('formatSseEvent renders a framed SSE event', () => {
  assert.equal(formatSseEvent('gps', { lat: 1 }), 'event: gps\ndata: {"lat":1}\n\n');
  assert.equal(formatSseEvent('ready', {}), 'event: ready\ndata: {}\n\n');
});

test('a subscriber receives only its own trip and unsubscribes cleanly', () => {
  const hub = createGpsHub();
  const a = [];
  const b = [];
  const off = hub.subscribe('trip-a', (p) => a.push(p));
  hub.subscribe('trip-b', (p) => b.push(p));
  assert.equal(hub.subscriberCount('trip-a'), 1);

  hub.publish('trip-a', { n: 1 });
  assert.deepEqual(a, [{ n: 1 }]);
  assert.deepEqual(b, []);

  off();
  off(); // idempotent
  hub.publish('trip-a', { n: 2 });
  assert.deepEqual(a, [{ n: 1 }]);
  assert.equal(hub.subscriberCount('trip-a'), 0);
  assert.deepEqual(hub.activeTrips(), ['trip-b']);
});

test('a broken listener cannot break the ingest or the other listeners', () => {
  const hub = createGpsHub();
  const seen = [];
  hub.subscribe('t', () => {
    throw new Error('boom');
  });
  hub.subscribe('t', (p) => seen.push(p));
  assert.doesNotThrow(() => hub.publish('t', { n: 1 }));
  assert.deepEqual(seen, [{ n: 1 }]);
  assert.equal(hub.subscriberCount('t'), 2);
});

test('publishing to a trip with no listeners is a no-op', () => {
  const hub = createGpsHub();
  assert.doesNotThrow(() => hub.publish('nobody', { n: 1 }));
  assert.deepEqual(hub.activeTrips(), []);
});
