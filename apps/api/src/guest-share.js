/**
 * Guest document + invoice share views (board task #132, UXF-O1a) — the app
 * half of board #75 that needs no WhatsApp/SMS provider.
 *
 * Authoritative spec: `docs/ux-flows/06-offplatform-customers.mmd` —
 * "Documents: POD · eCMR · invoice — download" and "a share link is READ-ONLY".
 *
 * The capability is the existing signed-token primitive (`track-link.js`):
 * `share:document:<id>~<version>` / `share:invoice:<id>~<version>`, HMAC-SHA256
 * over the key derived from `AUTH_SECRET` (or `TRACK_LINK_SECRET`), holding the
 * SAME version as the owning trip's `trackLinkVersion`. There is no document
 * token storage and no schema change: the version binds a document link to its
 * shipment's share window, so revoking the shipment link revokes its document
 * links, and re-minting the shipment link gives new ones.
 *
 * This module is the HTTP-independent half (validation, read model, headers) so
 * the reject paths are unit-testable with `node --test` and zero install; the
 * route layer (`routes/guest-share.ts`) only maps them to responses.
 */

import { ALLOWED_MIME, sanitizeFilename } from './documents.js';
import { isGuestScope, publicGuestUrl, signShareLink } from './track-link.js';

/** Document statuses a guest may fetch: pending/rejected bytes are never shared. */
export const SHAREABLE_DOCUMENT_STATUSES = Object.freeze(['UPLOADED', 'VERIFIED']);

/** Permission required to mint a guest document link (owner / dispatcher). */
export const DOCUMENT_SHARE_PERMISSION = 'trip:*';

/**
 * @typedef {Object} GuestShareClient
 * @property {any} document
 */

/**
 * Is this document status shareable? `PENDING` (no bytes yet) and `REJECTED`
 * (a bad/expired paper) are the per-document revoke.
 * @param {unknown} status
 * @returns {boolean}
 */
export function isShareableDocumentStatus(status) {
  return typeof status === 'string' && SHAREABLE_DOCUMENT_STATUSES.includes(status);
}

/**
 * Which guest scope a document belongs to. An invoice row is only reachable on
 * `/g/invoice/…`; everything else (POD, eCMR, papers) downloads from
 * `/g/document/…`.
 * @param {unknown} docType
 * @returns {'invoice' | 'document'}
 */
export function shareScopeForDocType(docType) {
  return docType === 'invoice' ? 'invoice' : 'document';
}

/**
 * Does a scope allow this document type? This is the wrong-scope rejection that
 * keeps an invoice token off the attachment surface and a POD token off the
 * inline invoice surface, independently of the signed scope in the token.
 * @param {unknown} scope
 * @param {unknown} docType
 * @returns {boolean}
 */
export function scopeAllowsDocType(scope, docType) {
  if (!isGuestScope(scope) || typeof docType !== 'string' || docType.length === 0) return false;
  return scope === 'invoice' ? docType === 'invoice' : docType !== 'invoice';
}

/**
 * MIME type for a stored document, from its extension. Only the types the
 * upload validator accepts are ever stored, so anything else is a corrupt row
 * and is served as opaque bytes (never guessed).
 * @param {unknown} storageKey
 * @returns {string}
 */
export function documentContentType(storageKey) {
  if (typeof storageKey !== 'string') return 'application/octet-stream';
  const dot = storageKey.lastIndexOf('.');
  const ext = dot >= 0 ? storageKey.slice(dot + 1).toLowerCase() : '';
  for (const [mime, known] of Object.entries(ALLOWED_MIME)) {
    if (known === ext) return mime;
  }
  return 'application/octet-stream';
}

/**
 * The download filename for a stored key: the stored basename (`<id>-<name>`)
 * sanitised again, so nothing from the row can inject a header.
 * @param {unknown} storageKey
 * @returns {string}
 */
export function documentFileName(storageKey) {
  if (typeof storageKey !== 'string' || storageKey.length === 0) return 'document';
  const slash = storageKey.lastIndexOf('/');
  const base = slash >= 0 ? storageKey.slice(slash + 1) : storageKey;
  return sanitizeFilename(base) || 'document';
}

/**
 * `Content-Disposition` for a guest response. `/g/document/…` is a download
 * (attachment), `/g/invoice/…` renders in the browser (inline). The filename is
 * quoted and already reduced to `[A-Za-z0-9._-]`.
 * @param {unknown} scope
 * @param {unknown} filename
 * @returns {string}
 */
