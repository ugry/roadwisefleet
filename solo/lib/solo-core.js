/**
 * RoadwiseFleet solo driver Hauling Market MVP — core domain (board task #77, UXF-M2).
 *
 * The solo truck driver is a first-class persona (diagram
 * `docs/ux-flows/04-solo-driver-flow.mmd`): a one-person carrier who is found
 * via a capacity beacon and finds work via the load feed, and who also serves
 * his own customers who never join the platform.
 *
 * Loaded twice, on purpose (the proven #74/#76 pattern):
 *   - in the browser as an ES module (`solo/solo.js` imports it and exposes it
 *     as `window.RoadwiseSolo` for the harness);
 *   - in the API (`apps/api/src/routes/solo.ts` and the offer gate in
 *     `routes/marketplace.ts`), so the browser and the server validate the SAME
 *     payloads with the SAME rules and the client can never be more permissive
 *     than the API.
 *
 * Cosmetic ownership: the marketplace domain (loads, offers, beacons, the award
 * that creates the Trip) is NOT re-implemented here — `apps/api/src/marketplace.js`
 * stays the single source of truth. This module only adds what the solo persona
 * needs on top: signup, phone OTP, verification papers, the bid gate, own
 * customers, quick jobs, saved searches and the wallet-lite read model.
 *
 * Nothing here touches the DOM, the network, storage, `node:*` or the clock
 * (except an injectable `now`/`random`), so it is covered by
 * `node --test apps/api/src/` with no install and no browser. Plain
 * ES5-compatible syntax inside the functions: the pilot targets cheap Android
 * WebViews.
 */

/**
 * The role a solo driver login holds. Created by the deploy path
 * (`prisma/migrations/20260930120000_add_solo_driver`, which also re-asserts the
 * `customer` role) and re-asserted idempotently by the signup transaction, so a
 * missing row can never turn a signup into a foreign-key error (Prisma P2003).
 */
export const SOLO_ROLE = 'solo';

/**
 * The permission set of `SOLO_ROLE`. A solo driver IS his own carrier org: he
 * may create/supply trips (`trip:*`), serve his own customers (`order:create`,
 * `order:read`), upload PODs and record expenses. Deliberately NOT
 * `customer:manage`: that capability is what makes a token a *customer portal*
 * principal, and a solo driver must never resolve to a CustomerAccount tenant.
 */
export const SOLO_PERMISSIONS = ['trip:*', 'order:create', 'order:read', 'pod:upload', 'expense:create'];

/** Verification-paper lifecycle (owner #73 q5: optional trust signal, never a bid gate). */
export const VERIFICATION_STATUSES = ['NONE', 'PENDING', 'VERIFIED', 'REJECTED'];

/** The four papers diagram 04 lists, in the order the UI shows them. */
export const VERIFICATION_DOC_TYPES = ['id', 'licence', 'vehicle_registration', 'insurance'];

/** The papers that must all be present for a driver to become VERIFIED. */
export const VERIFICATION_REQUIRED_DOCS = [...VERIFICATION_DOC_TYPES];

/**
 * The papers the owner asked to surface as trust check marks on a driver's
 * profile (eila/tasks#73 q5: "ID, License, registration"). `insurance` stays a
 * required paper for the VERIFIED state but is not part of the check-mark row.
 */
export const VERIFICATION_BADGE_DOCS = ['id', 'licence', 'vehicle_registration'];

/** Paper statuses (a paper is reviewed independently of the profile). */
export const VERIFICATION_DOC_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'];

/** Phone OTP: 6 digits, 10 minutes, 5 attempts (then a new code is needed). */
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;

/**
 * Equipment vocabulary — reused from the customer portal's shared core
 * (`customer/lib/customer-core.js`) so a solo driver's truck and a customer's
 * request agree; the marketplace matches on the same strings.
 */
export const EQUIPMENT = [
  'curtainsider',
  'reefer',
  'flatbed',
  'box',
  'tanker',
  'tail_lift',
  'adr',
  'container',
];

/** Free-text cap, so a paste of a whole document cannot reach the database. */
export const MAX_TEXT = 500;

