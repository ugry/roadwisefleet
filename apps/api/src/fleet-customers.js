/**
 * Fleet self-serve customer lane (board task #120, UXF-O3 lane 1) — the pure
 * domain for two writes on a shipped surface:
 *
 *   POST /api/fleet/customers   quick-add a customer in the caller's org
 *   POST /api/orders            create the fleet's own manual order (and repeat
 *                               an existing one)
 *
 * Diagram 06 LANE 1 is the fleet's **own** customers, who never join the
 * platform. Before this module the only customer/order writes were the customer
 * portal (a shipper account) and the solo driver's quick job; a fleet
 * dispatcher could read customers but not add one, and `POST /api/orders`
 * answered 404.
 *
 * Dependency-free ESM with JSDoc types on purpose: the no-install CI job
 * (`node --test apps/api/src/`) covers these rules on a bare checkout, and the
 * browser loads the very same shapes through `app/lib/customers.js`.
 *
 * Tenancy is NEVER a body field: the route passes the org from the token and
 * looks the customer up inside it, so foreign ids are a flat 404.
 */
import { EQUIPMENT } from '../../../customer/lib/customer-core.js';

/** Creating a customer/order is dispatch work: owner and dispatcher hold it. */
export const FLEET_CUSTOMER_PERMISSION = 'trip:create';

/** The catalogue languages the fleet surface ships (board #68 owns the rest). */
export const CUSTOMER_LANGS = Object.freeze(['en', 'de', 'pl', 'tr']);

/** The equipment vocabulary is the wizard's — one list, never a copy. */
export const EQUIPMENT_OPTIONS = Object.freeze([...EQUIPMENT]);

const MAX_NAME = 120;
const MAX_EMAIL = 160;
const MAX_PHONE = 40;
const MAX_ROUTE = 200;
const MAX_CARGO = 200;
const MAX_NOTES = 500;

/** @returns {{ ok: false, error: string, field: string, messageKey: string, detail: string }} */
function fail(field, messageKey, detail) {
  return { ok: false, error: 'invalid_input', field, messageKey, detail };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** A deliberately small email check: one @, a dot in the domain, no spaces. */
export function isValidCustomerEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** An optional ISO-8601 date; an unparseable value is refused, not ignored. */
function optionalDate(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date };
}

/**
 * Validate a quick-added customer. Fail-fast: exactly one field error, in field
 * order, so the form can focus the first thing to fix.
 * @param {unknown} body
 * @returns {{ ok: true, value: { name: string, email: string|null, whatsappId: string|null, lang: string } } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeFleetCustomer(body) {
  if (!isObject(body)) return fail('name', 'customers.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const name = text(b.name, MAX_NAME);
  if (!name) return fail('name', 'customers.error.nameRequired', 'name is required');

  const rawEmail = text(b.email, MAX_EMAIL);
  if (rawEmail && !isValidCustomerEmail(rawEmail)) {
    return fail('email', 'customers.error.emailInvalid', 'email must be a valid address');
  }
  const whatsappId = text(b.whatsappId !== undefined ? b.whatsappId : b.phone, MAX_PHONE) || null;

  const lang = text(b.lang, 5).toLowerCase() || 'en';
  if (!CUSTOMER_LANGS.includes(lang)) {
    return fail('lang', 'customers.error.langUnknown', 'unknown language: ' + lang);
  }
  return { ok: true, value: { name, email: rawEmail.toLowerCase() || null, whatsappId, lang } };
}

/**
 * The customer row the list and the quick-add response expose. Never a raw
 * Prisma row: only the fields the surface renders.
 * @param {any} customer
 * @returns {{ id: string, name: string, email: string|null, whatsappId: string|null, lang: string, orderCount: number|null, createdAt: string|null }}
 */
export function customerRow(customer) {
  if (!customer) return null;
  return {
    id: String(customer.id || ''),
    name: String(customer.name || ''),
    email: customer.email ? String(customer.email) : null,
    whatsappId: customer.whatsappId ? String(customer.whatsappId) : null,
    lang: String(customer.lang || 'en'),
    orderCount: typeof customer._count?.orders === 'number' ? customer._count.orders : null,
    createdAt: customer.createdAt ? new Date(customer.createdAt).toISOString() : null,
  };
}

