/**
 * Pilot seed — idempotent, no email.
 *
 * Creates one pilot org, the four roles, one admin (owner), three drivers, a
 * truck, a customer, two orders and two trips. Safe to re-run: every record
 * uses a fixed id and is upserted.
 *
 * Passwords are hashed with `node:crypto` scrypt (see src/auth/password.js) —
 * no heavy deps. Supply the password with `--password=<value>` or
 * `SEED_PASSWORD`; otherwise a random one is generated and printed once.
 *
 * Pass `--reset` to first delete every pilot-org trip that the seed does not
 * own (and its dependent rows), so a demo starts from exactly the two seeded
 * trips (GitHub issue #12). The reset runs before the upserts below.
 *
 *   pnpm --filter @roadwisefleet/api db:seed -- --password=...
 *   pnpm --filter @roadwisefleet/api db:reset -- --password=...
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import '../src/env.js'; // loads apps/api/.env into process.env
import { hashPassword } from '../src/auth/password.js';
import { planDemoReset } from '../src/demo-reset.js';

const ORG_ID = 'pilot-org';
const RESET = process.argv.includes('--reset');
const PASSWORD_ARG = process.argv.find((a) => a.startsWith('--password='))?.slice('--password='.length);

const password = PASSWORD_ARG || process.env.SEED_PASSWORD || randomBytes(12).toString('base64url');
const generated = !PASSWORD_ARG && !process.env.SEED_PASSWORD;

const ROLES = [
  ['owner', ['org:manage', 'user:manage', 'trip:*', 'invoice:*', 'settlement:*', 'reports:read']],
  ['dispatcher', ['trip:*', 'user:read', 'reports:read']],
  ['accountant', ['invoice:*', 'settlement:*', 'reports:read']],
  ['driver', ['trip:read', 'trip:status', 'pod:upload', 'expense:create']],
] as const;

const USERS = [
  { id: 'pilot-admin', roleId: 'owner', name: 'Pilot Admin', email: 'admin@pilot.roadwisefleet.test' },
  { id: 'pilot-driver-1', roleId: 'driver', name: 'Driver One', email: 'driver1@pilot.roadwisefleet.test' },
  { id: 'pilot-driver-2', roleId: 'driver', name: 'Driver Two', email: 'driver2@pilot.roadwisefleet.test' },
  { id: 'pilot-driver-3', roleId: 'driver', name: 'Driver Three', email: 'driver3@pilot.roadwisefleet.test' },
] as const;

const TRUCKS = [
  { id: 'pilot-truck-1', plate: 'RW-001', euroClass: 'Euro 6' },
  { id: 'pilot-truck-2', plate: 'RW-002', euroClass: 'Euro 6' },
] as const;

const ORDERS = [
  { id: 'pilot-order-1', origin: 'Berlin, DE', destination: 'Hamburg, DE', cargo: 'Palletised goods' },
  { id: 'pilot-order-2', origin: 'Munich, DE', destination: 'Vienna, AT', cargo: 'Refrigerated goods' },
] as const;

const prisma = new PrismaClient();

/**
 * Delete every pilot-org trip the seed does not own, plus its dependent rows.
 * `planDemoReset` (pure, see src/demo-reset.js) decides what is residual; this
 * function only performs the writes. Returns the number of trips removed.
 */
async function resetResidualTrips(): Promise<number> {
  const trips = await prisma.trip.findMany({ where: { orgId: ORG_ID }, select: { id: true } });
  const { remove } = planDemoReset(trips);

  if (remove.length === 0) {
    console.log('Reset: no residual trips to remove.');
    return 0;
  }

  const where = { tripId: { in: remove } };
  await prisma.$transaction([
    prisma.statusEvent.deleteMany({ where }),
    prisma.gpsPing.deleteMany({ where }),
    prisma.expense.deleteMany({ where }),
    prisma.document.deleteMany({ where }),
    prisma.settlement.deleteMany({ where }),
    prisma.tripStop.deleteMany({ where }),
    prisma.tripDriver.deleteMany({ where }),
    prisma.trip.deleteMany({ where: { id: { in: remove } } }),
  ]);

  console.log(`Reset: removed ${remove.length} residual trip(s): ${remove.join(', ')}`);
  return remove.length;
}

