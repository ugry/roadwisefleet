import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { hashPassword } from '../auth/password.js';
import { signToken } from '../auth/tokens.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { statusForError } from '../http-errors.js';
import { stripCredentialFields } from '../user-payload.js';
import { decodeBase64Upload, resolveWithin, writeDocumentFile } from '../documents.js';
import { createSoloAccount } from '../registration-accounts.js';
import * as solo from '../../../../solo/lib/solo-core.js';

/*
 * Solo driver Connect MVP API (board task #77, UXF-M2).
 *
 *   POST   /api/solo/signup             public — creates the one-person carrier
 *   GET    /api/solo/me                 profile + truck + verification state
 *   PATCH  /api/solo/me                 name / phone / truck specs
 *   POST   /api/solo/otp                start phone verification (dev code opt-in)
 *   POST   /api/solo/otp/verify         submit the code
 *   GET    /api/solo/verification       papers + state
 *   POST   /api/solo/verification       upload a paper (base64 JSON)
 *   GET    /api/solo/searches           saved load-feed filters
 *   POST   /api/solo/searches           save one
 *   DELETE /api/solo/searches/:id       remove one (scoped)
 *   GET    /api/solo/customers          the driver's own customers (no login)
 *   POST   /api/solo/customers          add one
 *   GET    /api/solo/jobs               wallet-lite: jobs + payment status
 *   POST   /api/solo/jobs               quick job (own customer → Order + Trip)
 *
 * The load feed, the load detail, the beacon and the offer endpoints are the
 * MARKETPLACE's (`/api/marketplace/*`, board #76) — reused, not re-implemented.
 * Board #96 (owner #73 q5): verification is OPTIONAL — an unverified solo driver
 * may browse AND bid, so no `verification_required` refusal is applied on that
 * path; the papers are a trust signal surfaced as per-type check marks.
 *
 * Security model (designed in, not tested in):
 *   - a solo login holds the `solo` role and a `SoloDriverProfile`; its personal
 *     carrier org is the only org it can read or write. Every read is scoped by
 *     the profile resolved from the authenticated user, never a request param.
 *   - "not mine" is a flat 404 — the tenant boundary never leaks existence;
 *     deleting another driver's saved search is a 404, not a 403.
 *   - the OTP code is stored as an HMAC (never plain); the comparison is
 *     constant-time and the attempt counter is bounded.
 *   - user rows are selected explicitly (never `passwordHash`/`totpSecret`).
 *
 * The database work is intentionally thin: the pure rules live in
 * `solo/lib/solo-core.js` (unit-tested with `node --test apps/api/src/`), the
 * end-to-end flow with `test:router`.
 */

const DOC_STORAGE_PREFIX = 'solo';

/**
 * The HMAC of an OTP code. The key is derived from AUTH_SECRET so no new secret
 * has to be provisioned, and the message is namespaced so this hash can never
 * be confused with a session token.
 * @param {string} code
 * @returns {string}
 */
function hashOtp(code: string): string {
  return createHmac('sha256', env.AUTH_SECRET).update('roadwisefleet/solo-otp/v1:' + code).digest('hex');
}