/**
 * Validate a manual order. `customer` is the row the route already resolved
 * inside the caller's org (null means "not found" — the route answers 404
 * before calling this).
 * @param {unknown} body
 * @param {{ customerId: string }} args
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeFleetOrder(body, { customerId }) {
  if (!isObject(body)) return fail('origin', 'customers.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);

  const origin = text(b.origin, MAX_ROUTE);
  if (!origin) return fail('origin', 'customers.error.originRequired', 'origin is required');
  const destination = text(b.destination, MAX_ROUTE);
  if (!destination) return fail('destination', 'customers.error.destinationRequired', 'destination is required');
  if (origin === destination) return fail('destination', 'customers.error.sameRoute', 'destination must differ from origin');

  const plannedAt = optionalDate(b.plannedAt);
  if (!plannedAt.ok) return fail('plannedAt', 'customers.error.dateInvalid', 'plannedAt must be a valid ISO-8601 date');
  const loadReadyAt = optionalDate(b.loadReadyAt);
  if (!loadReadyAt.ok) return fail('loadReadyAt', 'customers.error.dateInvalid', 'loadReadyAt must be a valid ISO-8601 date');
  const deliverByAt = optionalDate(b.deliverByAt);
  if (!deliverByAt.ok) return fail('deliverByAt', 'customers.error.dateInvalid', 'deliverByAt must be a valid ISO-8601 date');
  if (loadReadyAt.value && deliverByAt.value && deliverByAt.value.getTime() < loadReadyAt.value.getTime()) {
    return fail('deliverByAt', 'customers.error.windowOrder', 'deliverByAt must not precede loadReadyAt');
  }

  const equipment = text(b.equipment, 40) || null;
  if (equipment && !EQUIPMENT_OPTIONS.includes(equipment)) {
    return fail('equipment', 'customers.error.equipmentUnknown', 'unknown equipment: ' + equipment);
  }

  return {
    ok: true,
    value: {
      customerId,
      origin,
      destination,
      cargo: text(b.cargo, MAX_CARGO) || null,
      status: 'BOOKED',
      plannedAt: plannedAt.value,
      equipment,
      loadReadyAt: loadReadyAt.value,
      deliverByAt: deliverByAt.value,
      notes: text(b.notes, MAX_NOTES) || null,
    },
  };
}

/**
 * The rows a manual order writes: the same `Order` + `OrderBooking` pair the
 * portal and the marketplace read, marked as fleet staff work. `status:
 * BOOKED` because the dispatcher creates it as confirmed work; the shop window
 * (`DRAFT`) is the wizard's flow.
 * @param {any} value the `normalizeFleetOrder` value
 * @returns {{ order: any, booking: any }}
 */
export function buildFleetOrderRows(value) {
  return {
    order: {
      customerId: value.customerId,
      origin: value.origin,
      destination: value.destination,
      cargo: value.cargo,
      status: value.status || 'BOOKED',
      plannedAt: value.plannedAt || null,
    },
    booking: {
      supplyChoice: 'fleet',
      equipment: value.equipment || null,
      loadReadyAt: value.loadReadyAt || null,
      deliverByAt: value.deliverByAt || null,
      notes: value.notes || null,
      details: { createdVia: 'fleet-app', manual: true },
    },
  };
}

/**
 * The request body for repeating an order: the source order's customer, lane,
 * cargo and booked equipment, unless the caller overrides a field explicitly.
 * The new order is a distinct row (a repeat, never a re-used order), which is
 * what the dispatcher's "book it again" action means.
 * @param {any} source an order with its booking, scoped to the caller's org
 * @param {unknown} body the caller's overrides
 * @returns {Record<string, unknown>}
 */
export function repeatOrderBody(source, body) {
  const override = isObject(body) ? /** @type {Record<string, any>} */ (body) : {};
  const out = {
    customerId: source.customerId,
    origin: source.origin,
    destination: source.destination,
    cargo: source.cargo || undefined,
    equipment: source.booking?.equipment || undefined,
  };
  for (const key of ['origin', 'destination', 'cargo', 'plannedAt', 'equipment', 'loadReadyAt', 'deliverByAt', 'notes']) {
    if (override[key] !== undefined && override[key] !== null && override[key] !== '') out[key] = override[key];
  }
  return out;
}

/**
 * The order row the create/repeat response exposes (the list is
 * `GET /api/orders`, board task #1).
 * @param {any} order
 * @returns {any}
 */
export function orderRow(order) {
  if (!order) return null;
  return {
    id: String(order.id || ''),
    customerId: String(order.customerId || ''),
    customer: order.customer ? { id: String(order.customer.id || ''), name: String(order.customer.name || '') } : null,
    origin: String(order.origin || ''),
    destination: String(order.destination || ''),
    cargo: order.cargo ? String(order.cargo) : null,
    status: String(order.status || 'BOOKED'),
    plannedAt: order.plannedAt ? new Date(order.plannedAt).toISOString() : null,
    booking: order.booking
      ? {
          equipment: order.booking.equipment || null,
          loadReadyAt: order.booking.loadReadyAt ? new Date(order.booking.loadReadyAt).toISOString() : null,
          deliverByAt: order.booking.deliverByAt ? new Date(order.booking.deliverByAt).toISOString() : null,
          notes: order.booking.notes || null,
        }
      : null,
  };
}
