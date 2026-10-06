/**
 * Pilot dashboard status parity (board task #117, item A).
 *
 * `pilot/dashboard.html` renders the dispatcher's transition buttons from a
 * hand-written `TRANSITIONS` mirror of `apps/api/src/trip-status.js`. The mirror
 * silently drifted behind the API when the driver phases (board task #105)
 * landed: the dashboard could not click through EN_ROUTE / AT_PICKUP /
 * AT_DELIVERY, so a trip the driver had already started could no longer be
 * advanced by the dispatcher.
 *
 * This dependency-free guard runs under the no-install CI job
 * (`node --test apps/api/src/`) and fails the build if the mirror and the API
 * machine ever disagree again. It also proves every status the machine can
 * produce has a human label in each pilot locale (the new phases must render
 * words, not raw tokens).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { TRANSITIONS as API_TRANSITIONS, TRIP_STATUSES } from './trip-status.js';

const PILOT = new URL('../../../pilot/', import.meta.url);

/** Parse the `var TRANSITIONS = { … };` object out of the dashboard page. */
function dashboardTransitions(html) {
  const m = /var TRANSITIONS = (\{[\s\S]*?\n {2}\});/.exec(html);
  assert.ok(m, 'pilot/dashboard.html must define `var TRANSITIONS = { … };`');
  // The literal is data only (no identifiers/expressions), so evaluating it in
  // an empty context is safe and reads exactly what the browser will see.
  // JSON round-trip it into this realm: `deepStrictEqual` compares prototypes,
  // and a vm-created Array inherits a different Array.prototype.
  return JSON.parse(JSON.stringify(vm.runInNewContext('(' + m[1] + ')')));
}

test('the pilot dashboard transition mirror equals the API state machine', async () => {
  const html = await readFile(new URL('dashboard.html', PILOT), 'utf8');
  const mirror = dashboardTransitions(html);

  // Deep equality on the whole adjacency list, key by key — a missing phase, an
  // extra edge or a wrong order is a failure.
  assert.deepEqual(
    Object.keys(mirror).sort(),
    Object.keys(API_TRANSITIONS).sort(),
    'the mirror must name exactly the API statuses',
  );
  for (const status of Object.keys(API_TRANSITIONS)) {
    assert.deepEqual(
      mirror[status],
      [...API_TRANSITIONS[status]],
      `TRANSITIONS.${status} must match apps/api/src/trip-status.js`,
    );
  }
});

test('the new driver phases are reachable from the dashboard mirror', async () => {
  const html = await readFile(new URL('dashboard.html', PILOT), 'utf8');
  const mirror = dashboardTransitions(html);

  // The regression the issue reports: these three buttons are the dispatcher's
  // only way to follow a driver who is mid-job.
  assert.ok(mirror.ASSIGNED.includes('EN_ROUTE'), 'ASSIGNED offers EN_ROUTE (Start trip)');
  assert.ok(mirror.EN_ROUTE.includes('AT_PICKUP'), 'EN_ROUTE offers AT_PICKUP');
  assert.ok(mirror.AT_PICKUP.includes('LOADED'));
  assert.ok(mirror.IN_TRANSIT.includes('AT_DELIVERY'), 'IN_TRANSIT offers AT_DELIVERY');
  assert.ok(mirror.AT_DELIVERY.includes('DELIVERED'));
  // The legacy jump edges stay, so pre-phase trips keep working.
  assert.ok(mirror.ASSIGNED.includes('LOADED'));
  assert.ok(mirror.IN_TRANSIT.includes('DELIVERED'));
});

test('every machine status has a human label in all four pilot locales', async () => {
  for (const locale of ['en', 'de', 'pl', 'tr']) {
    const raw = await readFile(new URL(`${locale}.json`, new URL('locales/', PILOT)), 'utf8');
    const cat = JSON.parse(raw);
    for (const status of TRIP_STATUSES) {
      const key = 'status.' + status;
      assert.equal(
        typeof cat[key],
        'string',
        `${locale}.json is missing ${key} — the new phase would render as a raw token`,
      );
      assert.ok(cat[key].length > 0, `${locale}.json ${key} must not be empty`);
    }
  }
});