/** Base64 verification upload cap (mirror of env.MAX_UPLOAD_BYTES default). */
export const MAX_VERIFICATION_BYTES = 10 * 1024 * 1024;

/** Mime types a verification paper may be (photo or PDF). */
export const VERIFICATION_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/**
 * Owner decision #73 q5 (2026-10-01): driver verification is OPTIONAL. A solo
 * driver without the papers may still use the platform — browse AND bid — so
 * the strict "bid only when VERIFIED" rule no longer ships. The mechanism is
 * kept (see `canBid`'s `enforce` option) so the closed state stays covered by
 * tests and a later owner decision can re-arm it; the four papers stay
 * uploadable and reviewable either way.
 */
export const BID_REQUIRES_VERIFICATION = false;

/**
 * The display chain for the driver's next action. Trip status legality lives in
 * `apps/api/src/trip-status.js` (the server is the source of truth and rejects
 * an illegal move with 400 `invalid_transition`); this map only decides which
 * single primary button the solo surface offers.
 */
export const SOLO_STATUS_CHAIN = ['DRAFT', 'ASSIGNED', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'POD_UPLOADED'];

/* --------------------------------------------------------------- helpers --- */

/** @param {unknown} value @returns {boolean} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Trim and cap a free-text value.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function text(value, max) {
  if (value === null || value === undefined) return '';
  const cap = max || MAX_TEXT;
  const s = String(value).trim();
  return s.length > cap ? s.slice(0, cap) : s;
}

/** @param {unknown} value @returns {string} */
function normText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Coerce an optional non-negative number. `''`/null/undefined → null.
 * @param {unknown} value
 * @returns {{ ok: true, value: number|null } | { ok: false }}
 */
function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/**
 * Coerce an optional whole number ≥ 0.
 * @param {unknown} value
 * @returns {{ ok: true, value: number|null } | { ok: false }}
 */
function optionalInt(value) {
  const n = optionalNumber(value);
  if (!n.ok) return n;
  if (n.value === null) return { ok: true, value: null };
  if (Math.floor(n.value) !== n.value) return { ok: false };
  return { ok: true, value: n.value };
}

/**
 * Parse an optional date. Empty → null; anything present must parse, so a typo
 * can never store an Invalid Date.
 * @param {unknown} value
 * @returns {{ ok: true, value: Date|null } | { ok: false }}
 */
function optionalDate(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date };
}

/** @param {unknown} value @returns {number} */
function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * A loose but real email check; the API is authoritative, this is UX.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 5 || s.length > 200) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
}

/**
 * A loose phone check: 7–20 chars, digits plus space/+/()-/ separators.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlausiblePhone(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s.length >= 7 && s.length <= 20 && /^[+()\d][\d\s()+/-]*$/.test(s);
}

/**
 * A fail-fast invalid-input result. `field` drives focus, `messageKey` the copy.
 * @param {string} field
 * @param {string} messageKey
 * @param {string} [detail]
 * @returns {any}
 */
function fail(field, messageKey, detail) {
  return { ok: false, error: 'invalid_input', field, messageKey, detail: detail || messageKey };
}

/**
 * A base62-ish opaque id factory (no crypto here — the route supplies ids via
 * Prisma defaults; this is only for read-model shaping and tests).
 * @param {string} prefix
 * @param {() => number} [random]
 * @returns {string}
 */
export function makeId(prefix, random = Math.random) {
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += Math.floor(random() * 36).toString(36);
  }
  return prefix + '_' + out;
}

/* ---------------------------------------------------------------- signup --- */

/**
 * The one-person carrier org name for a solo signup: the person's own name is a
 * legal-enough trading name until they set a company name.
 * @param {unknown} name
 * @returns {string}
 */
export function soloOrgName(name) {
  const clean = text(name, 120);
  return clean || 'Solo carrier';
}

