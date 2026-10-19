import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { hashPassword } from '../auth/password.js';
import { inviteCustomerAccount } from '../registration-accounts.js';
import * as customerCore from '../../../../customer/lib/customer-core.js';
import {
  CUSTOMER_LANGS,
  EQUIPMENT_OPTIONS,
  FLEET_CUSTOMER_PERMISSION,
  buildFleetOrderRows,
  customerRow,
  normalizeFleetCustomer,
  normalizeFleetOrder,
  orderRow,
  repeatOrderBody,
} from '../fleet-customers.js';

/*
 * Fleet self-serve customer lane (board task #120, UXF-O3 lane 1).
 *
 *   GET  /api/fleet/customers   bearer, `trip:create` — the org's customers with
 *                               their contact fields and order count, plus the
 *                               equipment vocabulary the order form offers
 *   POST /api/fleet/customers   bearer, `trip:create` — quick-add a customer in
 *                               the caller's org (201 { customer })
 *   POST /api/orders            bearer, `trip:create` — a manual order for one of
 *                               the org's customers (201 { order }); with
 *                               `repeatOf` it copies that order's customer, lane,
 *                               cargo and equipment into a NEW order
 *   POST /api/fleet/customers/:id/invite
 *                               bearer, `user:manage` — give that customer a
 *                               portal login (201 { member }); the fleet manager
 *                               sets the temporary password, exactly like the
 *                               shipped team invite. No mail is sent.
 *
 * Why these live next to `/api/fleet/drivers`: the fleet's own customers never
 * join the platform, so there is no shipper login to create the work. Before
 * this route `POST /api/customers` and `POST /api/fleet/customers` were 404 and
 * `POST /api/orders` was 404 — a dispatcher could read the lists but not add to
 * them.
 *
 * Tenancy is the token's `org` claim, never a body field. A customer from
 * another org is a flat `404 customer_not_found` (no existence leak), and the
 * list endpoint already scopes by the same org, so fleet A can never see fleet
 * B's rows.
 */
