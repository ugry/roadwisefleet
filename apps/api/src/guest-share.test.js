/**
 * Guest document + invoice share views (board task #132, UXF-O1a).
 *
 * Dependency-free: only `node:*` builtins and pure project modules, so the
 * existing no-install CI job (`node --test apps/api/src/`) covers the token
 * contract and every reject path. The HTTP half (real file bytes, headers,
 * cookie-free responses) is `../test/guest-share.test.ts` under `test:router`.
 *
 * Acceptance covered here:
 *   - entropy / expiry / revocation-by-version-bump,
 *   - wrong-scope rejection (invoice token on /g/document/… and vice versa),
 *   - cross-document rejection (a token for doc A carries A's id only),
 *   - unknown / malformed / tampered / rotated tokens verify to null,
 *   - pending/rejected documents are not shareable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GUEST_SCOPES,
  SHARE_SUB_PREFIX,
  decodeShareSub,
  encodeShareSub,
  isGuestScope,
  publicGuestUrl,
  signShareLink,
  signTrackLink,
  verifyShareLink,
  verifyTrackLink,
} from './track-link.js';
import {
  contentDisposition,
  documentContentType,
  documentFileName,
  isShareableDocumentStatus,
  loadGuestDocument,
  mintDocumentLink,
  scopeAllowsDocType,
  shareScopeForDocType,
  shapeDocumentLink,
} from './guest-share.js';

const SECRET = 'test-auth-secret';
const NOW = 1_800_000_000; // fixed epoch seconds
const DOC_A = 'doc-aaaaaaaaaaaaaaaa';
const DOC_B = 'doc-bbbbbbbbbbbbbbbb';

/** A tiny fake Prisma client: one document row, findFirst matches by id. */
function fakePrisma(row) {
  const calls = [];
  return {
    calls,
    document: {
      findFirst: async ({ where }) => {
        calls.push(where);
        return row && where.id === row.id ? row : null;
      },
    },
  };
}

function docRow(overrides = {}) {
  return {
    id: DOC_A,
    tripId: 'trip-1',
    docType: 'pod',
    status: 'UPLOADED',
    storageKey: 'trip-1/pod/doc-aaaaaaaaaaaaaaaa-pod.jpg',
    trip: {
      id: 'trip-1',
      trackLinkVersion: 0,
      trackLinkIssuedAt: new Date(NOW * 1000),
      trackLinkExpiresAt: new Date((NOW + 3600) * 1000),
    },
    ...overrides,
  };
}

// --- token contract ---------------------------------------------------------

test('a guest token round-trips for its own scope and carries the document id', () => {
  const { token, version, ttlSeconds } = signShareLink({
    scope: 'document',
    documentId: DOC_A,
    version: 0,
    authSecret: SECRET,
    now: NOW,
  });

  assert.equal(ttlSeconds, 30 * 24 * 60 * 60);
  assert.equal(version, 0);
  const verified = verifyShareLink(token, { scope: 'document', authSecret: SECRET, now: NOW + 5 });
  assert.ok(verified);
  assert.equal(verified.documentId, DOC_A);
  assert.equal(verified.scope, 'document');
  assert.equal(verified.version, 0);
  assert.equal(verified.exp, NOW + ttlSeconds);
});

test('the token is unguessable: a 32-byte MAC and different bytes per document/scope', () => {
  const a = signShareLink({ scope: 'document', documentId: DOC_A, authSecret: SECRET, now: NOW });
  const b = signShareLink({ scope: 'document', documentId: DOC_B, authSecret: SECRET, now: NOW });
  const i = signShareLink({ scope: 'invoice', documentId: DOC_A, authSecret: SECRET, now: NOW });

  assert.notEqual(a.token, b.token, 'a different document is a different capability');
  assert.notEqual(a.token, i.token, 'a different scope is a different capability');

  const [, payload, signature] = a.token.split('.');
  // base64url of 32 bytes is 43 chars — the HMAC-SHA256 MAC, no truncation.
  assert.equal(signature.length, 43);
  assert.equal(Buffer.from(signature, 'base64url').length, 32);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.ok(claims.sub.startsWith(`${SHARE_SUB_PREFIX}document:`));
  // A real token always exceeds Fastify's old maxParamLength default (100).
  assert.ok(a.token.length > 100);
});

