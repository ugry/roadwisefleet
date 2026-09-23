import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildStorageKey,
  canManageDocuments,
  canUploadDocument,
  canViewTripDocuments,
  createDocument,
  decodeBase64Upload,
  hasPodDocument,
  listTripDocuments,
  normalizeCapture,
  normalizeDocumentStatus,
  removeDocumentFile,
  resolveWithin,
  sanitizeFilename,
  shapeDocument,
  updateDocumentStatus,
  validateDocumentUpload,
  writeDocumentFile,
} from './documents.js';

const OWNER = { userId: 'admin', permissions: ['trip:*'] };
const DISPATCHER = { userId: 'disp', permissions: ['trip:*'] };
const DRIVER1 = { userId: 'd1', permissions: ['trip:read', 'trip:status', 'pod:upload'] };
const DRIVER2 = { userId: 'd2', permissions: ['trip:read', 'trip:status', 'pod:upload'] };
const ACCOUNTANT = { userId: 'a1', permissions: ['invoice:*', 'reports:read'] };

const PNG = Buffer.from('not-really-a-png').toString('base64');

/** Minimal in-memory fake of the Prisma surface documents.js uses. */
function makeFakePrisma() {
  const state = {
    trips: [
      { id: 't1', orgId: 'org1', driverId: 'd1' },
      { id: 't2', orgId: 'org2', driverId: 'd9' },
    ],
    documents: /** @type {any[]} */ ([]),
  };
  return {
    state,
    trip: {
      findFirst: async ({ where }) =>
        state.trips.find((t) => t.id === where.id && t.orgId === where.orgId) ?? null,
    },
    document: {
      findMany: async ({ where }) => state.documents.filter((d) => d.tripId === where.tripId),
      findFirst: async ({ where }) => {
        const doc = state.documents.find((d) => d.id === where.id);
        if (!doc) return null;
        if (where.trip?.orgId) {
          const trip = state.trips.find((t) => t.id === doc.tripId);
          if (!trip || trip.orgId !== where.trip.orgId) return null;
        }
        return doc;
      },
      create: async ({ data }) => {
        const row = { createdAt: new Date(), ...data };
        state.documents.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const idx = state.documents.findIndex((d) => d.id === where.id);
        state.documents[idx] = { ...state.documents[idx], ...data };
        return state.documents[idx];
      },
      count: async ({ where }) =>
        state.documents.filter((d) => {
          if (d.tripId !== where.tripId) return false;
          if (where.docType?.in && !where.docType.in.includes(d.docType)) return false;
          if (where.status?.in && !where.status.in.includes(d.status)) return false;
          return true;
        }).length,
    },
  };
}

// --- pure validators ---

test('sanitizeFilename strips paths, control chars and leading dots', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('/a/b/pod photo.jpg'), 'pod-photo.jpg');
  assert.equal(sanitizeFilename('..'), '');
  assert.equal(sanitizeFilename('.hidden'), 'hidden');
  assert.equal(sanitizeFilename('bad\u0000name.png'), 'badname.png');
  assert.equal(sanitizeFilename(42), '');
  assert.equal(sanitizeFilename('a'.repeat(400)).length, 120);
});