/**
 * Validate a solo signup. Name, email, password and phone are required (the
 * phone is what the beacon and the OTP hang off); truck specs are optional.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function validateSoloSignup(body) {
  if (!isObject(body)) return fail('form', 'solo.signup.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const name = text(b.name, 120);
  if (!name) return fail('name', 'solo.signup.error.nameRequired', 'name is required');
  const email = text(b.email, 200).toLowerCase();
  if (!email) return fail('email', 'solo.signup.error.emailRequired', 'email is required');
  if (!isValidEmail(email)) return fail('email', 'solo.signup.error.emailInvalid', 'email is not valid');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8) {
    return fail('password', 'solo.signup.error.passwordShort', 'password must be at least 8 characters');
  }
  if (password.length > 200) return fail('password', 'solo.signup.error.passwordLong', 'password is too long');
  const phone = text(b.phone, 30);
  if (!phone) return fail('phone', 'solo.signup.error.phoneRequired', 'phone is required');
  if (!isPlausiblePhone(phone)) {
    return fail('phone', 'solo.signup.error.phoneInvalid', 'phone is not valid');
  }
  const truck = normalizeTruck(b);
  if (!truck.ok) return truck;
  return {
    ok: true,
    value: {
      name,
      email,
      phone,
      password,
      company: text(b.company, 120),
      truck: truck.value,
    },
  };
}

/**
 * Validate the one truck's specs. Every field is optional (they can be filled
 * after signup), but a plate must be non-empty when given and the equipment
 * must be in the shared vocabulary.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeTruck(body) {
  const b = isObject(body) ? /** @type {Record<string, any>} */ (body) : {};
  const plate = text(b.truckPlate, 20);
  const equipment = text(b.truckEquipment, 40);
  if (equipment && !EQUIPMENT.includes(equipment)) {
    return fail('truckEquipment', 'solo.truck.error.equipmentUnknown', 'unknown equipment: ' + equipment);
  }
  const capacity = optionalInt(b.truckCapacityKg);
  if (!capacity.ok) {
    return fail('truckCapacityKg', 'solo.truck.error.capacityInvalid', 'truckCapacityKg must be a non-negative whole number');
  }
  const hasAny =
    plate !== '' || equipment !== '' || (capacity.value !== null && capacity.value !== undefined);
  return {
    ok: true,
    value: hasAny
      ? { truckPlate: plate || null, truckEquipment: equipment || null, truckCapacityKg: capacity.value }
      : {},
  };
}

/* ------------------------------------------------------------- phone OTP --- */

/**
 * Generate a zero-padded numeric OTP. `random` is injectable so the value is
 * deterministic under test; the route passes `Math.random`.
 * @param {() => number} [random]
 * @returns {string}
 */
export function generateOtpCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < OTP_LENGTH; i += 1) {
    out += String(Math.floor(random() * 10));
  }
  return out;
}

/**
 * The expiry a freshly minted code gets.
 * @param {Date|string|number} now
 * @param {number} [ttlSeconds]
 * @returns {Date}
 */
export function otpExpiry(now, ttlSeconds = OTP_TTL_SECONDS) {
  const at = now instanceof Date ? now : new Date(/** @type {any} */ (now));
  return new Date(at.getTime() + ttlSeconds * 1000);
}

/**
 * The pre-comparison gate for a submitted code: is there a code at all, is it
 * still alive, and has the attempt budget not been spent? The constant-time
 * comparison of the HMAC happens in the route (it needs `node:crypto`), so this
 * stays dependency-free and testable in the browser too.
 * @param {{ hash?: unknown, expiresAt?: unknown, attempts?: unknown, now?: Date|string|number }} args
 * @returns {{ ok: true } | { ok: false, error: string, messageKey: string }}
 */
export function otpGate({ hash, expiresAt, attempts, now = new Date() } = {}) {
  if (typeof hash !== 'string' || hash.length === 0) {
    return { ok: false, error: 'otp_not_started', messageKey: 'solo.otp.error.notStarted' };
  }
  if (Number(attempts || 0) >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: 'otp_locked', messageKey: 'solo.otp.error.locked' };
  }
  const at = expiresAt instanceof Date ? expiresAt : new Date(/** @type {any} */ (expiresAt));
  const nowDate = now instanceof Date ? now : new Date(/** @type {any} */ (now));
  if (Number.isNaN(at.getTime()) || at.getTime() <= nowDate.getTime()) {
    return { ok: false, error: 'otp_expired', messageKey: 'solo.otp.error.expired' };
  }
  return { ok: true };
}

