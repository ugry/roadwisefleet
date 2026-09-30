/**
 * Documents UI (board task #37, FAv1-F6) — dependency-free coverage for the
 * trip-detail documents panel's pure half (`app/lib/documents.js`) and the
 * markup/script drift it depends on.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): `node:*`
 * builtins only, no Fastify, no Prisma. The HTTP-level assertions live in
 * `apps/api/test/app-shell.test.ts` (`pnpm test:router`).
 *
 * The point of the panel is that the UI must not paraphrase the server's rules:
 * the shared lists (`DOC_TYPES`, `POD_DOC_TYPES`, `ALLOWED_MIME`) are asserted
 * equal to `documents.js`, and the checklist / POD gate are asserted to be the
 * *driver core's* answers, not a second implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import docs from '../../../app/lib/documents.js';
import driverCore from '../../../pilot/lib/driver-core.js';
import { DOC_TYPES, POD_DOC_TYPES, ALLOWED_MIME } from './documents.js';
import appCore from '../../../app/lib/app-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const appDir = join(repoRoot, 'app');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');

const APP_JS = readApp('app.js');
const PAGE = readApp('index.html');
const CATALOGUE = JSON.parse(readApp('locales/en.json'));
const PILOT_CORE_JS = readFileSync(join(repoRoot, 'pilot/lib/driver-core.js'), 'utf8');

// --- the shared rules are shared, not restated ------------------------------

test('the document and MIME lists mirror documents.js exactly', () => {
  assert.deepEqual(docs.DOC_TYPES, [...DOC_TYPES]);
  assert.deepEqual(docs.POD_DOC_TYPES, [...POD_DOC_TYPES]);
  assert.deepEqual(Object.keys(docs.ALLOWED_MIME).sort(), Object.keys(ALLOWED_MIME).sort());
  for (const [mime, ext] of Object.entries(ALLOWED_MIME)) {
    assert.equal(docs.ALLOWED_MIME[mime], ext, mime);
  }
  assert.equal(docs.DEFAULT_MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
});

test('the checklist and the POD gate come from the driver core', () => {
  const empty = [];
  const withEcmr = [{ id: 'd1', docType: 'ecmr', status: 'UPLOADED' }];
  const withPendingPod = [{ id: 'd2', docType: 'pod', status: 'PENDING' }];

  // The exact objects the core returns must be what the UI renders.
  assert.deepEqual(docs.checklistRows(empty, driverCore), driverCore.documentChecklist(empty));
  assert.equal(docs.requiredMissing(empty, driverCore), 1);
  assert.equal(docs.podSatisfied(empty, driverCore), false);
  // An eCMR satisfies the POD requirement just as a POD does.
  assert.equal(docs.requiredMissing(withEcmr, driverCore), 0);
  assert.equal(docs.podSatisfied(withEcmr, driverCore), true);
  // A PENDING POD is not "present" — the gate stays shut.
  assert.equal(docs.podSatisfied(withPendingPod, driverCore), false);
  assert.equal(docs.canMarkPodUploaded('DELIVERED', withEcmr, driverCore), true);
  assert.equal(docs.canMarkPodUploaded('DELIVERED', withPendingPod, driverCore), false);
  assert.equal(docs.canMarkPodUploaded('IN_TRANSIT', withEcmr, driverCore), false);

  // A missing core degrades to "nothing known", never to a false "satisfied".
  assert.deepEqual(docs.checklistRows(withEcmr, null), []);
  assert.equal(docs.podSatisfied(withEcmr, null), false);
  assert.equal(docs.canMarkPodUploaded('DELIVERED', withEcmr, null), false);
});

// --- pre-upload validation (the issue #38 white-screen fix) -----------------

test('an over-limit file is refused with the size and the limit', () => {
  const limit = docs.DEFAULT_MAX_UPLOAD_BYTES;
  const tooBig = docs.validateUpload({
    docType: 'pod',
    mimeType: 'image/jpeg',
    size: 31 * 1024 * 1024,
    maxBytes: limit,
  });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.field, 'file');
  assert.equal(tooBig.key, 'docs.error.tooLarge');
  assert.equal(tooBig.params.size, '31 MB');
  assert.equal(tooBig.params.max, '10 MB');
  // The message names both numbers and a remedy (coordinated with #49 wording).
  const message = CATALOGUE['docs.error.tooLarge'];
  assert.match(message, /\{size\}/);
  assert.match(message, /\{max\}/);
  assert.match(message, /smaller/i);

  // At the limit is fine; one byte over is not.
  assert.equal(docs.validateUpload({ docType: 'pod', mimeType: 'application/pdf', size: limit }).ok, true);
  assert.equal(docs.validateUpload({ docType: 'pod', mimeType: 'application/pdf', size: limit + 1 }).ok, false);
});

test('unsupported MIME and unknown doc types are refused before any request', () => {
  const badMime = docs.validateUpload({ docType: 'pod', mimeType: 'image/gif', size: 1000 });
  assert.equal(badMime.ok, false);
  assert.equal(badMime.field, 'file');
  assert.equal(badMime.key, 'docs.error.mime');

  const badType = docs.validateUpload({ docType: 'passport', mimeType: 'image/jpeg', size: 1000 });
  assert.equal(badType.ok, false);
  assert.equal(badType.field, 'docType');
  assert.equal(badType.key, 'docs.error.docType');

  const noFile = docs.validateUpload({ docType: 'pod', mimeType: 'image/jpeg', size: 0 });
  assert.equal(noFile.ok, false);
  assert.equal(noFile.key, 'docs.error.empty');

  const ok = docs.validateUpload({ docType: 'pod', mimeType: 'image/jpeg', size: 2048 });
  assert.deepEqual(ok.value, { docType: 'pod', mimeType: 'image/jpeg', size: 2048 });
});

test('formatBytes is human and stable', () => {
  assert.equal(docs.formatBytes(900), '900 B');
  assert.equal(docs.formatBytes(2048), '2 KB');
  assert.equal(docs.formatBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(docs.formatBytes(31 * 1024 * 1024), '31 MB');
  assert.equal(docs.formatBytes(1.5 * 1024 * 1024), '1.5 MB');
});

// --- roles ------------------------------------------------------------------

test('only trip:* roles may verify/reject, and a driver may only upload their own trip', () => {
  assert.equal(docs.canManageDocuments('owner'), true);
  assert.equal(docs.canManageDocuments('dispatcher'), true);
  assert.equal(docs.canManageDocuments('driver'), false);
  assert.equal(docs.canManageDocuments('accountant'), false);
  assert.equal(docs.canManageDocuments(undefined), false);

  assert.equal(docs.canUploadDocuments('owner', false), true);
  assert.equal(docs.canUploadDocuments('dispatcher', false), true);
  // A driver's upload needs the trip to be their own — the API enforces the same.
  assert.equal(docs.canUploadDocuments('driver', true), true);
  assert.equal(docs.canUploadDocuments('driver', false), false);
  assert.equal(docs.canUploadDocuments('driver', undefined), false);

  // Mirrors app-core's `trip:*` gate: the two must agree.
  assert.deepEqual(docs.MANAGE_ROLES.slice().sort(), appCore.TRIP_MANAGE_ROLES.slice().sort());
});

// --- payloads ---------------------------------------------------------------

test('paths encode the id so it can never change the request path', () => {
  assert.equal(docs.uploadPath('t1'), '/api/trips/t1/documents');
  assert.equal(docs.documentPath('d1'), '/api/documents/d1');
  assert.equal(docs.uploadPath('a/b?c'), '/api/trips/a%2Fb%3Fc/documents');
  assert.equal(docs.documentPath('a/b?c'), '/api/documents/a%2Fb%3Fc');
});

test('the upload body omits absent capture fields rather than sending null', () => {
  const minimal = docs.uploadPayload({
    docType: 'pod',
    filename: 'pod.jpg',
    mimeType: 'image/jpeg',
    dataBase64: 'AAAA',
  });
  assert.deepEqual(minimal, {
    docType: 'pod',
    filename: 'pod.jpg',
    mimeType: 'image/jpeg',
    dataBase64: 'AAAA',
  });
  assert.deepEqual(Object.keys(minimal).sort(), ['dataBase64', 'docType', 'filename', 'mimeType']);

  const captured = docs.uploadPayload({
    docType: 'pod',
    filename: 'pod.jpg',
    mimeType: 'image/jpeg',
    dataBase64: 'AAAA',
    capturedAt: '2026-09-25T10:00:00.000Z',
    geo: { lat: 52.1, lng: 13.4, accuracy: 12.6 },
  });
  assert.equal(captured.capturedAt, '2026-09-25T10:00:00.000Z');
  assert.deepEqual(captured.geo, { lat: 52.1, lng: 13.4, accuracy: 13 });
});

test('bad coordinates are dropped, not sent', () => {
  assert.equal(docs.normalizeGeo(null), null);
  assert.equal(docs.normalizeGeo({ lat: 'x', lng: 1 }), null);
  assert.equal(docs.normalizeGeo({ lat: 200, lng: 1 }), null);
  assert.equal(docs.normalizeGeo({ lat: 1, lng: 200 }), null);
  assert.deepEqual(docs.normalizeGeo({ lat: 1, lng: 2 }), { lat: 1, lng: 2 });
  const payload = docs.uploadPayload({
    docType: 'pod',
    filename: 'p.jpg',
    mimeType: 'image/jpeg',
    dataBase64: 'x',
    geo: { lat: 999, lng: 999 },
  });
  assert.equal('geo' in payload, false);
});

test('verifyPayload only ever allows VERIFIED or REJECTED', () => {
  assert.deepEqual(docs.verifyPayload('VERIFIED'), { status: 'VERIFIED' });
  assert.deepEqual(docs.verifyPayload('rejected'), { status: 'REJECTED' });
  assert.deepEqual(docs.verifyPayload('DELETED'), { status: 'VERIFIED' });
  assert.deepEqual(docs.verifyPayload(undefined), { status: 'VERIFIED' });
});

// --- error mapping ----------------------------------------------------------

test('API failures map to catalogue keys that say what to do', () => {
  assert.equal(docs.errorKey({ status: 401 }), 'error.sessionExpired');
  assert.equal(docs.errorKey({ status: 403, data: { error: 'forbidden' } }), 'error.forbidden');
  assert.equal(docs.errorKey({ status: 400, data: { error: 'unsupported_type' } }), 'docs.error.mime');
  assert.equal(docs.errorKey({ status: 400, data: { error: 'file_too_large' } }), 'docs.error.tooLargeServer');
  // A reverse-proxy 413 (unstyled HTML body) still reads as a message.
  assert.equal(docs.errorKey({ status: 413, data: null }), 'docs.error.tooLargeServer');
  assert.equal(docs.errorKey({ status: 429 }), 'error.rateLimited');
  assert.equal(docs.errorKey({ status: 0, data: { error: 'network' } }), 'error.network');
  assert.equal(docs.errorKey({ status: 400, data: { error: 'invalid_capture' } }), 'docs.error.capture');
  assert.equal(docs.errorKey({ status: 404, data: { error: 'not_found' } }), 'docs.error.notFound');
  assert.equal(docs.errorKey({ status: 500, data: null }), 'error.unexpected');
  // `request()` reports a transport failure as status 0; a bare null is that same
  // "no response" case (mirrors assign.js).
  assert.equal(docs.errorKey(null), 'error.network');
  assert.equal(docs.errorDetail({ data: { detail: 'max 10485760 bytes' } }), 'max 10485760 bytes');
  assert.equal(docs.errorDetail({ data: {} }), '');
});

test('the label entries cover every doc type the API accepts', () => {
  const entries = docs.docTypeEntries();
  assert.equal(entries.length, DOC_TYPES.length);
  for (const entry of entries) {
    assert.ok(DOC_TYPES.includes(entry.value), entry.value);
    assert.ok(entry.labelKey in CATALOGUE, `missing label ${entry.labelKey}`);
  }
  assert.equal(docs.statusKey('UPLOADED'), 'trips.docstatus.UPLOADED');
  assert.equal(docs.docTypeKey('pod'), 'trips.doctype.pod');
  for (const status of ['PENDING', 'UPLOADED', 'VERIFIED', 'REJECTED']) {
    assert.ok(docs.statusKey(status) in CATALOGUE, status);
  }
});

// --- catalogue / wiring drift -----------------------------------------------

test('every docs.* key the UI can show exists in the catalogue', () => {
  const sources = APP_JS + '\n' + readApp('lib/documents.js');
  const keys = new Set();
  for (const m of sources.matchAll(/'([a-zA-Z]+\.[a-zA-Z0-9_.]+)'/g)) {
    if (m[1].startsWith('docs.')) keys.add(m[1]);
  }
  assert.ok(keys.size >= 20, `expected many docs.* keys, saw ${keys.size}`);
  const missing = [...keys].filter((key) => !(key in CATALOGUE));
  assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);
});

test('the panel reuses the shared core and never leaks a storage key', () => {
  // The checklist is asked of the driver core, not re-derived here.
  assert.match(APP_JS, /DOC\.checklistRows/);
  assert.match(APP_JS, /DOC\.podSatisfied/);
  assert.match(APP_JS, /DRCORE/);
  // The document payload has no storageKey by construction; the UI must not
  // invent one or read one.
  assert.doesNotMatch(APP_JS, /storageKey/i);
  assert.doesNotMatch(readApp('lib/documents.js'), /storageKey/i);
  // Verify/reject render only behind the managing-role gate.
  assert.match(APP_JS, /DOC\.canManageDocuments/);
  assert.match(APP_JS, /data-doc-status="VERIFIED"/);
  assert.match(APP_JS, /data-doc-status="REJECTED"/);
  // Upload is validated against the shared file limit before any request.
  assert.match(APP_JS, /DOC\.validateUpload/);
  assert.match(APP_JS, /DOC\.uploadPath/);
  assert.match(APP_JS, /DOC\.documentPath/);
});

test('the app loads the documents module and the shared driver core', () => {
  assert.match(PAGE, /<script src="\/app\/lib\/documents\.js"><\/script>/);
  assert.match(PAGE, /<script src="\/pilot\/lib\/driver-core\.js"><\/script>/);
  assert.ok(existsSync(join(appDir, 'lib/documents.js')));
  // The shared core really owns the checklist (not a copy).
  assert.match(PILOT_CORE_JS, /function documentChecklist/);
  assert.match(PILOT_CORE_JS, /function canMarkPodUploaded/);
});

test('the /app/documents route is implemented, not a placeholder', () => {
  const route = appCore.routeForPath('/app/documents');
  assert.equal(route.view, 'documents');
  assert.equal(route.task, null);
  const panel = appCore.panelFor(route, (key, params) => `${key}${params && params.task ? '(' + params.task + ')' : ''}`);
  assert.equal(panel.body, 'common.loading');
  assert.equal(panel.task, null);
});