test('validateDocumentUpload accepts a known type + allowed mime within the size cap', () => {
  const ok = validateDocumentUpload({
    docType: 'pod',
    filename: 'photo.JPG',
    mimeType: 'image/jpeg',
    size: 1234,
    maxBytes: 2048,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { docType: 'pod', filename: 'photo.JPG', mimeType: 'image/jpeg', ext: 'jpg', size: 1234 });
});

test('validateDocumentUpload rejects unknown types, bad mime, bad size and oversize', () => {
  assert.equal(validateDocumentUpload({ docType: 'nope', filename: 'a.png', mimeType: 'image/png', size: 1 }).error, 'invalid_doc_type');
  assert.equal(validateDocumentUpload({ docType: 'pod', filename: 'a.exe', mimeType: 'application/x-msdownload', size: 1 }).error, 'unsupported_type');
  assert.equal(validateDocumentUpload({ docType: 'pod', filename: '..', mimeType: 'image/png', size: 1 }).error, 'invalid_filename');
  assert.equal(validateDocumentUpload({ docType: 'pod', filename: 'a.png', mimeType: 'image/png', size: 0 }).error, 'invalid_size');
  assert.equal(validateDocumentUpload({ docType: 'pod', filename: 'a.png', mimeType: 'image/png', size: 1.5 }).error, 'invalid_size');
  const big = validateDocumentUpload({ docType: 'pod', filename: 'a.png', mimeType: 'image/png', size: 2049, maxBytes: 2048 });
  assert.equal(big.error, 'file_too_large');
});

test('buildStorageKey is derived from safe server-side components only', () => {
  const key = buildStorageKey({ tripId: 'trip-1', docType: 'pod', id: 'doc-1', filename: '../../x y.png' });
  assert.equal(key, 'trip-1/pod/doc-1-x-y.png');
  const weird = buildStorageKey({ tripId: '../t1', docType: 'nope', id: 'a/b', filename: '..' });
  assert.equal(weird, '_t1/other/a_b-upload');
  // Every hostile component is neutralised: no separator can introduce a new
  // segment, no segment is `..` and no segment starts with a dot.
  for (const seg of weird.split('/')) {
    assert.notEqual(seg, '..', 'no traversal segment');
    assert.ok(!seg.startsWith('.'), 'no hidden segment: ' + seg);
  }
  assert.equal(resolveWithin('/srv/uploads', weird), '/srv/uploads/_t1/other/a_b-upload');
});

test('resolveWithin keeps every key under the root and refuses escapes', () => {
  assert.equal(resolveWithin('/srv/uploads', 't1/pod/doc.png'), '/srv/uploads/t1/pod/doc.png');
  assert.equal(resolveWithin('/srv/uploads', '../../etc/passwd'), null);
  assert.equal(resolveWithin('/srv/uploads', '/etc/passwd'), null);
  assert.equal(resolveWithin('/srv/uploads', '..'), null);
});

test('decodeBase64Upload accepts raw base64 and data: URLs, rejects junk', () => {
  const raw = Buffer.from('hello').toString('base64');
  assert.deepEqual(decodeBase64Upload(raw), Buffer.from('hello'));
  assert.deepEqual(decodeBase64Upload(`data:image/png;base64,${raw}`), Buffer.from('hello'));
  assert.equal(decodeBase64Upload(''), null);
  assert.equal(decodeBase64Upload(null), null);
  assert.equal(decodeBase64Upload('data:image/png;base64,'), null);
});

test('document permission helpers gate by role and assignment', () => {
  assert.equal(canUploadDocument({ granted: OWNER.permissions, userId: 'admin', tripDriverId: 'd1' }), true);
  assert.equal(canUploadDocument({ granted: DISPATCHER.permissions, userId: 'disp', tripDriverId: null }), true);
  assert.equal(canUploadDocument({ granted: DRIVER1.permissions, userId: 'd1', tripDriverId: 'd1' }), true);
  assert.equal(canUploadDocument({ granted: DRIVER2.permissions, userId: 'd2', tripDriverId: 'd1' }), false);
  assert.equal(canUploadDocument({ granted: ACCOUNTANT.permissions, userId: 'a1', tripDriverId: 'd1' }), false);
  assert.equal(canManageDocuments(OWNER.permissions), true);
  assert.equal(canManageDocuments(DRIVER1.permissions), false);
  assert.equal(canViewTripDocuments({ granted: DRIVER1.permissions, userId: 'd1', tripDriverId: 'd1' }), true);
  assert.equal(canViewTripDocuments({ granted: DRIVER2.permissions, userId: 'd2', tripDriverId: 'd1' }), false);
  assert.equal(canViewTripDocuments({ granted: OWNER.permissions, userId: 'admin', tripDriverId: 'd1' }), true);
});

test('normalizeDocumentStatus accepts only VERIFIED/REJECTED', () => {
  assert.equal(normalizeDocumentStatus('verified'), 'VERIFIED');
  assert.equal(normalizeDocumentStatus('REJECTED'), 'REJECTED');
  assert.equal(normalizeDocumentStatus('PENDING'), null);
  assert.equal(normalizeDocumentStatus(undefined), null);
});

test('shapeDocument exposes the public fields only (never the storage key)', () => {
  const created = new Date('2026-09-22T10:00:00Z');
  const captured = new Date('2026-09-22T09:58:00Z');
  const shaped = shapeDocument({
    id: 'doc-1',
    tripId: 't1',
    docType: 'pod',
    status: 'UPLOADED',
    storageKey: 't1/pod/doc-1-pod.png',
    createdAt: created,
    expiresAt: null,
    capturedAt: captured,
    captureLat: 52.52,
    captureLng: 13.405,
    captureAccuracyM: 12,
  });
  assert.deepEqual(shaped, {
    id: 'doc-1',
    docType: 'pod',
    status: 'UPLOADED',
    uploadedAt: created,
    expiresAt: null,
    capturedAt: captured,
    capture: { lat: 52.52, lng: 13.405, accuracyM: 12 },
  });
  assert.ok(!('storageKey' in shaped), 'storageKey must not be exposed');
  assert.deepEqual(shapeDocument(null), {
    id: undefined,
    docType: undefined,
    status: undefined,
    uploadedAt: null,
    expiresAt: null,
    capturedAt: null,
    capture: null,
  });
  // A capture without a GPS fix has no `capture` block, and the timestamp alone
  // is still reported (board task #4: GPS is best-effort, the time never is).
  const noFix = shapeDocument({ id: 'doc-2', capturedAt: captured, captureLat: null, captureLng: null });
  assert.equal(noFix.capturedAt, captured);
  assert.equal(noFix.capture, null);
});

// --- domain: create / list / verify ---

test('createDocument validates, permission-checks and persists PENDING with a safe key', async () => {
  const prisma = makeFakePrisma();
  const result = await createDocument(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: { docType: 'pod', filename: 'pod.png', mimeType: 'image/png', dataBase64: PNG },
    actor: DRIVER1,
    newId: 'doc-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.document.status, 'PENDING');
  assert.equal(result.document.storageKey, 't1/pod/doc-1-pod.png');
  assert.equal(prisma.state.documents.length, 1);
});

test('createDocument denies a driver who is not assigned, and an unprivileged role', async () => {
  const prisma = makeFakePrisma();
  const body = { docType: 'pod', filename: 'pod.png', mimeType: 'image/png', dataBase64: PNG };
  assert.deepEqual(await createDocument(prisma, { orgId: 'org1', tripId: 't1', body, actor: DRIVER2 }), {
    ok: false,
    error: 'forbidden',
  });
  assert.deepEqual(await createDocument(prisma, { orgId: 'org1', tripId: 't1', body, actor: ACCOUNTANT }), {
    ok: false,
    error: 'forbidden',
  });
  assert.equal(prisma.state.documents.length, 0, 'nothing persisted on a denied upload');
});

test('createDocument isolates orgs and rejects bad payloads', async () => {
  const prisma = makeFakePrisma();
  const body = { docType: 'pod', filename: 'pod.png', mimeType: 'image/png', dataBase64: PNG };
  assert.deepEqual(await createDocument(prisma, { orgId: 'org2', tripId: 't1', body, actor: OWNER }), {
    ok: false,
    error: 'not_found',
  });
  assert.equal((await createDocument(prisma, { orgId: 'org1', tripId: 't1', body: {}, actor: OWNER })).error, 'invalid_upload');
  assert.equal(
    (await createDocument(prisma, { orgId: 'org1', tripId: 't1', body: { ...body, docType: 'x' }, actor: OWNER })).error,
    'invalid_doc_type',
  );
  assert.equal(
    (await createDocument(prisma, { orgId: 'org1', tripId: 't1', body: { ...body, mimeType: 'text/plain' }, actor: OWNER })).error,
    'unsupported_type',
  );
});

test('listTripDocuments scopes to the org and the assigned driver', async () => {
  const prisma = makeFakePrisma();
  await createDocument(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: { docType: 'pod', filename: 'pod.png', mimeType: 'image/png', dataBase64: PNG },
    actor: OWNER,
    newId: 'doc-1',
  });
  const asOwner = await listTripDocuments(prisma, { orgId: 'org1', tripId: 't1', actor: OWNER });
  assert.equal(asOwner.ok, true);
  assert.equal(asOwner.documents.length, 1);
  assert.equal((await listTripDocuments(prisma, { orgId: 'org2', tripId: 't1', actor: OWNER })).error, 'not_found');
  assert.equal((await listTripDocuments(prisma, { orgId: 'org1', tripId: 't1', actor: DRIVER2 })).error, 'forbidden');
  assert.equal((await listTripDocuments(prisma, { orgId: 'org1', tripId: 't1', actor: DRIVER1 })).ok, true);
});

test('updateDocumentStatus verifies/rejects for trip:* only, org-scoped', async () => {
  const prisma = makeFakePrisma();
  await createDocument(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: { docType: 'pod', filename: 'pod.png', mimeType: 'image/png', dataBase64: PNG },
    actor: OWNER,
    newId: 'doc-1',
  });

  assert.deepEqual(await updateDocumentStatus(prisma, { orgId: 'org1', documentId: 'doc-1', status: 'VERIFIED', actor: DRIVER1 }), {
    ok: false,
    error: 'forbidden',
  });
  assert.equal((await updateDocumentStatus(prisma, { orgId: 'org1', documentId: 'doc-1', status: 'PENDING', actor: OWNER })).error, 'invalid_status');
  assert.equal((await updateDocumentStatus(prisma, { orgId: 'org2', documentId: 'doc-1', status: 'VERIFIED', actor: OWNER })).error, 'not_found');

  const verified = await updateDocumentStatus(prisma, { orgId: 'org1', documentId: 'doc-1', status: 'verified', actor: DISPATCHER });
  assert.equal(verified.ok, true);
  assert.equal(verified.document.status, 'VERIFIED');
});