export async function fleetCustomerRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  /** Creating a login is user management, exactly like `/api/fleet/drivers`. */
  const INVITE_PERMISSION = 'user:manage';

  /**
   * Resolve the caller's org, or answer 403. Each write names the capability it
   * needs: dispatch work is `trip:create`, creating a login is `user:manage`.
   */
  async function authorize(
    req: FastifyRequest,
    reply: FastifyReply,
    permission: string = FLEET_CUSTOMER_PERMISSION,
  ): Promise<string | null> {
    const user = req.user;
    if (!user?.orgId) {
      reply.code(403).send({ error: 'no_org' });
      return null;
    }
    const permissions = await loadRolePermissions(prisma, user.roleId);
    if (!hasPermission(permissions, permission)) {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    return user.orgId;
  }

  function sendInvalid(reply: FastifyReply, normalized: { error: string; field: string; messageKey: string; detail: string }) {
    return reply.code(400).send({
      error: normalized.error,
      field: normalized.field,
      messageKey: normalized.messageKey,
      detail: normalized.detail,
    });
  }

  app.get('/fleet/customers', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply);
    if (!orgId) return;

    const rows = await prisma.customer.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        email: true,
        whatsappId: true,
        lang: true,
        createdAt: true,
        _count: { select: { orders: true, accounts: true } },
      },
      orderBy: { name: 'asc' },
      take: 200,
    });

    // `equipment` travels with the list so the order form can offer the same
    // vocabulary the server validates against, never a client-side copy.
    return reply.send({ customers: rows.map(customerRow), equipment: [...EQUIPMENT_OPTIONS] });
  });

  app.post('/fleet/customers', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply);
    if (!orgId) return;

    const normalized = normalizeFleetCustomer(req.body ?? {});
    if (!normalized.ok) return sendInvalid(reply, normalized);
    const value = normalized.value;

    const created = await prisma.customer.create({
      data: { orgId, name: value.name, email: value.email, whatsappId: value.whatsappId, lang: value.lang },
    });

    await prisma.auditLog
      .create({ data: { orgId, actorId: req.user?.id ?? null, action: 'fleet.customer.create' } })
      .catch(() => undefined);

    return reply.code(201).send({ customer: customerRow(created) });
  });

  /**
   * Invite a fleet customer to the shipper portal. Reuses the shipped invite
   * contract: the inviter sets the temporary password, the response never
   * carries a secret, and nobody is emailed (`#75`/`#79` stay owner-gated).
   * The customer row is resolved inside the caller's org first, so a foreign
   * id is a flat 404 and the login is linked to the right tenant.
   */
  app.post('/fleet/customers/:id/invite', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply, INVITE_PERMISSION);
    if (!orgId) return;

    const { id } = req.params as { id: string };
    const customer = await prisma.customer.findFirst({
      where: { id, orgId },
      select: { id: true, name: true, email: true, lang: true },
    });
    if (!customer) return reply.code(404).send({ error: 'customer_not_found' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Name and email default to the customer row the fleet already typed; the
    // form may override them (a different billing contact) and must send a
    // temporary password.
    const normalized = customerCore.validateSignup({
      name: typeof body.name === 'string' && body.name.trim() ? body.name : customer.name,
      email: typeof body.email === 'string' && body.email.trim() ? body.email : customer.email || '',
      password: body.password,
    });
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const { name, email, password } = normalized.value;
    const lang = CUSTOMER_LANGS.includes(String(customer.lang || '')) ? String(customer.lang) : 'en';

    let member: any;
    try {
      member = await prisma.$transaction((tx) =>
        inviteCustomerAccount(tx as any, {
          customerId: customer.id,
          name,
          email,
          passwordHash: hashPassword(password),
          lang,
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'email_taken', field: 'email' });
      }
      throw err;
    }

    await prisma.auditLog
      .create({ data: { orgId, actorId: req.user?.id ?? null, action: 'fleet.customer.invite' } })
      .catch(() => undefined);

    // Never the password, never the hash: the fleet manager typed it.
    return reply.code(201).send({
      member: {
        id: member.id,
        name: member.name,
        email: member.email,
        roleId: member.roleId,
        customerId: customer.id,
      },
    });
  });

  app.post('/orders', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply);
    if (!orgId) return;

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Repeat: the source order must belong to one of this org's customers.
    if (body.repeatOf !== undefined && body.repeatOf !== null && body.repeatOf !== '') {
      const repeatOf = String(body.repeatOf).trim();
      const source = await prisma.order.findFirst({
        where: { id: repeatOf, customer: { orgId } },
        include: { booking: true },
      });
      if (!source) return reply.code(404).send({ error: 'order_not_found' });
      body.repeatOf = undefined;
      Object.assign(body, repeatOrderBody(source, body));
    }

    const customerId = typeof body.customerId === 'string' ? body.customerId.trim() : '';
    if (!customerId) {
      return reply.code(400).send({
        error: 'invalid_input',
        field: 'customerId',
        messageKey: 'app.customers.error.customerRequired',
        detail: 'customerId is required',
      });
    }
    const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true, name: true } });
    if (!customer) return reply.code(404).send({ error: 'customer_not_found' });

    const normalized = normalizeFleetOrder(body, { customerId: customer.id });
    if (!normalized.ok) return sendInvalid(reply, normalized);
    const rows = buildFleetOrderRows(normalized.value);

    const created = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({ data: rows.order });
      await tx.orderBooking.create({ data: { ...rows.booking, orderId: order.id } });
      return tx.order.findUnique({
        where: { id: order.id },
        include: { customer: { select: { id: true, name: true } }, booking: true },
      });
    });

    await prisma.auditLog
      .create({ data: { orgId, actorId: req.user?.id ?? null, action: 'fleet.order.create' } })
      .catch(() => undefined);

    return reply.code(201).send({ order: orderRow(created) });
  });
}