/**
 * Normalise a 6-digit code typed by a human (spaces/dashes tolerated).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeOtpCode(value) {
  const s = typeof value === 'string' ? value : '';
  return s.replace(/[^0-9]/g, '').slice(0, OTP_LENGTH);
}

/* ---------------------------------------------------------- verification --- */

/**
 * The verification state of a driver: the profile status plus, per required
 * paper, whether it is present and its status. `complete` means every required
 * paper is present — which is what a reviewer then verifies.
 * @param {any} profile
 * @param {any[]} [docs]
 * @returns {{ status: string, complete: boolean, missing: string[], papers: Array<{ docType: string, present: boolean, status: string|null, expiresAt: any }> }}
 */
export function verificationState(profile, docs = []) {
  const status = typeof profile?.verificationStatus === 'string' ? profile.verificationStatus : 'NONE';
  const byType = new Map();
  if (Array.isArray(docs)) {
    for (const doc of docs) {
      if (doc && typeof doc.docType === 'string') byType.set(doc.docType, doc);
    }
  }
  const papers = VERIFICATION_REQUIRED_DOCS.map((docType) => {
    const doc = byType.get(docType) || null;
    return {
      docType,
      present: Boolean(doc),
      status: doc ? doc.status || 'PENDING' : null,
      expiresAt: doc ? doc.expiresAt || null : null,
    };
  });
  const missing = papers.filter((paper) => !paper.present).map((paper) => paper.docType);
  // The truthful per-type trust marks (owner #73 q5): a paper that is SUPPLIED
  // gets a mark whose state reflects its review status — never a fake verified
  // badge. An absent paper is marked `missing` and renders no check mark.
  const badges = VERIFICATION_BADGE_DOCS.map((docType) => {
    const paper = papers.find((p) => p.docType === docType) || { present: false, status: null };
    const supplied = Boolean(paper.present);
    const paperStatus = supplied ? paper.status || 'PENDING' : null;
    return {
      docType,
      supplied,
      status: paperStatus,
      verified: Boolean(supplied && paperStatus === 'VERIFIED'),
      mark: !supplied
        ? 'missing'
        : paperStatus === 'VERIFIED'
          ? 'verified'
          : paperStatus === 'REJECTED'
            ? 'rejected'
            : 'pending',
    };
  });
  return { status, complete: missing.length === 0, missing, papers, badges };
}

/**
 * The bidding gate. Owner decision #73 q5 makes verification OPTIONAL: by
 * default a solo driver may browse AND bid whatever his papers say. Fleet-carrier
 * principals (non-solo) are unaffected — the caller applies this only to a
 * principal that has a SoloDriverProfile.
 *
 * `options.enforce` re-arms the historical strict rule (bid only when VERIFIED)
 * so the mechanism stays covered by tests; production never enforces it.
 * @param {{ verificationStatus?: unknown }|null} profile
 * @param {{ enforce?: boolean }} [options]
 * @returns {{ allowed: boolean, error: string|null, messageKey: string|null }}
 */
export function canBid(profile, options = {}) {
  const enforce = options.enforce !== undefined ? options.enforce : BID_REQUIRES_VERIFICATION;
  if (!enforce) return { allowed: true, error: null, messageKey: null };
  const status = typeof profile?.verificationStatus === 'string' ? profile.verificationStatus : 'NONE';
  if (status === 'VERIFIED') return { allowed: true, error: null, messageKey: null };
  return {
    allowed: false,
    error: 'verification_required',
    messageKey: status === 'PENDING' ? 'solo.bid.pending' : 'solo.bid.unverified',
  };
}