export function contentDisposition(scope, filename) {
  const name = sanitizeFilename(/** @type {string} */ (filename)) || 'document';
  const kind = scope === 'invoice' ? 'inline' : 'attachment';
  return `${kind}; filename="${name}"`;
}

/**
 * The mint parameters persisted on a trip → the guest link for one document.
 * Wrapped so the route and the tests share one call (and one place where TTL
 * and version come from).
 * @param {any} trip
 * @param {any} document
 * @param {{ scope: string, authSecret?: unknown, secret?: unknown, now?: number }} args
 * @returns {{ token: string, expiresAt: string, ttlSeconds: number, version: number, scope: string } | null}
 */
export function mintDocumentLink(trip, document, { scope, authSecret, secret, now }) {
  const issuedMs = toMillis(trip?.trackLinkIssuedAt);
  const expiresMs = toMillis(trip?.trackLinkExpiresAt);
  const atMs = typeof now === 'number' ? now * 1000 : Date.now();
  if (issuedMs === null || expiresMs === null || expiresMs <= issuedMs) return null;
  // The guest link lives INSIDE the shipment's share window: an expired trip
  // link has nothing left to bind to (and nothing left to revoke with).
  if (expiresMs <= atMs) return null;
  const versionRaw = Number(trip?.trackLinkVersion);
  const version = Number.isFinite(versionRaw) && versionRaw > 0 ? Math.floor(versionRaw) : 0;
  const issuedAtSec = Math.floor(issuedMs / 1000);
  try {
    const link = signShareLink({
      scope,
      documentId: document?.id,
      version,
      authSecret,
      secret,
      ttlSeconds: Math.max(1, Math.round((expiresMs - issuedMs) / 1000)),
      now: issuedAtSec,
    });
    return { ...link, scope };
  } catch {
    return null;
  }
}

/**
 * Coerce a `Date | string | number | null` to epoch milliseconds (or null).
 * @param {unknown} value
 * @returns {number | null}
 */
function toMillis(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * The document + trip columns a guest response needs. One place, so the route
 * and the tests cannot drift.
 * @returns {any}
 */
export function guestDocumentInclude() {
  return {
    trip: {
      select: {
        id: true,
        trackLinkVersion: true,
        trackLinkIssuedAt: true,
        trackLinkExpiresAt: true,
      },
    },
  };
}

/**
 * Load one shareable document for a verified token.
 *
 * Every rejection is the same `not_found`: unknown id, a document that is not
 * in a shareable status, a document whose type does not belong to the scope,
 * and a token whose version no longer matches the owning trip (the shipment
 * link was revoked). The public surface never hints which one it was.
 * @param {GuestShareClient} prisma
 * @param {{ scope?: unknown, documentId?: unknown, version?: unknown }} [args]
 * @returns {Promise<{ ok: true, document: any } | { ok: false, error: 'not_found' }>}
 */
export async function loadGuestDocument(prisma, { scope, documentId, version } = {}) {
  const id = typeof documentId === 'string' ? documentId.trim() : '';
  if (!isGuestScope(scope) || !id) return { ok: false, error: 'not_found' };

  const document = await prisma.document.findFirst({
    where: { id },
    include: guestDocumentInclude(),
  });
  if (!document) return { ok: false, error: 'not_found' };
  if (!scopeAllowsDocType(scope, document.docType)) return { ok: false, error: 'not_found' };
  if (!isShareableDocumentStatus(document.status)) return { ok: false, error: 'not_found' };

  if (typeof version === 'number') {
    const currentRaw = Number(document.trip?.trackLinkVersion);
    const current = Number.isFinite(currentRaw) && currentRaw > 0 ? Math.floor(currentRaw) : 0;
    if (current !== version) return { ok: false, error: 'not_found' };
  }

  return { ok: true, document };
}

/**
 * Shape the authenticated mint/read response for one document. Never includes
 * the storage key or any path: the URL is the capability.
 * @param {{ scope: string, link: { token: string, expiresAt: string, ttlSeconds: number, version: number } }} args
 * @param {unknown} baseUrl
 * @returns {{ scope: string, token: string, url: string, expiresAt: string, ttlSeconds: number }}
 */
export function shapeDocumentLink({ scope, link }, baseUrl) {
  return {
    scope,
    token: link.token,
    url: publicGuestUrl(baseUrl, scope, link.token),
    expiresAt: link.expiresAt,
    ttlSeconds: link.ttlSeconds,
  };
}
