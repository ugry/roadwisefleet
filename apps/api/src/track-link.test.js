/**
 * Unit tests for the customer tracking link (board task #5).
 *
 * Runs on the Node.js native test runner with **no install**: only node:*
 * builtins and pure project modules are imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TRACK_TTL_SECONDS,
  decodeTrackSub,
  deriveTrackSecret,
  encodeTrackSub,
  isTrackLinkActive,
  loadTrackedTrip,
  publicTrackUrl,
  reconstructTrackLink,
  shapeTrackedTrip,
  signTrackLink,
  trackingSummary,
  trackTripInclude,
  verifyTrackLink,
} from './track-link.js';
import { signToken, verifyToken } from './auth/tokens.js';

const SECRET = 'test-auth-secret';
const NOW = 1_800_000_000; // fixed epoch seconds

test('a signed link round-trips and carries the trip id and expiry', () => {
  const { token, expiresAt, ttlSeconds } = signTrackLink({
    tripId: 'trip-1',
    authSecret: SECRET,
    now: NOW,
  });

  assert.equal(ttlSeconds, DEFAULT_TRACK_TTL_SECONDS);
  assert.equal(new Date(expiresAt).getTime(), (NOW + DEFAULT_TRACK_TTL_SECONDS) * 1000);

  const verified = verifyTrackLink(token, { authSecret: SECRET, now: NOW + 10 });
  assert.ok(verified);
  assert.equal(verified.tripId, 'trip-1');
  assert.equal(verified.exp, NOW + DEFAULT_TRACK_TTL_SECONDS);
});

test('the default lifetime is 30 days and can be configured', () => {
  assert.equal(DEFAULT_TRACK_TTL_SECONDS, 30 * 24 * 60 * 60);
  const short = signTrackLink({ tripId: 'trip-1', authSecret: SECRET, ttlSeconds: 60, now: NOW });
  assert.equal(short.ttlSeconds, 60);
  assert.ok(verifyTrackLink(short.token, { authSecret: SECRET, now: NOW + 59 }));
  assert.equal(verifyTrackLink(short.token, { authSecret: SECRET, now: NOW + 60 }), null);
});

test('an expired token is rejected', () => {
  const { token } = signTrackLink({ tripId: 'trip-1', authSecret: SECRET, now: NOW });
  assert.ok(verifyTrackLink(token, { authSecret: SECRET, now: NOW + DEFAULT_TRACK_TTL_SECONDS - 1 }));
  assert.equal(
    verifyTrackLink(token, { authSecret: SECRET, now: NOW + DEFAULT_TRACK_TTL_SECONDS }),
    null,
  );
});

test('a token cannot be replayed for another trip (payload tampering breaks the signature)', () => {
  const { token } = signTrackLink({ tripId: 'trip-1', authSecret: SECRET, now: NOW });
  const [header, payload, signature] = token.split('.');

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.sub, 'trip-1');
  claims.sub = 'trip-2';
  const forged =
    `${header}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;

  assert.equal(verifyTrackLink(forged, { authSecret: SECRET, now: NOW + 10 }), null);
  // The genuine token still resolves to its own trip.
  assert.equal(verifyTrackLink(token, { authSecret: SECRET, now: NOW + 10 }).tripId, 'trip-1');
});

test('rotating the signing secret revokes every outstanding link', () => {
  const { token } = signTrackLink({ tripId: 'trip-1', authSecret: SECRET, now: NOW });
  assert.ok(verifyTrackLink(token, { authSecret: SECRET, now: NOW + 10 }));
  // A rotation — the dedicated override or a new AUTH_SECRET — kills the link.
  assert.equal(verifyTrackLink(token, { authSecret: SECRET, secret: 'rotated', now: NOW + 10 }), null);
  assert.equal(verifyTrackLink(token, { authSecret: 'other-secret', now: NOW + 10 }), null);
});

test('the dedicated TRACK_LINK_SECRET overrides the derived key', () => {
  const { token } = signTrackLink({ tripId: 'trip-1', authSecret: SECRET, secret: 'dedicated', now: NOW });
  assert.ok(verifyTrackLink(token, { authSecret: SECRET, secret: 'dedicated', now: NOW + 1 }));
  assert.equal(verifyTrackLink(token, { authSecret: SECRET, now: NOW + 1 }), null);
});

test('a session token can never verify as a tracking link (and vice versa)', () => {
  const derived = deriveTrackSecret(SECRET);
  const sessionToken = signToken({ sub: 'user-1', org: 'org-1', role: 'owner', name: 'Ada' }, derived, {
    now: NOW,
  });
  assert.equal(verifyTrackLink(sessionToken, { authSecret: SECRET, now: NOW + 10 }), null);

  const { token } = signTrackLink({ tripId: 'trip-1', authSecret: SECRET, now: NOW });
  // The tracking token is signed with the derived key, not AUTH_SECRET itself.
  assert.equal(verifyToken(token, SECRET, { now: NOW + 10 }), null);
  assert.equal(deriveTrackSecret(SECRET) === SECRET, false);
});

test('malformed input is rejected without throwing', () => {
  for (const bad of [null, undefined, '', 'not-a-token', 'a.b', 'a.b.c.d', 42, {}]) {
    assert.equal(verifyTrackLink(bad, { authSecret: SECRET, now: NOW }), null);
  }
  assert.equal(verifyTrackLink('a.b.c', { now: NOW }), null); // missing secret
  assert.throws(() => signTrackLink({ tripId: '', authSecret: SECRET }), TypeError);
  assert.throws(() => deriveTrackSecret(''), TypeError);
});

test('publicTrackUrl is origin-relative without a base and absolute with one', () => {
  assert.equal(publicTrackUrl('', 'tok en'), '/track/tok%20en');
  assert.equal(publicTrackUrl(undefined, 'tok'), '/track/tok');
  assert.equal(publicTrackUrl('https://roadwisefleet.com/', 'tok'), 'https://roadwisefleet.com/track/tok');
});

test('the public payload is PII-free and maps the timeline', () => {
  const trip = {
    id: 'trip-1',
    status: 'IN_TRANSIT',
    rateEur: { toNumber: () => 1800 },
    driverId: 'user-9',
    driver: { id: 'user-9', name: 'Greta', phone: '+49 170 000' },
    order: { origin: 'Hamburg', destination: 'Łódź', cargo: 'Machine parts', customer: { name: 'ACME' } },
    statusEvents: [
      { fromStatus: 'DRAFT', toStatus: 'ASSIGNED', happenedAt: '2026-09-20T08:00:00.000Z' },
      { fromStatus: 'ASSIGNED', toStatus: 'IN_TRANSIT', happenedAt: '2026-09-21T06:30:00.000Z' },
    ],
    gpsPings: [{ at: '2026-09-21T12:00:00.000Z', lat: { toNumber: () => 52.3759 }, lng: 9.732 }],
    documents: [{ id: 'doc-1', docType: 'pod', status: 'UPLOADED', storageKey: '/secret/path' }],
    expenses: [{ amountEur: 200 }],
  };

  const shaped = shapeTrackedTrip(trip, { podAvailable: true });

  assert.deepEqual(shaped.route, { origin: 'Hamburg', destination: 'Łódź', cargo: 'Machine parts' });
  assert.equal(shaped.status, 'IN_TRANSIT');
  assert.deepEqual(shaped.statusTimeline, [
    { from: 'DRAFT', to: 'ASSIGNED', at: '2026-09-20T08:00:00.000Z' },
    { from: 'ASSIGNED', to: 'IN_TRANSIT', at: '2026-09-21T06:30:00.000Z' },
  ]);
  assert.deepEqual(shaped.lastKnownPosition, { at: '2026-09-21T12:00:00.000Z', lat: 52.3759, lng: 9.732 });
  assert.equal(shaped.eta, null);
  assert.deepEqual(shaped.pod, { available: true });
  assert.deepEqual(Object.keys(shaped).sort(), [
    'eta',
    'lastKnownPosition',
    'pod',
    'route',
    'status',
    'statusTimeline',
  ]);
  // Belt and braces: the serialised payload contains no PII at all.
  const json = JSON.stringify(shaped);
  for (const secret of ['Greta', '+49 170 000', 'ACME', '1800', 'storageKey', 'expenses', 'driver']) {
    assert.equal(json.includes(secret), false, `payload leaked ${secret}`);
  }
});

test('a trip without pings has no position and no POD', () => {
  const shaped = shapeTrackedTrip({
    id: 'trip-2',
    status: 'DRAFT',
    order: { origin: 'A', destination: 'B', cargo: null },
    statusEvents: [],
    gpsPings: [],
  });
  assert.equal(shaped.lastKnownPosition, null);
  assert.deepEqual(shaped.statusTimeline, []);
  assert.deepEqual(shaped.pod, { available: false });
});

test('loadTrackedTrip scopes by the signed trip id and flags POD availability', async () => {
  const calls = [];
  const trip = {
    id: 'trip-1',
    status: 'DELIVERED',
    order: { origin: 'A', destination: 'B', cargo: null },
    statusEvents: [],
    gpsPings: [],
  };
  const prisma = {
    trip: {
      findFirst: async (args) => {
        calls.push(args);
        return args.where.id === 'trip-1' ? trip : null;
      },
    },
    document: { count: async () => 1 },
  };

  const found = await loadTrackedTrip(prisma, { tripId: 'trip-1' });
  assert.equal(found.ok, true);
  assert.deepEqual(found.trip.pod, { available: true });
  assert.deepEqual(calls[0].where, { id: 'trip-1' });

  const missing = await loadTrackedTrip(prisma, { tripId: 'trip-9' });
  assert.deepEqual(missing, { ok: false, error: 'not_found' });
  assert.deepEqual(await loadTrackedTrip(prisma, { tripId: '' }), { ok: false, error: 'not_found' });
});

test('the public read never loads driver, customer or expense relations', () => {
  const include = JSON.stringify(trackTripInclude());
  for (const forbidden of ['driver', 'customer', 'expenses', 'settlement', 'documents']) {
    assert.equal(include.includes(forbidden), false, `read model must not include ${forbidden}`);
  }
});

// --- per-trip revocation and stored state (board task #39, F8) ---------------

test('a versioned token round-trips and keeps the trip id intact', () => {
  const link = signTrackLink({ tripId: 'trip-1', version: 3, authSecret: SECRET, now: NOW });
  assert.equal(link.version, 3);
  const verified = verifyTrackLink(link.token, { authSecret: SECRET, now: NOW + 10 });
  assert.equal(verified.tripId, 'trip-1');
  assert.equal(verified.version, 3);
  // An unversioned token stays version 0 and its `sub` is the bare trip id.
  const legacy = signTrackLink({ tripId: 'trip-1', authSecret: SECRET, now: NOW });
  assert.equal(legacy.version, 0);
  assert.equal(verifyTrackLink(legacy.token, { authSecret: SECRET, now: NOW + 1 }).version, 0);
  const sub = JSON.parse(Buffer.from(legacy.token.split('.')[1], 'base64url').toString('utf8')).sub;
  assert.equal(sub, 'trip-1');
});

test('encodeTrackSub / decodeTrackSub are inverse and reject junk safely', () => {
  assert.equal(encodeTrackSub('t1', 0), 't1');
  assert.equal(encodeTrackSub('t1', undefined), 't1');
  assert.equal(encodeTrackSub('t1', -2), 't1');
  assert.equal(encodeTrackSub('t1', 2.9), 't1~2');
  assert.deepEqual(decodeTrackSub('t1'), { tripId: 't1', version: 0 });
  assert.deepEqual(decodeTrackSub('t1~7'), { tripId: 't1', version: 7 });
  // Malformed versions fall back to "legacy, version 0" rather than throwing.
  assert.deepEqual(decodeTrackSub('t1~x'), { tripId: 't1~x', version: 0 });
  assert.deepEqual(decodeTrackSub('t1~'), { tripId: 't1~', version: 0 });
  assert.deepEqual(decodeTrackSub(null), { tripId: '', version: 0 });
});

test('a token for an older version is not found after the trip is revoked', async () => {
  const token = signTrackLink({ tripId: 'trip-1', version: 0, authSecret: SECRET, now: NOW });
  const verified = verifyTrackLink(token.token, { authSecret: SECRET, now: NOW + 5 });
  const baseTrip = {
    id: 'trip-1',
    status: 'IN_TRANSIT',
    order: { origin: 'A', destination: 'B', cargo: null },
    statusEvents: [],
    gpsPings: [],
  };
  const client = (trackLinkVersion) => ({
    trip: { findFirst: async () => ({ ...baseTrip, trackLinkVersion }) },
    document: { count: async () => 0 },
  });

  // Same version -> the token still resolves.
  assert.equal((await loadTrackedTrip(client(0), { tripId: verified.tripId, version: verified.version })).ok, true);
  // Revoked (version bumped) -> indistinguishable from an unknown id.
  assert.deepEqual(
    await loadTrackedTrip(client(1), { tripId: verified.tripId, version: verified.version }),
    { ok: false, error: 'not_found' },
  );
  // A fresh token at the new version works again.
  const fresh = verifyTrackLink(
    signTrackLink({ tripId: 'trip-1', version: 1, authSecret: SECRET, now: NOW + 6 }).token,
    { authSecret: SECRET, now: NOW + 7 },
  );
  assert.equal((await loadTrackedTrip(client(1), { tripId: fresh.tripId, version: fresh.version })).ok, true);
  // Omitting the version keeps the old (version-unaware) callers working.
  assert.equal((await loadTrackedTrip(client(1), { tripId: 'trip-1' })).ok, true);
});

test('reconstructTrackLink recomputes the identical token from the stored state', () => {
  const issuedAt = new Date(NOW * 1000);
  const expiresAt = new Date((NOW + 3600) * 1000);
  const trip = { id: 'trip-1', trackLinkVersion: 2, trackLinkIssuedAt: issuedAt, trackLinkExpiresAt: expiresAt };

  const rebuilt = reconstructTrackLink(trip, { authSecret: SECRET, now: (NOW + 10) * 1000 });
  const direct = signTrackLink({
    tripId: 'trip-1',
    version: 2,
    authSecret: SECRET,
    ttlSeconds: 3600,
    now: NOW,
  });
  assert.equal(rebuilt.token, direct.token, 'the recomputed link must be byte-for-byte the minted one');
  assert.equal(rebuilt.expiresAt, direct.expiresAt);
  assert.equal(rebuilt.version, 2);

  // Expired / never minted / half-written state -> no link.
  const later = (NOW + 7200) * 1000;
  assert.equal(reconstructTrackLink(trip, { authSecret: SECRET, now: later }), null);
  assert.equal(reconstructTrackLink({ id: 'trip-1' }, { authSecret: SECRET }), null);
  assert.equal(
    reconstructTrackLink({ id: 'trip-1', trackLinkIssuedAt: issuedAt }, { authSecret: SECRET, now: NOW * 1000 }),
    null,
  );
  assert.equal(
    reconstructTrackLink({ id: 't1', trackLinkIssuedAt: expiresAt, trackLinkExpiresAt: issuedAt }, { authSecret: SECRET, now: NOW * 1000 }),
    null,
  );
});

test('isTrackLinkActive / trackingSummary use the stored expiry without leaking a token', () => {
  const issuedAt = new Date(NOW * 1000);
  const expiresAt = new Date((NOW + 60) * 1000);
  const trip = { id: 'trip-1', trackLinkIssuedAt: issuedAt, trackLinkExpiresAt: expiresAt };

  assert.equal(isTrackLinkActive(trip, { now: NOW * 1000 }), true);
  assert.equal(isTrackLinkActive(trip, { now: (NOW + 59) * 1000 }), true);
  assert.equal(isTrackLinkActive(trip, { now: (NOW + 60) * 1000 }), false);

  assert.deepEqual(trackingSummary(trip, { now: NOW * 1000 }), {
    active: true,
    expiresAt: expiresAt.toISOString(),
  });
  assert.deepEqual(trackingSummary(trip, { now: (NOW + 60) * 1000 }), { active: false, expiresAt: null });
  assert.deepEqual(trackingSummary({ id: 'trip-2' }, { now: NOW * 1000 }), { active: false, expiresAt: null });
  // The summary is exactly two fields: there is no `token` to leak.
  assert.deepEqual(Object.keys(trackingSummary(trip, { now: NOW * 1000 })).sort(), ['active', 'expiresAt']);
});