/** Constant-time compare of two hex HMACs of equal length. */
function otpMatches(code: string, stored: string | null | undefined): boolean {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  const a = Buffer.from(hashOtp(code), 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Mask a phone for a display string: keep the last 2 digits. */
function maskPhone(phone: string | null | undefined): string {
  const s = typeof phone === 'string' ? phone : '';
  if (s.length <= 2) return '••';
  return '••' + s.slice(-2);
}

interface SoloPrincipal {
  userId: string;
  orgId: string;
  roleId: string;
  name: string;
  permissions: string[];
  profile: { id: string; verificationStatus: string; phoneVerifiedAt: Date | null; phone: string | null };
}

type PrincipalResult = { ok: true; principal: SoloPrincipal } | { ok: false; status: number; error: string };

/**
 * Resolve the authenticated user into a solo principal, or a refusal. The
 * profile is the anchor: a token without one is not a solo driver (403), and
 * its org is the only org the principal can act in.
 */
async function resolveSolo(req: FastifyRequest): Promise<PrincipalResult> {
  const user = req.user;
  if (!user) return { ok: false, status: 401, error: 'unauthorized' };
  const permissions = await loadRolePermissions(prisma, user.roleId);
  const profile = await prisma.soloDriverProfile.findUnique({
    where: { userId: user.id },
    select: {
      id: true,
      orgId: true,
      verificationStatus: true,
      phoneVerifiedAt: true,
      phone: true,
    },
  });
  // The profile is the anchor, checked first: a customer login (no org either)
  // must read as "not a solo driver", not as "no org".
  if (!profile) return { ok: false, status: 403, error: 'not_a_solo_driver' };
  if (!profile.orgId) return { ok: false, status: 403, error: 'no_org' };
  return {
    ok: true,
    principal: {
      userId: user.id,
      orgId: profile.orgId,
      roleId: user.roleId ?? '',
      name: user.name ?? '',
      permissions,
      profile: {
        id: profile.id,
        verificationStatus: profile.verificationStatus,
        phoneVerifiedAt: profile.phoneVerifiedAt,
        phone: profile.phone,
      },
    },
  };
}

/** The verification state for a driver, loading only the papers' public fields. */
async function loadVerification(driverId: string, profile: any) {
  const docs = await prisma.soloVerificationDoc.findMany({
    where: { driverId },
    orderBy: { createdAt: 'asc' },
  });
  return solo.verificationState(profile, docs);
}

/** A storage key for a verification paper: no client-controlled path segment. */
function verificationStorageKey(driverId: string, docType: string, id: string, filename: string): string {
  const segment = (v: string) => String(v).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const ext = (filename.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase().slice(0, 10);
  return `${DOC_STORAGE_PREFIX}/${segment(driverId)}/${segment(docType)}/${segment(id)}${ext}`;
}

export async function soloRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  const refuse = (reply: any, error: string, status?: number) =>
    reply.code(status ?? statusForError(error)).send({ error });

  /* ------------------------------------------------------------- signup --- */

  app.post('/solo/signup', async (req, reply) => {
    const normalized = solo.validateSoloSignup(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const { name, email, phone, password, company, truck } = normalized.value;
    const passwordHash = hashPassword(password);

    let created: { orgId: string; userId: string; profileId: string };
    try {
      // One creation path for every account type (board task #111): the shared
      // helper re-asserts the `solo` role row idempotently with fixed values,
      // so an anonymous caller can never influence the permission set.
      created = await prisma.$transaction((tx) =>
        createSoloAccount(tx as any, { name, company, email, phone, passwordHash, truck }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'email_taken' });
      }
      throw err;
    }

    const token = signToken(
      { sub: created.userId, org: created.orgId, role: solo.SOLO_ROLE, name },
      env.AUTH_SECRET,
      { ttlSeconds: env.TOKEN_TTL_SECONDS },
    );
    return reply.code(201).send({
      token,
      user: {
        id: created.userId,
        name,
        roleId: solo.SOLO_ROLE,
        email,
        phone,
        orgId: created.orgId,
        truck: truck,
      },
      driver: { id: created.profileId, verificationStatus: 'NONE', phoneVerifiedAt: null },
    });
  });

  /* --------------------------------------------------------------- me --- */

  app.get('/solo/me', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const { userId, orgId } = resolved.principal;
    const [profile, user, org] = await Promise.all([
      prisma.soloDriverProfile.findUnique({ where: { userId } }),
      prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, lang: true } }),
      prisma.org.findUnique({ where: { id: orgId }, select: { name: true } }),
    ]);
    const verification = await loadVerification(userId, profile);
    return reply.send(
      stripCredentialFields({
        driver: {
          id: profile?.id,
          name: user?.name ?? '',
          email: user?.email ?? null,
          lang: user?.lang ?? 'en',
          orgId,
          orgName: org?.name ?? null,
          // The driver's own number: raw for the editable profile form, plus a
          // masked form for read-only display. It is his own data, not a secret.
          phone: profile?.phone ?? null,
          phoneMasked: maskPhone(profile?.phone),
          phoneVerified: Boolean(profile?.phoneVerifiedAt),
          truck: {
            plate: profile?.truckPlate ?? null,
            equipment: profile?.truckEquipment ?? null,
            capacityKg: profile?.truckCapacityKg ?? null,
          },
          verification,
          otp: solo.otpDeliveryState({
            otpReturnCode: Boolean(env.SOLO_OTP_RETURN_CODE),
            phoneVerifiedAt: profile?.phoneVerifiedAt ?? null,
          }),
        },
      }),
    );
  });

  app.patch('/solo/me', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const { userId } = resolved.principal;
    const body = (req.body ?? {}) as Record<string, any>;
    const data: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = String(body.name ?? '').trim();
      if (!name) {
        return reply.code(400).send({ error: 'invalid_input', field: 'name', detail: 'name must not be empty' });
      }
      await prisma.user.update({ where: { id: userId }, data: { name } });
    }

    if (body.phone !== undefined) {
      const phone = String(body.phone ?? '').trim();
      if (phone && !solo.isPlausiblePhone(phone)) {
        return reply.code(400).send({ error: 'invalid_input', field: 'phone', detail: 'phone is not valid' });
      }
      data.phone = phone || null;
      if (phone !== resolved.principal.profile.phone) {
        // A changed number is a fresh verification: the old verification cannot
        // stand for a new phone (that would be the whole gate bypassed).
        data.phoneVerifiedAt = null;
        data.otpHash = null;
        data.otpExpiresAt = null;
        data.otpAttempts = 0;
      }
    }

    const truck = solo.normalizeTruck(body);
    if (!truck.ok) {
      return reply.code(400).send({ error: truck.error, field: truck.field, messageKey: truck.messageKey, detail: truck.detail });
    }
    Object.assign(data, truck.value);

    if (Object.keys(data).length > 0) {
      await prisma.soloDriverProfile.update({ where: { userId }, data });
    }
    const profile = await prisma.soloDriverProfile.findUnique({ where: { userId } });
    const verification = await loadVerification(userId, profile);
    return reply.send(
      stripCredentialFields({
        driver: {
          phone: maskPhone(profile?.phone),
          phoneVerified: Boolean(profile?.phoneVerifiedAt),
          truck: {
            plate: profile?.truckPlate ?? null,
            equipment: profile?.truckEquipment ?? null,
            capacityKg: profile?.truckCapacityKg ?? null,
          },
          verification,
        },
      }),
    );
  });

  /* ---------------------------------------------------------------- OTP --- */

  app.post('/solo/otp', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const body = (req.body ?? {}) as Record<string, any>;
    const phone = String(body.phone ?? resolved.principal.profile.phone ?? '').trim();
    if (!solo.isPlausiblePhone(phone)) {
      return reply.code(400).send({ error: 'invalid_input', field: 'phone', detail: 'a valid phone is required' });
    }
    const code = solo.generateOtpCode();
    const now = new Date();
    await prisma.soloDriverProfile.update({
      where: { userId: resolved.principal.userId },
      data: {
        phone,
        phoneVerifiedAt: phone === resolved.principal.profile.phone ? resolved.principal.profile.phoneVerifiedAt : null,
        otpHash: hashOtp(code),
        otpExpiresAt: solo.otpExpiry(now),
        otpAttempts: 0,
      },
    });
    // The pilot has no SMS provider. The code is echoed ONLY when the operator
    // opts in (`SOLO_OTP_RETURN_CODE`), and the response says so, so a real
    // deployment can never leak a code by default.
    return reply.send(
      stripCredentialFields({
        sent: true,
        to: maskPhone(phone),
        returnsCode: Boolean(env.SOLO_OTP_RETURN_CODE),
        note: env.SOLO_OTP_RETURN_CODE ? 'solo.otp.devEcho' : 'solo.otp.noSenderNote',
        ...(env.SOLO_OTP_RETURN_CODE ? { devCode: code } : {}),
      }),
    );
  });

  app.post('/solo/otp/verify', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const body = (req.body ?? {}) as Record<string, any>;
    const code = solo.normalizeOtpCode(body.code);
    const profile = await prisma.soloDriverProfile.findUnique({ where: { userId: resolved.principal.userId } });
    const gate = solo.otpGate({
      hash: profile?.otpHash,
      expiresAt: profile?.otpExpiresAt,
      attempts: profile?.otpAttempts,
    });
    if (!gate.ok) {
      return reply.code(400).send({ error: gate.error, messageKey: gate.messageKey });
    }
    if (!otpMatches(code, profile?.otpHash)) {
      const attempts = (profile?.otpAttempts ?? 0) + 1;
      await prisma.soloDriverProfile.update({
        where: { userId: resolved.principal.userId },
        data: { otpAttempts: attempts, ...(attempts >= solo.OTP_MAX_ATTEMPTS ? { otpHash: null } : {}) },
      });
      return reply.code(400).send({ error: 'otp_invalid', messageKey: 'solo.otp.error.invalid', attemptsLeft: Math.max(0, solo.OTP_MAX_ATTEMPTS - attempts) });
    }
    await prisma.soloDriverProfile.update({
      where: { userId: resolved.principal.userId },
      data: { phoneVerifiedAt: new Date(), otpHash: null, otpExpiresAt: null, otpAttempts: 0 },
    });
    return reply.send({ verified: true, phoneVerified: true });
  });

  /* ------------------------------------------------------- verification --- */

  app.get('/solo/verification', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const profile = await prisma.soloDriverProfile.findUnique({ where: { userId: resolved.principal.userId } });
    const state = await loadVerification(resolved.principal.userId, profile);
    const docs = await prisma.soloVerificationDoc.findMany({
      where: { driverId: resolved.principal.userId },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send(
      stripCredentialFields({
        verification: state,
        documents: docs.map((doc) => solo.verificationDocRow(doc)),
        bidGate: solo.canBid(profile),
      }),
    );
  });

  app.post('/solo/verification', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const normalized = solo.normalizeVerificationUpload(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const value = normalized.value;
    const bytes = decodeBase64Upload(value.dataBase64);
    if (!bytes) {
      return reply.code(400).send({ error: 'invalid_input', field: 'dataBase64', detail: 'dataBase64 is not valid base64' });
    }
    const { userId, orgId } = resolved.principal;
    const storageKey = verificationStorageKey(userId, value.docType, solo.makeId('vd'), value.filename);

    const doc = await prisma.soloVerificationDoc.create({
      data: {
        driverId: userId,
        orgId,
        docType: value.docType,
        storageKey,
        filename: value.filename,
        mimeType: value.mimeType,
        sizeBytes: value.bytes,
        status: 'PENDING',
        expiresAt: value.expiresAt,
      },
    });
    if (!resolveWithin(env.UPLOAD_DIR, storageKey)) {
      await prisma.soloVerificationDoc.delete({ where: { id: doc.id } }).catch(() => undefined);
      return reply.code(500).send({ error: 'storage_failed' });
    }
    const written = await writeDocumentFile(env.UPLOAD_DIR, storageKey, bytes);
    if (!written.ok) {
      await prisma.soloVerificationDoc.delete({ where: { id: doc.id } }).catch(() => undefined);
      return reply.code(500).send({ error: 'storage_failed' });
    }

    // Submitting papers moves a fresh/rejected profile to PENDING; a VERIFIED
    // profile keeps its badge (a reviewer re-opens it only deliberately).
    const profile = await prisma.soloDriverProfile.findUnique({ where: { userId } });
    const stateAfter = await loadVerification(userId, profile);
    let profileStatus = profile?.verificationStatus ?? 'NONE';
    if (stateAfter.complete && (profileStatus === 'NONE' || profileStatus === 'REJECTED')) {
      profileStatus = 'PENDING';
    }
    if (profileStatus !== (profile?.verificationStatus ?? 'NONE')) {
      await prisma.soloDriverProfile.update({ where: { userId }, data: { verificationStatus: 'PENDING' } });
    }
    const fresh = await prisma.soloDriverProfile.findUnique({ where: { userId } });
    const state = await loadVerification(userId, fresh);
    return reply.code(201).send(
      stripCredentialFields({
        document: solo.verificationDocRow(doc),
        verification: state,
        bidGate: solo.canBid(fresh),
      }),
    );
  });

  /* ------------------------------------------------------ saved searches --- */

  app.get('/solo/searches', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const searches = await prisma.soloSavedSearch.findMany({
      where: { driverId: resolved.principal.userId },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send(stripCredentialFields({ searches: searches.map((s) => solo.searchRow(s)) }));
  });

  app.post('/solo/searches', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const normalized = solo.normalizeSavedSearch(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const search = await prisma.soloSavedSearch.create({
      data: {
        driverId: resolved.principal.userId,
        orgId: resolved.principal.orgId,
        name: normalized.value.name,
        filter: normalized.value.filter,
      },
    });
    return reply.code(201).send({ search: solo.searchRow(search) });
  });

  app.delete('/solo/searches/:id', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const { id } = req.params as { id: string };
    const existing = await prisma.soloSavedSearch.findFirst({
      where: { id, driverId: resolved.principal.userId },
      select: { id: true },
    });
    // A foreign id is a 404, exactly like a missing one.
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await prisma.soloSavedSearch.delete({ where: { id: existing.id } });
    return reply.send({ deleted: true });
  });

  /* -------------------------------------------------------- own customers --- */

  app.get('/solo/customers', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const customers = await prisma.customer.findMany({
      where: { orgId: resolved.principal.orgId },
      select: { id: true, name: true, email: true, whatsappId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send(stripCredentialFields({ customers }));
  });

  app.post('/solo/customers', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    if (!hasPermission(resolved.principal.permissions, 'order:create')) return refuse(reply, 'forbidden');
    const normalized = solo.normalizeSoloCustomer(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const customer = await prisma.customer.create({
      data: {
        orgId: resolved.principal.orgId,
        name: normalized.value.name,
        email: normalized.value.email,
        whatsappId: normalized.value.phone,
        lang: 'en',
      },
      select: { id: true, name: true, email: true, whatsappId: true, createdAt: true },
    });
    return reply.code(201).send({ customer });
  });

  /* --------------------------------------------------- jobs / wallet-lite --- */

  app.get('/solo/jobs', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    const trips = await prisma.trip.findMany({
      where: { orgId: resolved.principal.orgId },
      select: {
        id: true,
        status: true,
        rateEur: true,
        deliveredAt: true,
        createdAt: true,
        order: { select: { origin: true, destination: true, customer: { select: { name: true } } } },
        settlement: { select: { status: true, amountEur: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const jobs = trips.map((trip) => solo.jobRow(trip)).filter(Boolean);
    return reply.send(stripCredentialFields({ jobs, wallet: solo.walletSummary(trips) }));
  });

  app.post('/solo/jobs', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveSolo(req);
    if (!resolved.ok) return refuse(reply, resolved.error, resolved.status);
    if (!hasPermission(resolved.principal.permissions, 'order:create')) return refuse(reply, 'forbidden');
    const normalized = solo.normalizeQuickJob(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const value = normalized.value;
    const { userId, orgId } = resolved.principal;

    // An existing customer must belong to this driver's own org; a new name is
    // created on the spot (the "add in 30s" flow — no shipper account exists).
    let customerId = value.customerId;
    if (customerId) {
      const existing = await prisma.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
    }

    const rows = solo.buildQuickJobRows(value, { orgId, driverId: userId, customerId: customerId || '' });
    const created = await prisma.$transaction(async (tx) => {
      if (!customerId) {
        const customer = await tx.customer.create({
          data: { orgId, name: value.customerName || 'Own customer', lang: 'en' },
          select: { id: true },
        });
        customerId = customer.id;
      }
      const order = await tx.order.create({
        data: { ...rows.order, customerId: customerId as string },
      });
      await tx.orderBooking.create({ data: { ...rows.booking, orderId: order.id } });
      const trip = await tx.trip.create({
        data: {
          orgId: rows.trip.orgId,
          driverId: rows.trip.driverId,
          status: rows.trip.status,
          rateEur: rows.trip.rateEur,
          orderId: order.id,
        },
      });
      return { order, trip };
    });

    return reply.code(201).send(
      stripCredentialFields({
        job: solo.jobRow({
          id: created.trip.id,
          status: created.trip.status,
          rateEur: created.trip.rateEur,
          deliveredAt: null,
          createdAt: created.trip.createdAt,
          order: { origin: created.order.origin, destination: created.order.destination, customer: null },
          settlement: null,
        }),
        orderId: created.order.id,
        tripId: created.trip.id,
      }),
    );
  });
}