async function main() {
  if (RESET) await resetResidualTrips();

  const passwordHash = hashPassword(password);

  const org = await prisma.org.upsert({
    where: { id: ORG_ID },
    update: { name: 'Pilot Logistics GmbH' },
    create: { id: ORG_ID, name: 'Pilot Logistics GmbH', locale: 'en', dataRegion: 'eu', plan: 'free' },
  });

  for (const [id, permissions] of ROLES) {
    await prisma.role.upsert({
      where: { id },
      update: { permissions: [...permissions] },
      create: { id, permissions: [...permissions] },
    });
  }

  for (const u of USERS) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { name: u.name, email: u.email, roleId: u.roleId, orgId: ORG_ID, passwordHash },
      create: {
        id: u.id,
        name: u.name,
        email: u.email,
        roleId: u.roleId,
        orgId: ORG_ID,
        passwordHash,
        lang: 'en',
      },
    });
  }

  for (const t of TRUCKS) {
    await prisma.truck.upsert({
      where: { id: t.id },
      update: { plate: t.plate, euroClass: t.euroClass },
      create: { id: t.id, orgId: ORG_ID, plate: t.plate, euroClass: t.euroClass },
    });
  }

  const customer = await prisma.customer.upsert({
    where: { id: 'pilot-customer' },
    update: { name: 'Acme Freight' },
    create: { id: 'pilot-customer', orgId: ORG_ID, name: 'Acme Freight', email: 'ops@acme.test' },
  });

  for (const o of ORDERS) {
    await prisma.order.upsert({
      where: { id: o.id },
      update: { origin: o.origin, destination: o.destination, cargo: o.cargo, status: 'BOOKED' },
      create: {
        id: o.id,
        customerId: customer.id,
        origin: o.origin,
        destination: o.destination,
        cargo: o.cargo,
        status: 'BOOKED',
      },
    });
  }

  await prisma.trip.upsert({
    where: { id: 'pilot-trip-1' },
    update: {},
    create: {
      id: 'pilot-trip-1',
      orgId: ORG_ID,
      orderId: 'pilot-order-1',
      status: 'DRAFT',
      rateEur: 1200,
    },
  });

  await prisma.trip.upsert({
    where: { id: 'pilot-trip-2' },
    update: {},
    create: {
      id: 'pilot-trip-2',
      orgId: ORG_ID,
      orderId: 'pilot-order-2',
      driverId: 'pilot-driver-1',
      truckId: 'pilot-truck-1',
      status: 'ASSIGNED',
      rateEur: 1450,
    },
  });

  // Give the assigned trip a history entry so the driver view has real data.
  const events = await prisma.statusEvent.count({ where: { tripId: 'pilot-trip-2' } });
  if (events === 0) {
    await prisma.statusEvent.create({
      data: {
        tripId: 'pilot-trip-2',
        fromStatus: 'DRAFT',
        toStatus: 'ASSIGNED',
        actorId: 'pilot-admin',
      },
    });
  } else {
    // Backfill the actor on history written before the column existed, so the
    // trip-detail timeline shows who moved it (board task #2).
    await prisma.statusEvent.updateMany({
      where: { tripId: 'pilot-trip-2', actorId: null },
      data: { actorId: 'pilot-admin' },
    });
  }

  const counts = {
    orgs: await prisma.org.count({ where: { id: ORG_ID } }),
    users: await prisma.user.count({ where: { orgId: ORG_ID } }),
    drivers: await prisma.user.count({ where: { orgId: ORG_ID, roleId: 'driver' } }),
    trucks: await prisma.truck.count({ where: { orgId: ORG_ID } }),
    customers: await prisma.customer.count({ where: { orgId: ORG_ID } }),
    orders: await prisma.order.count({ where: { customerId: customer.id } }),
    trips: await prisma.trip.count({ where: { orgId: ORG_ID } }),
  };

  console.log(`Seeded org "${org.name}" (${org.id}).`);
  console.log('Users:');
  for (const u of USERS) console.log(`  ${u.roleId.padEnd(9)} ${u.email}`);
  console.log('Counts:', JSON.stringify(counts));
  if (generated) console.log(`Generated pilot password: ${password}`);
  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
