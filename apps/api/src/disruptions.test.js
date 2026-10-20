/**
 * Alternate endings A3–A6 (board task #127, UXF-O4) — dependency-free guard.
 *
 * Diagram 07 is the specification: four designed exits, each with exactly one
 * source status and one documented recovery edge. The server owns the rules
 * (`trip-status.js`); the surfaces read `pilot/lib/disruptions.js`. This test
 * fails the build if the two tables drift, if a surface stops loading the shared
 * module, or if an ending ships without a human label in a catalogue.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): node builtins
 * plus the CJS view model and the ESM state machine only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import DISRUPT from '../../../pilot/lib/disruptions.js';
import {
  DISRUPTION_RESUME,
  DISRUPTION_SOURCES,
  DISRUPTION_STATUSES,
  DRIVER_REPORTABLE_ENDINGS,
} from './trip-status.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const read = (name) => readFileSync(resolve(repo, name), 'utf8');

test('the shared ending table mirrors the server sources and recovery edges', () => {
  assert.deepEqual([...DISRUPT.ENDING_STATUSES], [...DISRUPTION_STATUSES]);
  for (const status of DISRUPTION_STATUSES) {
    const entry = DISRUPT.ending(status);
    assert.ok(entry, `${status} is in the shared table`);
    assert.deepEqual(entry.sources, [...DISRUPTION_SOURCES[status]], `${status} sources`);
    assert.equal(entry.resumeTo, DISRUPTION_RESUME[status], `${status} recovery`);
    assert.equal(
      entry.reportable,
      DRIVER_REPORTABLE_ENDINGS.includes(status),
      `${status} reportable flag`,
    );
    assert.equal(DISRUPT.resumeTo(status), DISRUPTION_RESUME[status]);
  }
  assert.equal(DISRUPT.ending('NOPE'), null);
  assert.equal(DISRUPT.isEnding('IN_TRANSIT'), false);
  assert.equal(DISRUPT.resumeTo('IN_TRANSIT'), null);
});

test('the table hands back fresh objects, never its internal records', () => {
  const first = DISRUPT.ending('REFUSED');
  first.sources.push('DRAFT');
  first.status = 'CANCELLED';
  assert.deepEqual(DISRUPT.ending('REFUSED').sources, ['AT_PICKUP']);
  assert.equal(DISRUPT.ending('REFUSED').status, 'REFUSED');
  const list = DISRUPT.actionsFrom('AT_PICKUP', { carrier: true });
  list.push({ to: 'SETTLED', kind: 'ending' });
  assert.deepEqual(DISRUPT.actionsFrom('AT_PICKUP', { carrier: true }), [
    { to: 'REFUSED', kind: 'ending' },
  ]);
});

test('actionsFrom offers the documented exit and the one recovery, by actor', () => {
  // A carrier (FM / dispatcher / solo acting as their own carrier) sees all four.
  assert.deepEqual(DISRUPT.actionsFrom('AT_PICKUP', { carrier: true }), [
    { to: 'REFUSED', kind: 'ending' },
  ]);
  assert.deepEqual(DISRUPT.actionsFrom('EN_ROUTE', { carrier: true }), [
    { to: 'BREAKDOWN', kind: 'ending' },
  ]);
  assert.deepEqual(DISRUPT.actionsFrom('IN_TRANSIT', { carrier: true }), [
    { to: 'DELAYED', kind: 'ending' },
  ]);
  assert.deepEqual(DISRUPT.actionsFrom('AT_DELIVERY', { carrier: true }), [
    { to: 'CUSTOMS_HOLD', kind: 'ending' },
  ]);
  for (const status of DISRUPTION_STATUSES) {
    assert.deepEqual(
      DISRUPT.actionsFrom(status, { carrier: true }),
      [{ to: DISRUPTION_RESUME[status], kind: 'resume' }],
      `${status} offers only its recovery`,
    );
    assert.deepEqual(DISRUPT.actionsFrom(status), [], `${status} offers a driver nothing`);
  }
  // An employed driver may report only REFUSED / BREAKDOWN.
  assert.deepEqual(DISRUPT.actionsFrom('IN_TRANSIT'), [], 'DELAYED is not a driver report');
  assert.deepEqual(DISRUPT.actionsFrom('AT_DELIVERY'), [], 'CUSTOMS_HOLD is not a driver report');
  assert.deepEqual(DISRUPT.actionsFrom('AT_PICKUP'), [{ to: 'REFUSED', kind: 'ending' }]);
  assert.deepEqual(DISRUPT.actionsFrom('EN_ROUTE'), [{ to: 'BREAKDOWN', kind: 'ending' }]);
  // No invented exit from an unrelated status.
  assert.deepEqual(DISRUPT.actionsFrom('DRAFT', { carrier: true }), []);
  assert.deepEqual(DISRUPT.actionsFrom('DELIVERED', { carrier: true }), []);
});

test('both surfaces load the shared table and use it', () => {
  const appHtml = read('app/index.html');
  const soloHtml = read('solo/index.html');
  assert.match(appHtml, /<script src="\/pilot\/lib\/disruptions\.js"><\/script>\s*<script src="\/app\/lib\/dispatch\.js">/);
  assert.match(soloHtml, /<script src="\/pilot\/lib\/disruptions\.js"><\/script>\s*<script type="module" src="\/s\/solo\.js">/);

  const appJs = read('app/app.js');
  assert.match(appJs, /RoadwiseDisruptions/);
  assert.match(appJs, /DISRUPT\.actionsFrom/, 'the FM panel drives its buttons from the shared table');
  assert.match(appJs, /data-ending-to=/, 'the FM panel posts the ending through the status route');
  assert.match(appJs, /\/status/, 'the ending uses the existing transition endpoint');

  const soloJs = read('solo/solo.js');
  assert.match(soloJs, /RoadwiseDisruptions/);
  assert.match(soloJs, /DISRUPT\.actionsFrom/, 'the solo surface drives its buttons from the shared table');
  assert.match(soloJs, /action === 'ending'/, 'the solo surface wires the ending action');
});

test('every ending has a human label in every surface catalogue', () => {
  const catalogues = {
    'app/locales/en.json': 'trips.status.',
    'app/locales/de.json': 'trips.status.',
    'app/locales/pl.json': 'trips.status.',
    'app/locales/tr.json': 'trips.status.',
    'solo/locales/en.json': 'status.',
    'customer/locales/en.json': 'status.',
    'pilot/locales/en.json': 'status.',
    'pilot/locales/de.json': 'status.',
    'pilot/locales/pl.json': 'status.',
    'pilot/locales/tr.json': 'status.',
  };
  for (const [file, prefix] of Object.entries(catalogues)) {
    const cat = JSON.parse(read(file));
    for (const status of DISRUPTION_STATUSES) {
      const key = prefix + status;
      assert.equal(typeof cat[key], 'string', `${file} is missing ${key}`);
      assert.ok(cat[key].length > 0, `${file} ${key} must not be empty`);
      assert.notEqual(cat[key], status, `${file} ${key} must not render the raw token`);
    }
  }
});