/**
 * Validate a verification upload. The bytes are base64 in the JSON body (the
 * pilot has no multipart dependency — the same choice as `documents.ts`).
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeVerificationUpload(body) {
  if (!isObject(body)) return fail('form', 'solo.verify.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const docType = text(b.docType, 40);
  if (!VERIFICATION_DOC_TYPES.includes(docType)) {
    return fail('docType', 'solo.verify.error.docTypeUnknown', 'unknown docType: ' + docType);
  }
  const filename = text(b.filename, 120);
  if (!filename) return fail('filename', 'solo.verify.error.filenameRequired', 'filename is required');
  const mimeType = text(b.mimeType, 80).toLowerCase();
  if (!VERIFICATION_MIME.includes(mimeType)) {
    return fail('mimeType', 'solo.verify.error.mimeUnknown', 'unsupported file type: ' + mimeType);
  }
  const dataBase64 = typeof b.dataBase64 === 'string' ? b.dataBase64 : '';
  if (!dataBase64) return fail('dataBase64', 'solo.verify.error.dataRequired', 'dataBase64 is required');
  // Size is computed from the base64 length, never by decoding: this module also
  // runs in the browser, where `Buffer` does not exist.
  if (!/^[A-Za-z0-9+/=\s]+$/.test(dataBase64)) {
    return fail('dataBase64', 'solo.verify.error.dataInvalid', 'dataBase64 is not valid base64');
  }
  const compact = dataBase64.replace(/\s/g, '');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
  if (bytes === 0) return fail('dataBase64', 'solo.verify.error.dataInvalid', 'dataBase64 is not valid base64');
  if (bytes > MAX_VERIFICATION_BYTES) {
    return fail('dataBase64', 'solo.verify.error.tooLarge', 'file exceeds ' + MAX_VERIFICATION_BYTES + ' bytes');
  }
  const expiresAt = optionalDate(b.expiresAt);
  if (!expiresAt.ok) return fail('expiresAt', 'solo.verify.error.dateInvalid', 'expiresAt must be a valid date');
  return {
    ok: true,
    value: { docType, filename, mimeType, bytes, dataBase64, expiresAt: expiresAt.value },
  };
}

/* --------------------------------------------------------- own customers --- */

/**
 * Validate one of the solo driver's own customers — the people who never join
 * the platform (diagram 04/06). A name is enough; email/phone are optional.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeSoloCustomer(body) {
  if (!isObject(body)) return fail('form', 'solo.customer.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const name = text(b.name, 120);
  if (!name) return fail('name', 'solo.customer.error.nameRequired', 'name is required');
  const email = text(b.email, 200).toLowerCase();
  if (email && !isValidEmail(email)) return fail('email', 'solo.customer.error.emailInvalid', 'email is not valid');
  const phone = text(b.phone, 30);
  if (phone && !isPlausiblePhone(phone)) return fail('phone', 'solo.customer.error.phoneInvalid', 'phone is not valid');
  return { ok: true, value: { name, email: email || null, phone: phone || null } };
}

/**
 * Validate a quick job: the 30-second flow that turns one of the driver's own
 * customers into a load he executes himself. Either an existing `customerId` or
 * a `customerName` (created on the spot) must be present.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeQuickJob(body) {
  if (!isObject(body)) return fail('form', 'solo.job.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const customerId = text(b.customerId, 60);
  const customerName = text(b.customerName, 120);
  if (!customerId && !customerName) {
    return fail('customerName', 'solo.job.error.customerRequired', 'pick a customer or name a new one');
  }
  const origin = text(b.origin, 200);
  if (!origin) return fail('origin', 'solo.job.error.originRequired', 'origin is required');
  const destination = text(b.destination, 200);
  if (!destination) return fail('destination', 'solo.job.error.destinationRequired', 'destination is required');
  if (origin === destination) {
    return fail('destination', 'solo.job.error.sameRoute', 'destination must differ from origin');
  }
  const rate = optionalNumber(b.rateEur);
  if (!rate.ok) return fail('rateEur', 'solo.job.error.amountInvalid', 'rateEur must be a non-negative number');
  const loadReadyAt = optionalDate(b.loadReadyAt);
  if (!loadReadyAt.ok) return fail('loadReadyAt', 'solo.job.error.dateInvalid', 'loadReadyAt must be a valid date');
  const deliverByAt = optionalDate(b.deliverByAt);
  if (!deliverByAt.ok) return fail('deliverByAt', 'solo.job.error.dateInvalid', 'deliverByAt must be a valid date');
  if (loadReadyAt.value && deliverByAt.value && deliverByAt.value.getTime() < loadReadyAt.value.getTime()) {
    return fail('deliverByAt', 'solo.job.error.windowOrder', 'deliverByAt must not precede loadReadyAt');
  }
  const equipment = text(b.equipment, 40);
  if (equipment && !EQUIPMENT.includes(equipment)) {
    return fail('equipment', 'solo.job.error.equipmentUnknown', 'unknown equipment: ' + equipment);
  }
  return {
    ok: true,
    value: {
      customerId: customerId || null,
      customerName: customerName || null,
      origin,
      destination,
      cargo: text(b.cargo, 200) || null,
      rateEur: rate.value,
      loadReadyAt: loadReadyAt.value,
      deliverByAt: deliverByAt.value,
      equipment: equipment || null,
    },
  };
}

/**
 * The rows a quick job creates: the same `Order` + `Trip` pair the rest of the
 * product uses (no parallel "job" object), owned by the driver's own org and
 * driven by the driver. `status: 'ASSIGNED'` because the solo driver assigns
 * himself — there is nobody to dispatch.
 * @param {any} value the `normalizeQuickJob` result
 * @param {{ orgId: string, driverId: string, customerId: string }} args
 * @returns {{ order: any, trip: any, booking: any }}
 */