test('expiry and secret rotation both reject', () => {
  const { token } = signShareLink({
    scope: 'document',
    documentId: DOC_A,
    authSecret: SECRET,
    ttlSeconds: 60,
    now: NOW,
  });
  assert.ok(verifyShareLink(token, { scope: 'document', authSecret: SECRET, now: NOW + 59 }));
  assert.equal(
    verifyShareLink(token, { scope: 'document', authSecret: SECRET, now: NOW + 60 }),
    null,
    'expired',
  );
  assert.equal(
    verifyShareLink(token, { scope: 'document', authSecret: 'rotated-secret', now: NOW + 1 }),
    null,
    'a rotated TRACK_LINK_SECRET kills every outstanding link',
  );
});

test('a tampered or malformed token never verifies', () => {
  const { token } = signShareLink({ scope: 'document', documentId: DOC_A, authSecret: SECRET, now: NOW });
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.sub = `${SHARE_SUB_PREFIX}document:${DOC_B}`;
  const forgedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');

  assert.equal(
    verifyShareLink(`${header}.${forgedPayload}.${signature}`, { scope: 'document', authSecret: SECRET, now: NOW }),
    null,
    're-pointing the id invalidates the MAC',
  );
  assert.equal(verifyShareLink('', { scope: 'document', authSecret: SECRET, now: NOW }), null);
  assert.equal(verifyShareLink('a.b.c', { scope: 'document', authSecret: SECRET, now: NOW }), null);
  assert.equal(verifyShareLink(null, { scope: 'document', authSecret: SECRET, now: NOW }), null);
});

test('wrong scope is rejected in both directions, and the route owns the expected scope', () => {
  const invoice = signShareLink({ scope: 'invoice', documentId: DOC_A, authSecret: SECRET, now: NOW });
  const document = signShareLink({ scope: 'document', documentId: DOC_A, authSecret: SECRET, now: NOW });

  assert.equal(verifyShareLink(invoice.token, { scope: 'document', authSecret: SECRET, now: NOW }), null);
  assert.equal(verifyShareLink(document.token, { scope: 'invoice', authSecret: SECRET, now: NOW }), null);
  assert.equal(
    verifyShareLink(document.token, { scope: 'bogus', authSecret: SECRET, now: NOW }),
    null,
    'an unknown expected scope never verifies anything',
  );
});

test('a tracking token never opens a document and a document token never opens tracking', () => {
  const track = signTrackLink({ tripId: 'trip-1', authSecret: SECRET, now: NOW });
  assert.equal(verifyShareLink(track.token, { scope: 'document', authSecret: SECRET, now: NOW }), null);
  assert.equal(verifyShareLink(track.token, { scope: 'invoice', authSecret: SECRET, now: NOW }), null);

  const share = signShareLink({ scope: 'document', documentId: DOC_A, authSecret: SECRET, now: NOW });
  assert.equal(verifyTrackLink(share.token, { authSecret: SECRET, now: NOW }), null);
});

test('the scoped sub round-trips and never misreads an unscoped trip sub', () => {
  assert.deepEqual(decodeShareSub(encodeShareSub('invoice', DOC_A, 3)), {
    scope: 'invoice',
    documentId: DOC_A,
    version: 3,
  });
  assert.deepEqual(decodeShareSub(encodeShareSub('document', DOC_A, 0)), {
    scope: 'document',
    documentId: DOC_A,
    version: 0,
  });
  assert.equal(decodeShareSub('trip-1'), null, 'a tracking sub is not a share sub');
  assert.equal(decodeShareSub('trip-1~2'), null);
  assert.equal(decodeShareSub(`${SHARE_SUB_PREFIX}admin:${DOC_A}`), null, 'unknown scope');
  assert.equal(decodeShareSub(`${SHARE_SUB_PREFIX}document:`), null, 'no id');
  assert.equal(decodeShareSub(null), null);
  assert.throws(() => encodeShareSub('bogus', DOC_A, 0), /scope must be one of/);
  assert.throws(() => encodeShareSub('document', '  ', 0), /documentId is required/);
});