test('hasPodDocument is true only for an uploaded/verified pod or ecmr', async () => {
  const prisma = makeFakePrisma();
  assert.equal(await hasPodDocument(prisma, { tripId: 't1' }), false);
  prisma.state.documents.push({ id: 'a', tripId: 't1', docType: 'invoice', status: 'UPLOADED' });
  assert.equal(await hasPodDocument(prisma, { tripId: 't1' }), false);
  prisma.state.documents.push({ id: 'b', tripId: 't1', docType: 'pod', status: 'PENDING' });
  assert.equal(await hasPodDocument(prisma, { tripId: 't1' }), false);
  prisma.state.documents.push({ id: 'c', tripId: 't1', docType: 'pod', status: 'UPLOADED' });
  assert.equal(await hasPodDocument(prisma, { tripId: 't1' }), true);
  assert.equal(await hasPodDocument(prisma, { tripId: 't2' }), false);
});

test('normalizeCapture validates the optional POD capture metadata', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  // Neither field: valid, everything null.
  assert.deepEqual(normalizeCapture({ now }), {
    ok: true,
    value: { capturedAt: null, captureLat: null, captureLng: null, captureAccuracyM: null },
  });
  // Timestamp only, no GPS fix.
  assert.deepEqual(normalizeCapture({ capturedAt: '2026-09-23T11:59:00Z', now }), {
    ok: true,
    value: { capturedAt: new Date('2026-09-23T11:59:00Z'), captureLat: null, captureLng: null, captureAccuracyM: null },
  });
  // Epoch milliseconds are accepted too.
  assert.equal(normalizeCapture({ capturedAt: now - 1000, now }).value.capturedAt.toISOString(), '2026-09-23T11:59:59.000Z');
  // Full capture, with the accuracy rounded to a whole metre.
  assert.deepEqual(normalizeCapture({ capturedAt: '2026-09-23T11:00:00Z', geo: { lat: 52.52, lng: 13.405, accuracy: 11.6 }, now }), {
    ok: true,
    value: { capturedAt: new Date('2026-09-23T11:00:00Z'), captureLat: 52.52, captureLng: 13.405, captureAccuracyM: 12 },
  });
  // GPS without accuracy is fine.
  assert.deepEqual(normalizeCapture({ geo: { lat: 52.52, lng: 13.405 }, now }).value.captureAccuracyM, null);

  // Rejections: never store an impossible fix or a future timestamp.
  assert.equal(normalizeCapture({ capturedAt: 'not-a-date', now }).error, 'invalid_capture');
  assert.equal(normalizeCapture({ capturedAt: new Date(now + 48 * 3600 * 1000).toISOString(), now }).error, 'invalid_capture');
  assert.equal(normalizeCapture({ geo: { lat: 91, lng: 0 }, now }).error, 'invalid_capture');
  assert.equal(normalizeCapture({ geo: { lat: 0, lng: -181 }, now }).error, 'invalid_capture');
  assert.equal(normalizeCapture({ geo: { lat: '52.5' }, now }).error, 'invalid_capture');
  assert.equal(normalizeCapture({ geo: { lat: 52.5, lng: 13.4, accuracy: -1 }, now }).error, 'invalid_capture');
  assert.equal(normalizeCapture({ geo: 'here', now }).error, 'invalid_capture');
});