export function buildQuickJobRows(value, args) {
  return {
    order: {
      customerId: args.customerId,
      origin: value.origin,
      destination: value.destination,
      cargo: value.cargo,
      status: 'BOOKED',
      plannedAt: value.deliverByAt || null,
    },
    trip: {
      orgId: args.orgId,
      driverId: args.driverId,
      status: 'ASSIGNED',
      rateEur: value.rateEur,
    },
    booking: {
      supplyChoice: 'solo',
      equipment: value.equipment || null,
      loadReadyAt: value.loadReadyAt || null,
      deliverByAt: value.deliverByAt || null,
      notes: 'Own-customer quick job',
      details: { bookedVia: 'solo-app', ownCustomer: true },
    },
  };
}

/* -------------------------------------------------------- saved searches --- */

/** The query keys a saved search may carry (mirror of the feed's filter). */
export const SEARCH_KEYS = ['origin', 'destination', 'equipment', 'readyFrom', 'readyTo'];

/**
 * Validate a saved search / a feed filter. Unknown keys are dropped (a filter
 * is a preference, never a payload), the name is required, and equipment must be
 * in the shared vocabulary.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeSavedSearch(body) {
  if (!isObject(body)) return fail('form', 'solo.search.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const name = text(b.name, 80);
  if (!name) return fail('name', 'solo.search.error.nameRequired', 'name is required');
  const filter = normalizeSearchFilter(b.filter !== undefined ? b.filter : b);
  return { ok: true, value: { name, filter } };
}

/**
 * Keep only the known, non-empty filter keys; drop an unknown equipment value.
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
export function normalizeSearchFilter(value) {
  const src = isObject(value) ? /** @type {Record<string, any>} */ (value) : {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of SEARCH_KEYS) {
    const v = text(src[key], 100);
    if (!v) continue;
    if (key === 'equipment' && !EQUIPMENT.includes(v)) continue;
    out[key] = v;
  }
  return out;
}

/**
 * The `?` query string for the marketplace feed from a saved filter.
 * @param {unknown} filter
 * @returns {string}
 */