test('scopes and URLs are the documented /g/<scope>/<token> shape', () => {
  assert.deepEqual([...GUEST_SCOPES], ['document', 'invoice']);
  assert.equal(isGuestScope('document'), true);
  assert.equal(isGuestScope('track'), false);
  assert.equal(publicGuestUrl('', 'document', 'tok'), '/g/document/tok');
  assert.equal(publicGuestUrl('https://roadwisefleet.com/', 'invoice', 'tok'), 'https://roadwisefleet.com/g/invoice/tok');
  assert.throws(() => publicGuestUrl('', 'track', 'tok'), /scope must be one of/);
});

// --- document read model ----------------------------------------------------

test('an invoice row is only reachable on the invoice scope and vice versa', () => {
  assert.equal(shareScopeForDocType('invoice'), 'invoice');
  assert.equal(shareScopeForDocType('pod'), 'document');
  assert.equal(shareScopeForDocType('ecmr'), 'document');

  assert.equal(scopeAllowsDocType('invoice', 'invoice'), true);
  assert.equal(scopeAllowsDocType('invoice', 'pod'), false);
  assert.equal(scopeAllowsDocType('document', 'invoice'), false);
  assert.equal(scopeAllowsDocType('document', 'pod'), true);
  assert.equal(scopeAllowsDocType('document', undefined), false);
});

test('only uploaded/verified documents are shareable', () => {
  assert.equal(isShareableDocumentStatus('UPLOADED'), true);
  assert.equal(isShareableDocumentStatus('VERIFIED'), true);
  assert.equal(isShareableDocumentStatus('PENDING'), false, 'no bytes yet');
  assert.equal(isShareableDocumentStatus('REJECTED'), false, 'the per-document revoke');
  assert.equal(isShareableDocumentStatus(null), false);
});

