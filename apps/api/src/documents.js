/**
 * Documents / POD (board task #3) — the compliance core of the product.
 *
 * The `Document` model existed but nothing used it. This module owns the
 * document lifecycle: validate an upload, place it under a generated
 * `storageKey`, list a trip's documents, and verify/reject one. Local disk
 * storage for the pilot (MinIO later); files are written under one root and
 * can never escape it.
 *
 * Decoupled from Fastify and from Prisma's concrete client so it can be
 * unit-tested against a fake client with the Node.js native test runner
 * (`node --test`, zero install). The route layer (`routes/documents.ts`) only
 * does auth, HTTP mapping and the actual file write.
 *
 * Tenancy is always the caller's `orgId` (from the signed token, never the
 * client). Uploads: `trip:*` (owner/dispatcher) may upload to any trip in the
 * org; a driver needs `pod:upload` **and** to be the trip's assigned driver.
 *
 * No secrets in filenames or storage keys: the key is derived from the trip id,
 * the doc type, a generated document id and a sanitised basename only.
 */

import { basename, dirname, resolve, sep } from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hasPermission } from './auth/permissions.js';

/** The document types the API accepts (mirrors the schema comment). */
export const DOC_TYPES = Object.freeze([
  'ecmr',
  'pod',
  'invoice',
  'driver_license',
  'cpc',
  'medical',
  'insurance',
  'tacho_file',
  'e_irsaliye',
]);

/** Document types that satisfy the POD_UPLOADED gate. */
export const POD_DOC_TYPES = Object.freeze(['pod', 'ecmr']);

/** A capture timestamp further in the future than this is a clock problem. */
export const MAX_CAPTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** Accepted MIME types -> canonical file extension. */
export const ALLOWED_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
});

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_FILENAME_LENGTH = 120;

/**
 * @typedef {Object} DocumentsClient
 * @property {any} trip
 * @property {any} document
 */

/**
 * Reduce an arbitrary client-supplied filename to a safe basename: strip any
 * directory part, control characters and everything outside `[A-Za-z0-9._-]`,
 * forbid leading dots, and cap the length. Returns `''` when nothing is left.
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  if (typeof name !== 'string') return '';
  const base = basename(name).replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.replace(/^\.+/, '').slice(0, MAX_FILENAME_LENGTH);
}

/**
 * Validate an upload request. Pure: takes the already-decoded byte length.
 * @param {{ docType?: unknown, filename?: unknown, mimeType?: unknown, size?: unknown, maxBytes?: number }} input
 * @returns {{ ok: true, value: { docType: string, filename: string, mimeType: string, ext: string, size: number } } | { ok: false, error: string, detail?: string }}
 */
export function validateDocumentUpload({ docType, filename, mimeType, size, maxBytes = DEFAULT_MAX_UPLOAD_BYTES }) {
  const type = typeof docType === 'string' ? docType : '';
  if (!DOC_TYPES.includes(type)) {
    return { ok: false, error: 'invalid_doc_type', detail: `docType must be one of ${DOC_TYPES.join(', ')}` };
  }
  const safe = sanitizeFilename(filename);
  if (!safe) return { ok: false, error: 'invalid_filename' };
  const ext = typeof mimeType === 'string' ? ALLOWED_MIME[mimeType] : undefined;
  if (!ext) {
    return { ok: false, error: 'unsupported_type', detail: 'mimeType must be one of ' + Object.keys(ALLOWED_MIME).join(', ') };
  }
  const bytes = Number(size);
  if (!Number.isInteger(bytes) || bytes <= 0) return { ok: false, error: 'invalid_size' };
  if (bytes > maxBytes) return { ok: false, error: 'file_too_large', detail: `max ${maxBytes} bytes` };
  return { ok: true, value: { docType: type, filename: safe, mimeType: /** @type {string} */ (mimeType), ext, size: bytes } };
}

/**
 * Build a storage key from safe, server-side components only:
 * `<tripId>/<docType>/<documentId>-<sanitised-name>`. Never contains a secret
 * or a client-supplied path.
 * @param {{ tripId?: unknown, docType?: unknown, id?: unknown, filename?: unknown }} input
 * @returns {string}
 */