test('createDocument persists the capture metadata and rejects a bad one', async () => {
  const prisma = makeFakePrisma();
  const base = { docType: 'pod', filename: 'pod.png', mimeType: 'image/png', dataBase64: PNG };
  const capturedAt = '2026-09-23T10:00:00Z';

  const withCapture = await createDocument(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: { ...base, capturedAt, geo: { lat: 52.52, lng: 13.405, accuracy: 9 } },
    actor: DRIVER1,
    newId: 'doc-cap',
  });
  assert.equal(withCapture.ok, true);
  assert.deepEqual(withCapture.document.capturedAt, new Date(capturedAt));
  assert.equal(withCapture.document.captureLat, 52.52);
  assert.equal(withCapture.document.captureLng, 13.405);
  assert.equal(withCapture.document.captureAccuracyM, 9);
  assert.equal(prisma.state.documents.length, 1);

  // A malformed capture is a 400 (`invalid_capture`), not a silent NULL row.
  const bad = await createDocument(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: { ...base, geo: { lat: 200, lng: 13.405 } },
    actor: DRIVER1,
    newId: 'doc-bad',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_capture');
  assert.equal(prisma.state.documents.length, 1, 'nothing persisted for a rejected capture');

  // An upload with no capture at all still works (backwards compatible).
  const plain = await createDocument(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: base,
    actor: DRIVER1,
    newId: 'doc-plain',
  });
  assert.equal(plain.ok, true);
  assert.equal(plain.document.capturedAt, null);
  assert.equal(plain.document.captureLat, null);
});

