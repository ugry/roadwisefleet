/**
 * Account creation for the three registration types (board task #111, AND2-REG1).
 *
 * The single place that turns a chosen account type into rows, so a signup can
 * never grant a role the chosen type does not carry:
 *
 *   fleet        → an `Org` + an `owner` `User` (the fleet manager)
 *   customer     → a `Customer` + a `customer` `User` + the `CustomerAccount`
 *                  link, attached to the host carrier org (orgId stays null)
 *   solo_driver  → a one-person carrier `Org` + a `solo` `User` + the
 *                  `SoloDriverProfile`
 *   fleet driver → a `driver` `User` inside the fleet's org (created/invited by
 *                  the fleet manager, not billed individually)
 *
 * Every function re-asserts its role row idempotently with FIXED permissions
 * before the `User` insert — the deploy path only ever runs `prisma migrate
 * deploy` (no seed), and the same discipline already keeps signup from 500ing
 * with a Prisma P2003 foreign-key error when the row is missing.
 *
 * Each takes an open transaction client (`tx`) and the already-normalised input:
 * validation stays in the shared rules (`app/lib/signup.js`,
 * `customer/lib/customer-core.js`, `solo/lib/solo-core.js`).
 */
import { OWNER_PERMISSIONS, OWNER_ROLE, defaultOrgName } from './registration.js';
import * as customerCore from '../../../customer/lib/customer-core.js';
import * as solo from '../../../solo/lib/solo-core.js';

/** The seeded role of a fleet-employed driver (mirrors `scripts/seed-pilot.ts`). */
export const DRIVER_ROLE = 'driver';

/** The driver capability list, byte-for-byte the seeded one. Fixed, never caller-supplied. */
export const DRIVER_PERMISSIONS = Object.freeze([
  'trip:read',
  'trip:status',
  'pod:upload',
  'expense:create',
]);

type Tx = {
  role: { upsert: (args: any) => Promise<any> };
  org: { create: (args: any) => Promise<any> };
  user: { create: (args: any) => Promise<any> };
  customer: { create: (args: any) => Promise<any> };
  customerAccount: { create: (args: any) => Promise<any> };
  soloDriverProfile: { create: (args: any) => Promise<any> };
};

/** @returns {Promise<void>} */
async function ensureRole(tx: Tx, id: string, permissions: readonly string[]) {
  await tx.role.upsert({
    where: { id },
    update: { permissions: [...permissions] },
    create: { id, permissions: [...permissions] },
  });
}

/**
 * A new fleet: the `Org` plus its `owner` (fleet manager).
 * @param {Tx} tx
 * @param {{ name: string, company?: string, email: string, passwordHash: string }} input
 */
export async function createFleetAccount(tx: Tx, input: { name: string; company?: string; email: string; passwordHash: string }) {
  await ensureRole(tx, OWNER_ROLE, OWNER_PERMISSIONS);
  const org = await tx.org.create({
    data: { name: defaultOrgName(input), locale: 'en', dataRegion: 'eu', plan: 'free' },
  });
  const user = await tx.user.create({
    data: {
      roleId: OWNER_ROLE,
      name: input.name,
      email: input.email,
      orgId: org.id,
      passwordHash: input.passwordHash,
      lang: 'en',
    },
  });
  return { accountType: 'fleet' as const, userId: user.id, orgId: org.id, orgName: org.name };
}

/**
 * A new customer login, linked to the host carrier org. The customer's `User`
 * carries no org (a customer must never reach an org-scoped route); the
 * `CustomerAccount` row is the tenant link.
 * @param {Tx} tx
 * @param {{ hostOrgId: string, name: string, company?: string, email: string, phone?: string|null, passwordHash: string, notifyPrefs?: any }} input
 */
export async function createCustomerAccount(tx: Tx, input: { hostOrgId: string; name: string; company?: string; email: string; phone?: string | null; passwordHash: string; notifyPrefs?: any }) {
  await ensureRole(tx, customerCore.CUSTOMER_ROLE, customerCore.CUSTOMER_PERMISSIONS);
  const customer = await tx.customer.create({
    data: {
      orgId: input.hostOrgId,
      name: input.company || input.name,
      email: input.email,
      lang: 'en',
      profile: { create: { notifyPrefs: input.notifyPrefs } },
    },
  });
  const user = await tx.user.create({
    data: {
      roleId: customerCore.CUSTOMER_ROLE,
      name: input.name,
      email: input.email,
      phone: input.phone || null,
      orgId: null,
      passwordHash: input.passwordHash,
      lang: 'en',
    },
  });
  await tx.customerAccount.create({ data: { userId: user.id, customerId: customer.id } });
  return {
    accountType: 'customer' as const,
    userId: user.id,
    orgId: null,
    customerId: customer.id,
    customerName: customer.name,
    hostOrgId: input.hostOrgId,
  };
}

/**
 * A solo truck driver: a one-person carrier org (the marketplace award creates
 * the Trip there), the `solo` login and the profile.
 * @param {Tx} tx
 * @param {{ name: string, company?: string, email: string, phone?: string|null, passwordHash: string, truck?: any }} input
 */
export async function createSoloAccount(tx: Tx, input: { name: string; company?: string; email: string; phone?: string | null; passwordHash: string; truck?: any }) {
  await ensureRole(tx, solo.SOLO_ROLE, solo.SOLO_PERMISSIONS);
  const org = await tx.org.create({
    data: { name: input.company || solo.soloOrgName(input.name), locale: 'en', dataRegion: 'eu', plan: 'free' },
  });
  const user = await tx.user.create({
    data: {
      roleId: solo.SOLO_ROLE,
      name: input.name,
      email: input.email,
      phone: input.phone || null,
      orgId: org.id,
      passwordHash: input.passwordHash,
      lang: 'en',
    },
  });
  const profile = await tx.soloDriverProfile.create({
    data: {
      userId: user.id,
      orgId: org.id,
      phone: input.phone || null,
      truckPlate: input.truck?.truckPlate ?? null,
      truckEquipment: input.truck?.truckEquipment ?? null,
      truckCapacityKg: input.truck?.truckCapacityKg ?? null,
    },
  });
  return {
    accountType: 'solo_driver' as const,
    userId: user.id,
    orgId: org.id,
    profileId: profile.id,
    orgName: org.name,
  };
}

/**
 * A fleet-employed driver account, created inside the manager's own org. Never
 * billed individually (the fleet owns the plan); role derived here, not from the
 * request body.
 * @param {Tx} tx
 * @param {{ orgId: string, name: string, email: string, phone?: string|null, passwordHash: string }} input
 */
export async function createFleetDriver(tx: Tx, input: { orgId: string; name: string; email: string; phone?: string | null; passwordHash: string }) {
  await ensureRole(tx, DRIVER_ROLE, DRIVER_PERMISSIONS);
  const user = await tx.user.create({
    data: {
      roleId: DRIVER_ROLE,
      name: input.name,
      email: input.email,
      phone: input.phone || null,
      orgId: input.orgId,
      passwordHash: input.passwordHash,
      lang: 'en',
    },
  });
  return { accountType: 'fleet_driver' as const, userId: user.id, orgId: input.orgId, roleId: DRIVER_ROLE };
}