export function searchQueryString(filter) {
  const clean = normalizeSearchFilter(filter);
  const parts = Object.keys(clean).map(
    (key) => encodeURIComponent(key) + '=' + encodeURIComponent(clean[key]),
  );
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

/* ------------------------------------------------------------ read model --- */

/**
 * The status key for a catalogue lookup.
 * @param {unknown} status
 * @returns {string}
 */
export function statusKey(status) {
  const s = typeof status === 'string' ? status.trim().toUpperCase() : '';
  return s ? 'status.' + s : 'status.UNKNOWN';
}

/**
 * The single primary action a status offers on the solo surface, or null at the
 * end of the chain. Display-only: the server's `trip-status.js` decides legality.
 * @param {unknown} status
 * @returns {string|null}
 */
export function nextStatusAfter(status) {
  const i = SOLO_STATUS_CHAIN.indexOf(String(status || '').toUpperCase());
  if (i < 0 || i >= SOLO_STATUS_CHAIN.length - 1) return null;
  return SOLO_STATUS_CHAIN[i + 1];
}

/**
 * The wallet-lite row for one job (a trip the solo driver executes).
 * @param {any} trip
 * @returns {any|null}
 */
export function jobRow(trip) {
  if (!trip || typeof trip !== 'object') return null;
  const settlement = isObject(trip.settlement) ? trip.settlement : null;
  const order = isObject(trip.order) ? trip.order : null;
  const customer = order && isObject(order.customer) ? order.customer : null;
  return {
    id: trip.id,
    status: trip.status || 'DRAFT',
    rateEur: trip.rateEur === null || trip.rateEur === undefined ? null : num(trip.rateEur),
    origin: order ? order.origin || null : null,
    destination: order ? order.destination || null : null,
    customer: customer ? customer.name || null : null,
    deliveredAt: trip.deliveredAt || null,
    createdAt: trip.createdAt || null,
    settlement: settlement
      ? { status: settlement.status || 'PENDING', amountEur: settlement.amountEur === undefined ? null : num(settlement.amountEur) }
      : null,
  };
}

/**
 * Wallet-lite totals: how many jobs, what is earned/paid/outstanding. A job is
 * "earned" once the trip reached DELIVERED or beyond; payment status comes from
 * the existing `Settlement` row (manual during the free phase).
 * @param {any[]} trips
 * @returns {{ jobs: number, delivered: number, earnedEur: number, paidEur: number, outstandingEur: number, unpaid: number }}
 */
export function walletSummary(trips) {
  const list = Array.isArray(trips) ? trips : [];
  const rows = list.map(jobRow).filter(Boolean);
  let earned = 0;
  let paid = 0;
  let unpaid = 0;
  let delivered = 0;
  for (const row of rows) {
    const rate = row.rateEur || 0;
    const settled = row.settlement && row.settlement.status === 'PAID';
    if (String(row.status) === 'DELIVERED' || String(row.status) === 'POD_UPLOADED' || String(row.status) === 'INVOICED' || String(row.status) === 'SETTLED') {
      delivered += 1;
      earned += rate;
      if (settled) paid += rate;
      else unpaid += 1;
    } else if (settled) {
      // A settled trip that never delivered still counts as paid (defensive).
      earned += rate;
      paid += rate;
    }
  }
  return {
    jobs: rows.length,
    delivered,
    earnedEur: Math.round(earned * 100) / 100,
    paidEur: Math.round(paid * 100) / 100,
    outstandingEur: Math.round((earned - paid) * 100) / 100,
    unpaid,
  };
}

/**
 * The verification-paper row the surface renders.
 * @param {any} doc
 * @returns {any|null}
 */
export function verificationDocRow(doc) {
  if (!doc || typeof doc !== 'object') return null;
  return {
    id: doc.id,
    docType: doc.docType,
    status: doc.status || 'PENDING',
    filename: doc.filename || null,
    sizeBytes: doc.sizeBytes ?? null,
    expiresAt: doc.expiresAt || null,
    createdAt: doc.createdAt || null,
  };
}

/**
 * The saved-search row the surface renders.
 * @param {any} search
 * @returns {any|null}
 */
export function searchRow(search) {
  if (!search || typeof search !== 'object') return null;
  return { id: search.id, name: search.name || '', filter: normalizeSearchFilter(search.filter) };
}

/**
 * The marker the surface shows when the pilot has no SMS sender: the honest
 * state, never a silent "code sent".
 * @param {{ otpReturnCode?: boolean, phoneVerifiedAt?: unknown }} args
 * @returns {{ canSend: boolean, returnsCode: boolean, note: string|null }}
 */
export function otpDeliveryState({ otpReturnCode = false, phoneVerifiedAt = null } = {}) {
  return {
    canSend: true,
    returnsCode: Boolean(otpReturnCode),
    note: phoneVerifiedAt ? null : 'solo.otp.noSenderNote',
  };
}