// --- storage (real filesystem, temp dir) ---

test('writeDocumentFile writes under the root and removeDocumentFile cleans up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rwf-doc-'));
  try {
    const written = await writeDocumentFile(root, 't1/pod/doc-1-pod.png', Buffer.from('bytes'));
    assert.equal(written.ok, true);
    assert.deepEqual(await readFile(written.path), Buffer.from('bytes'));
    assert.equal(await removeDocumentFile(root, 't1/pod/doc-1-pod.png'), true);

    const escape = await writeDocumentFile(root, '../escape.txt', Buffer.from('x'));
    assert.deepEqual(escape, { ok: false, error: 'invalid_storage_key' });
    assert.equal(await removeDocumentFile(root, '../escape.txt'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stored documents are not world-readable (board #46)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rwf-doc-mode-'));
  try {
    const written = await writeDocumentFile(root, 't1/pod/doc-2-pod.jpg', Buffer.from('photo'));
    assert.equal(written.ok, true);

    // A POD photo can carry a customer's address and signature: no "other" bits.
    const fileMode = (await stat(written.path)).mode & 0o777;
    assert.equal(fileMode & 0o007, 0, `file mode ${fileMode.toString(8)} is world-accessible`);

    const dirMode = (await stat(join(root, 't1', 'pod'))).mode & 0o777;
    assert.equal(dirMode & 0o007, 0, `dir mode ${dirMode.toString(8)} is world-accessible`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
