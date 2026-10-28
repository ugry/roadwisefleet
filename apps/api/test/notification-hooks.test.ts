/**
 * Hook-level acceptance for `driver_assigned` (board #136, UXF-O2a follow-up).
 *
 * The contract this file pins:
 *   - one `driver_assigned` envelope per ACTUAL assignment change;
 *   - none when the driver id is unchanged — an idempotent re-assign must not
 *     queue a second envelope for a state that did not move;
 *   - the no-op path returns before any database work (the fake client throws on
 *     any call, so the assertion cannot pass by accident);
 *   - callers that do not pass `previousDriverId` (the create-trip path, which
 *     is a new assignment by definition) still emit exactly one envelope.
 *
 * It drives the real `notification-hooks.ts` against a temp spool and a fake
 * Prisma client, so no database is needed and the test always runs. The pure
 * rule (`isAssignmentChange`) and the route wiring are covered by the
 * dependency-free suite in `../src/notifications.test.js`.
 *
 * Runs with the real API dependencies (`tsx`):
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job `node --test apps/api/src/` never
 * imports a `.ts` module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set before `env.ts` is imported: the spool is read from it once, at
// import time, and `AUTH_SECRET` throws without the local package `.env`.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';
const SPOOL = mkdtempSync(join(tmpdir(), 'rwf-notify-hooks-'));
process.env.RWF_NOTIFY_SPOOL = SPOOL;

const { notifyDriverAssigned } = await import('../src/notification-hooks.js');

/* ------------------------------------------------------------- fixtures --- */

/** The trip columns the hook's `TRIP_SELECT` reads, with a driver already on it. */
const TRIP = {
  id: 'trip_136',
  orgId: 'org_1',
  orderId: 'order_1042',
  rateEur: 1200,
  status: 'ASSIGNED',
  trackLinkVersion: 1,
  trackLinkIssuedAt: null,
  trackLinkExpiresAt: null,
  driverId: 'driver_b',
  order: {
    id: 'order_1042',
    customerId: 'cust_1',
    origin: 'Lagos, NG',
    destination: 'Accra, GH',
    plannedAt: new Date('2026-10-30T09:00:00Z'),
  },
  driver: { name: 'Bola Adeyemi' },
  truck: { plate: 'LAG-447-XY' },
};

const CUSTOMER = {
  id: 'cust_1',
  name: 'Ada Obi',
  email: 'ada@example.com',
  whatsappId: '',
  profile: { notifyPrefs: null },
  accounts: [],
};

/** Spool files written so far (the emitter names them `<event>-<ref>-…key`). */
function envelopes(): string[] {
  return readdirSync(SPOOL)
    .filter((name) => name.endsWith('.key'))
    .sort();
}

function envelopeText(file: string): string {
  return readFileSync(join(SPOOL, file), 'utf8');
}

/**
 * A fake Prisma client that records every read. Passing `forbid` makes any
 * database access an assertion failure, which is how the no-op case proves it
 * short-circuits.
 */
function fakePrisma({ forbid = false } = {}) {
  const calls: string[] = [];
  const touch = (call: string) => {
    calls.push(call);
    if (forbid) throw new Error(`unexpected database access: ${call}`);
  };
  return {
    calls,
    trip: {
      findUnique: async ({ where }: any) => {
        touch(`trip.findUnique:${where?.id}`);
        return TRIP;
      },
    },
    customer: {
      findUnique: async ({ where }: any) => {
        touch(`customer.findUnique:${where?.id}`);
        return CUSTOMER;
      },
    },
  };
}

test('an actual assignment change writes exactly one driver_assigned envelope', async () => {
  const before = envelopes().length;
  const prisma = fakePrisma();
  const result = await notifyDriverAssigned(prisma, {
    trip: TRIP,
    previousDriverId: 'driver_prev',
  });

  assert.equal(result.ok, true);
  const written = envelopes();
  assert.equal(written.length, before + 1, 'one change ⇒ one envelope');
  const file = written[written.length - 1];
  assert.match(file, /^driver_assigned-/);

  const body = envelopeText(file);
  const lines = body.split('\n');
  // The envelope is `key=value` lines (§3.1 of infra/notifications.md).
  const field = (key: string) => {
    const line = lines.find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : null;
  };
  assert.equal(field('event'), 'driver_assigned');
  assert.equal(field('channel'), 'email');
  assert.equal(field('recipient'), 'ada@example.com');
  assert.equal(field('driver_name'), 'Bola Adeyemi');
  assert.equal(field('vehicle'), 'LAG-447-XY');
  assert.equal(field('customer_name'), 'Ada Obi');
  // The previous driver is never named: the envelope describes the new state.
  assert.ok(!body.includes('driver_prev'), 'the envelope must not name the previous driver');
  assert.equal(prisma.calls.length, 2, 'trip + customer lookup, nothing else');
});

test('an idempotent re-assign (same driver id) writes no envelope and reads nothing', async () => {
  const before = envelopes().length;
  const prisma = fakePrisma({ forbid: true });
  const result = await notifyDriverAssigned(prisma, {
    trip: TRIP,
    previousDriverId: TRIP.driverId,
  });

  assert.deepEqual(result, { ok: true, skipped: 'unchanged' });
  assert.equal(envelopes().length, before, 'no envelope for an unchanged state');
  assert.deepEqual(prisma.calls, [], 'the guard runs before any database work');
});

test('a caller that passes no previousDriverId still emits (create-trip path)', async () => {
  const before = envelopes().length;
  const prisma = fakePrisma();
  const result = await notifyDriverAssigned(prisma, { trip: TRIP });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.equal(envelopes().length, before + 1);
});

test('the tripId-only form keeps working (unchanged contract for other callers)', async () => {
  const before = envelopes().length;
  const prisma = fakePrisma();
  const result = await notifyDriverAssigned(prisma, { tripId: TRIP.id });

  assert.equal(result.ok, true);
  assert.equal(envelopes().length, before + 1);
  assert.deepEqual(prisma.calls, [`trip.findUnique:${TRIP.id}`, 'customer.findUnique:cust_1']);
});

test('a moving driver sequence emits once per change, never per attempt', async () => {
  const before = envelopes().length;

  // driver_prev → driver_b: a change.
  await notifyDriverAssigned(fakePrisma(), { trip: TRIP, previousDriverId: 'driver_prev' });
  // driver_b → driver_b: the retried/idempotent request, no envelope.
  await notifyDriverAssigned(fakePrisma({ forbid: true }), {
    trip: TRIP,
    previousDriverId: TRIP.driverId,
  });
  // driver_b → driver_prev: a change again (the trip object is re-read per request).
  await notifyDriverAssigned(fakePrisma(), {
    trip: { ...TRIP, driverId: 'driver_prev' },
    previousDriverId: 'driver_b',
  });

  assert.equal(envelopes().length, before + 2, 'two real changes ⇒ two envelopes');
});

test('the guard covers a cleared driver too', async () => {
  const before = envelopes().length;
  // A trip with no driver, re-assigned "to nobody": still not a change.
  const cleared = { ...TRIP, driverId: null };
  const result = await notifyDriverAssigned(fakePrisma({ forbid: true }), {
    trip: cleared,
    previousDriverId: null,
  });
  assert.deepEqual(result, { ok: true, skipped: 'unchanged' });
  assert.equal(envelopes().length, before);
});

test.after(() => {
  rmSync(SPOOL, { recursive: true, force: true });
});