export function buildStorageKey({ tripId, docType, id, filename }) {
  const segment = (v) => String(v ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const safeTrip = segment(tripId) || 'trip';
  const safeType = DOC_TYPES.includes(/** @type {string} */ (docType)) ? String(docType) : 'other';
  const safeId = segment(id) || randomUUID();
  const safeName = sanitizeFilename(filename) || 'upload';
  return `${safeTrip}/${safeType}/${safeId}-${safeName}`;
}

/**
 * Resolve a storage key under `root`, returning `null` if it would escape the
 * root (defence in depth on top of the sanitised key).
 * @param {string} root
 * @param {string} storageKey
 * @returns {string | null}
 */
export function resolveWithin(root, storageKey) {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, storageKey);
  if (target === rootAbs || !target.startsWith(rootAbs + sep)) return null;
  return target;
}

/**
 * Decode a base64 upload body, tolerating an optional `data:` URL prefix.
 * @param {unknown} dataBase64
 * @returns {Buffer | null}
 */
export function decodeBase64Upload(dataBase64) {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) return null;
  const comma = dataBase64.indexOf(',');
  const payload = dataBase64.startsWith('data:') && comma >= 0 ? dataBase64.slice(comma + 1) : dataBase64;
  if (!payload) return null;
  try {
    const buf = Buffer.from(payload, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * A driver may upload to a trip assigned to them with `pod:upload`; a
 * `trip:*` role (owner/dispatcher) may upload to any trip in its org.
 * @param {{ granted?: unknown, userId?: string | null, tripDriverId?: string | null }} args
 * @returns {boolean}
 */
export function canUploadDocument({ granted, userId, tripDriverId } = {}) {
  if (hasPermission(granted, 'trip:*')) return true;
  return (
    hasPermission(granted, 'pod:upload') &&
    typeof userId === 'string' &&
    userId.length > 0 &&
    userId === tripDriverId
  );
}

/** Verifying/rejecting a document requires `trip:*` (owner/dispatcher). */
export function canManageDocuments(granted) {
  return hasPermission(granted, 'trip:*');
}

/**
 * Reading a trip's documents: `trip:*` sees any trip in the org, everyone else
 * (drivers) only a trip assigned to them — the driver app must not leak another
 * driver's paperwork.
 * @param {{ granted?: unknown, userId?: string | null, tripDriverId?: string | null }} args
 * @returns {boolean}
 */
export function canViewTripDocuments({ granted, userId, tripDriverId } = {}) {
  if (hasPermission(granted, 'trip:*')) return true;
  return (
    hasPermission(granted, 'trip:read') &&
    typeof userId === 'string' &&
    userId.length > 0 &&
    userId === tripDriverId
  );
}

/**
 * Only VERIFIED / REJECTED may be set through the API; anything else is null.
 * @param {unknown} value
 * @returns {'VERIFIED' | 'REJECTED' | null}
 */
export function normalizeDocumentStatus(value) {
  const v = String(value ?? '').toUpperCase();
  return v === 'VERIFIED' || v === 'REJECTED' ? v : null;
}

/**
 * Validate the optional capture metadata a POD upload carries (board task #4):
 * `capturedAt` (ISO string or epoch ms) and `geo` ({ lat, lng, accuracy }).
 *
 * Both are optional — a driver with no GPS fix still uploads — but a *present*
 * value must be sane: bad coordinates or a future timestamp are rejected rather
 * than stored, so the compliance record is never silently wrong. Returns the
 * exact column values to persist.
 * @param {{ capturedAt?: unknown, geo?: unknown, now?: number }} [input]
 * @returns {{ ok: true, value: { capturedAt: Date | null, captureLat: number | null, captureLng: number | null, captureAccuracyM: number | null } } | { ok: false, error: string, detail: string }}
 */
export function normalizeCapture(input = {}) {
  const now = typeof input.now === 'number' ? input.now : Date.now();

  let capturedAt = null;
  if (input.capturedAt !== undefined && input.capturedAt !== null && input.capturedAt !== '') {
    const ms = typeof input.capturedAt === 'number' ? input.capturedAt : Date.parse(String(input.capturedAt));
    if (!Number.isFinite(ms)) {
      return { ok: false, error: 'invalid_capture', detail: 'capturedAt must be an ISO date or epoch milliseconds' };
    }
    if (ms > now + MAX_CAPTURE_SKEW_MS) {
      return { ok: false, error: 'invalid_capture', detail: 'capturedAt is in the future' };
    }
    capturedAt = new Date(ms);
  }

  if (input.geo === undefined || input.geo === null) {
    return { ok: true, value: { capturedAt, captureLat: null, captureLng: null, captureAccuracyM: null } };
  }
  const geo = input.geo;
  if (typeof geo !== 'object' || Array.isArray(geo)) {
    return { ok: false, error: 'invalid_capture', detail: 'geo must be an object with lat/lng' };
  }
  const lat = Number(/** @type {any} */ (geo).lat);
  const lng = Number(/** @type {any} */ (geo).lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'invalid_capture', detail: 'geo.lat and geo.lng are required numbers' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: 'invalid_capture', detail: 'geo.lat/lng out of range' };
  }
  let captureAccuracyM = null;
  const rawAccuracy = /** @type {any} */ (geo).accuracy;
  if (rawAccuracy !== undefined && rawAccuracy !== null && rawAccuracy !== '') {
    const accuracy = Number(rawAccuracy);
    if (!Number.isFinite(accuracy) || accuracy < 0) {
      return { ok: false, error: 'invalid_capture', detail: 'geo.accuracy must be a non-negative number' };
    }
    captureAccuracyM = Math.round(accuracy);
  }
  return { ok: true, value: { capturedAt, captureLat: lat, captureLng: lng, captureAccuracyM } };
}

/**
 * Public shape of a document row. Never exposes `storageKey` (an internal disk
 * path): the API surface is id/docType/status/uploadedAt/expiresAt/capture only.
 * @param {any} d
 * @returns {{ id: any, docType: any, status: any, uploadedAt: any, expiresAt: any, capturedAt: any, capture: any }}
 */
export function shapeDocument(d) {
  const lat = d?.captureLat === null || d?.captureLat === undefined ? null : Number(d.captureLat);
  const lng = d?.captureLng === null || d?.captureLng === undefined ? null : Number(d.captureLng);
  const accuracyM = d?.captureAccuracyM === null || d?.captureAccuracyM === undefined ? null : Number(d.captureAccuracyM);
  return {
    id: d?.id,
    docType: d?.docType,
    status: d?.status,
    uploadedAt: d?.createdAt ?? null,
    expiresAt: d?.expiresAt ?? null,
    capturedAt: d?.capturedAt ?? null,
    capture: lat === null || lng === null ? null : { lat, lng, accuracyM },
  };
}

/**
 * List a trip's documents, oldest first, after the org + viewer checks.
 * @param {DocumentsClient} prisma
 * @param {{ orgId?: string | null, tripId?: string | null, actor?: { userId?: string | null, permissions?: unknown } }} args
 * @returns {Promise<{ ok: true, documents: any[] } | { ok: false, error: string }>}
 */
export async function listTripDocuments(prisma, { orgId, tripId, actor }) {
  if (!orgId) return { ok: false, error: 'no_org' };
  const trip = await prisma.trip.findFirst({ where: { id: tripId, orgId } });
  if (!trip) return { ok: false, error: 'not_found' };
  const allowed = canViewTripDocuments({
    granted: actor?.permissions,
    userId: actor?.userId,
    tripDriverId: trip.driverId,
  });
  if (!allowed) return { ok: false, error: 'forbidden' };
  const documents = await prisma.document.findMany({ where: { tripId }, orderBy: { createdAt: 'asc' } });
  return { ok: true, documents };
}

/**
 * Validate and persist a document row in `PENDING`; the route writes the bytes
 * and flips it to `UPLOADED` (or deletes the row if the write fails).
 * @param {DocumentsClient} prisma
 * @param {{ orgId?: string | null, tripId?: string | null, body?: any, actor?: { userId?: string | null, permissions?: unknown }, maxBytes?: number, newId?: string }} args
 * @returns {Promise<{ ok: true, document: any, bytes: Buffer } | { ok: false, error: string, detail?: string }>}
 */
export async function createDocument(prisma, { orgId, tripId, body, actor, maxBytes, newId }) {
  if (!orgId) return { ok: false, error: 'no_org' };
  const trip = await prisma.trip.findFirst({ where: { id: tripId, orgId } });
  if (!trip) return { ok: false, error: 'not_found' };
  const allowed = canUploadDocument({
    granted: actor?.permissions,
    userId: actor?.userId,
    tripDriverId: trip.driverId,
  });
  if (!allowed) return { ok: false, error: 'forbidden' };

  const b = body && typeof body === 'object' ? body : {};
  const bytes = decodeBase64Upload(b.dataBase64);
  if (!bytes) return { ok: false, error: 'invalid_upload', detail: 'dataBase64 is required' };

  const validated = validateDocumentUpload({
    docType: b.docType,
    filename: b.filename,
    mimeType: b.mimeType,
    size: bytes.length,
    maxBytes,
  });
  if (!validated.ok) return validated;

  // Board task #4: a driver capture carries when/where the photo was taken.
  const capture = normalizeCapture({ capturedAt: b.capturedAt, geo: b.geo });
  if (!capture.ok) return capture;

  const id = newId ?? randomUUID();
  const storageKey = buildStorageKey({ tripId, docType: validated.value.docType, id, filename: validated.value.filename });
  const document = await prisma.document.create({
    data: { id, tripId, docType: validated.value.docType, storageKey, status: 'PENDING', ...capture.value },
  });
  return { ok: true, document, bytes };
}

/**
 * Set a document's status to VERIFIED or REJECTED (`trip:*` only), after
 * confirming the document's trip belongs to the caller's org.
 * @param {DocumentsClient} prisma
 * @param {{ orgId?: string | null, documentId?: string | null, status?: unknown, actor?: { userId?: string | null, permissions?: unknown } }} args
 * @returns {Promise<{ ok: true, document: any } | { ok: false, error: string }>}
 */
export async function updateDocumentStatus(prisma, { orgId, documentId, status, actor }) {
  if (!orgId) return { ok: false, error: 'no_org' };
  if (!canManageDocuments(actor?.permissions)) return { ok: false, error: 'forbidden' };
  const next = normalizeDocumentStatus(status);
  if (!next) return { ok: false, error: 'invalid_status' };

  const document = await prisma.document.findFirst({ where: { id: documentId, trip: { orgId } } });
  if (!document) return { ok: false, error: 'not_found' };

  const updated = await prisma.document.update({ where: { id: documentId }, data: { status: next } });
  return { ok: true, document: updated };
}

/**
 * True when the trip has at least one uploaded/verified POD or eCMR — the gate
 * for moving a trip to POD_UPLOADED.
 * @param {DocumentsClient} prisma
 * @param {{ tripId: string }} args
 * @returns {Promise<boolean>}
 */
export async function hasPodDocument(prisma, { tripId }) {
  const count = await prisma.document.count({
    where: {
      tripId,
      docType: { in: [...POD_DOC_TYPES] },
      status: { in: ['UPLOADED', 'VERIFIED'] },
    },
  });
  return count > 0;
}

/**
 * Write bytes under `root` at `storageKey` (creating parent dirs). Refuses any
 * key that would resolve outside the root.
 * @param {string} root
 * @param {string} storageKey
 * @param {Buffer | Uint8Array} bytes
 * @returns {Promise<{ ok: true, path: string } | { ok: false, error: string }>}
 */
export async function writeDocumentFile(root, storageKey, bytes) {
  const target = resolveWithin(root, storageKey);
  if (!target) return { ok: false, error: 'invalid_storage_key' };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return { ok: true, path: target };
}

/**
 * Best-effort removal of a stored file (used to roll back a failed upload).
 * @param {string} root
 * @param {string} storageKey
 * @returns {Promise<boolean>}
 */
export async function removeDocumentFile(root, storageKey) {
  const target = resolveWithin(root, storageKey);
  if (!target) return false;
  try {
    await unlink(target);
    return true;
  } catch {
    return false;
  }
}