test('loadGuestDocument returns the document for a matching token version', async () => {
  const prisma = fakePrisma(docRow());
  const result = await loadGuestDocument(prisma, { scope: 'document', documentId: DOC_A, version: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.document.id, DOC_A);
});

test('a version bump on the owning trip revokes the document link', async () => {
  const prisma = fakePrisma(docRow({ trip: { ...docRow().trip, trackLinkVersion: 2 } }));
  const stale = await loadGuestDocument(prisma, { scope: 'document', documentId: DOC_A, version: 1 });
  assert.deepEqual(stale, { ok: false, error: 'not_found' });
  const fresh = await loadGuestDocument(prisma, { scope: 'document', documentId: DOC_A, version: 2 });
  assert.equal(fresh.ok, true);
});

test('a token for document A can never load document B', async () => {
  const prisma = fakePrisma(docRow());
  const tokenB = signShareLink({ scope: 'document', documentId: DOC_B, authSecret: SECRET, now: NOW });
  const verifiedA = verifyShareLink(
    signShareLink({ scope: 'document', documentId: DOC_A, authSecret: SECRET, now: NOW }).token,
    { scope: 'document', authSecret: SECRET, now: NOW },
  );
  assert.ok(verifiedA);
  // The id comes from the signed token: A's token resolves A, and B's token —
  // whose id this fixture has no row for — resolves nothing.
  assert.equal((await loadGuestDocument(prisma, verifiedA)).ok, true);
  const verifiedB = verifyShareLink(tokenB.token, { scope: 'document', authSecret: SECRET, now: NOW });
  assert.ok(verifiedB);
  assert.deepEqual(await loadGuestDocument(prisma, verifiedB), { ok: false, error: 'not_found' });
});

test('a document of the wrong type for the scope, or in a non-shareable status, is not served', async () => {
  const invoiceOnDocumentScope = await loadGuestDocument(fakePrisma(docRow({ docType: 'invoice' })), {
    scope: 'document',
    documentId: DOC_A,
    version: 0,
  });
  assert.deepEqual(invoiceOnDocumentScope, { ok: false, error: 'not_found' });

  const podOnInvoiceScope = await loadGuestDocument(fakePrisma(docRow({ docType: 'pod' })), {
    scope: 'invoice',
    documentId: DOC_A,
    version: 0,
  });
  assert.deepEqual(podOnInvoiceScope, { ok: false, error: 'not_found' });

  for (const status of ['PENDING', 'REJECTED']) {
    const rejected = await loadGuestDocument(fakePrisma(docRow({ status })), {
      scope: 'document',
      documentId: DOC_A,
      version: 0,
    });
    assert.deepEqual(rejected, { ok: false, error: 'not_found' }, status);
  }
});

test('an unknown document id is not_found without leaking anything', async () => {
  assert.deepEqual(
    await loadGuestDocument(fakePrisma(docRow()), { scope: 'document', documentId: 'nope', version: 0 }),
    { ok: false, error: 'not_found' },
  );
  assert.deepEqual(
    await loadGuestDocument(fakePrisma(docRow()), { scope: 'document', documentId: '', version: 0 }),
    { ok: false, error: 'not_found' },
  );
});

// --- response headers ------------------------------------------------------

test('a document downloads and an invoice opens inline, with a header-safe filename', () => {
  assert.equal(
    contentDisposition('document', 'doc-aaaaaaaaaaaaaaaa-pod.jpg'),
    'attachment; filename="doc-aaaaaaaaaaaaaaaa-pod.jpg"',
  );
  assert.equal(contentDisposition('invoice', 'inv-1.pdf'), 'inline; filename="inv-1.pdf"');
  // A stored basename can never inject a header.
  const hostile = contentDisposition('document', 'a"; filename="x.exe\r\nX-Evil: 1');
  assert.equal(hostile.includes('\r'), false);
  assert.equal(hostile.includes('\n'), false);
  assert.equal(hostile.split(';').length, 2);
  assert.equal(hostile.startsWith('attachment; filename="'), true);
});

test('the content type comes from the stored extension, never from a guess', () => {
  assert.equal(documentContentType('trip/pod/x-pod.jpg'), 'image/jpeg');
  assert.equal(documentContentType('trip/ecmr/x.pdf'), 'application/pdf');
  assert.equal(documentContentType('trip/ecmr/x.png'), 'image/png');
  assert.equal(documentContentType('trip/ecmr/weird.bin'), 'application/octet-stream');
  assert.equal(documentContentType(null), 'application/octet-stream');
});

test('the download filename is the stored basename, sanitised again', () => {
  assert.equal(documentFileName('trip-1/pod/doc-a-pod.jpg'), 'doc-a-pod.jpg');
  assert.equal(documentFileName('doc-a-pod.jpg'), 'doc-a-pod.jpg');
  assert.equal(documentFileName(''), 'document');
  assert.equal(documentFileName(null), 'document');
});

// --- mint / reconstruct -----------------------------------------------------

test('minting is deterministic inside the shipment window and dies with it', () => {
  const trip = docRow().trip;
  const first = mintDocumentLink(trip, docRow(), { scope: 'document', authSecret: SECRET, now: NOW + 60 });
  const second = mintDocumentLink(trip, docRow(), { scope: 'document', authSecret: SECRET, now: NOW + 600 });
  assert.ok(first && second);
  assert.equal(first.token, second.token, 'HMAC over the persisted window: the same link every time');
  assert.equal(verifyShareLink(first.token, { scope: 'document', authSecret: SECRET, now: NOW }).version, 0);

  // No live trip link -> nothing to bind to.
  const noLink = mintDocumentLink(
    { ...trip, trackLinkIssuedAt: null, trackLinkExpiresAt: null },
    docRow(),
    { scope: 'document', authSecret: SECRET, now: NOW },
  );
  assert.equal(noLink, null);
  const expired = mintDocumentLink(trip, docRow(), { scope: 'document', authSecret: SECRET, now: NOW + 3601 });
  assert.equal(expired, null);
});

test('the shaped link carries only the capability, never the storage key', () => {
  const link = { token: 'tok', expiresAt: '2026-01-01T00:00:00.000Z', ttlSeconds: 60, version: 0 };
  const shaped = shapeDocumentLink({ scope: 'invoice', link }, 'https://roadwisefleet.com');
  assert.deepEqual(Object.keys(shaped).sort(), ['expiresAt', 'scope', 'token', 'ttlSeconds', 'url']);
  assert.equal(shaped.url, 'https://roadwisefleet.com/g/invoice/tok');
  assert.equal(JSON.stringify(shaped).includes('storageKey'), false);
});
