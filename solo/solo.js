/*
 * RoadwiseFleet solo driver Hauling Market MVP (board task #77, UXF-M2) — the surface
 * at `/s/`.
 *
 * Vanilla ES module, no build step, no CDN: the pilot targets cheap Android
 * WebViews. It talks only to the same-origin `/api/*` routes (the marketplace's
 * `/api/marketplace/*` and the solo `/api/solo/*`), reuses the customer portal's
 * session convention (a bearer token in sessionStorage), and renders with
 * `innerHTML` from data the API already shaped — never from a server value it
 * trusts blindly (everything is escaped).
 *
 * The domain rules live in `./lib/solo-core.js`, shared with the API, so this
 * file can never be more permissive than the server. The marketplace core
 * (loads/offers/beacons) is the API's; this surface only consumes it.
 */
import * as CORE from './lib/solo-core.js';

window.RoadwiseSolo = CORE;

const TOKEN_KEY = 'rwf.solo.token';
const USER_KEY = 'rwf.solo.user';
const PANELS = ['feed', 'load', 'offers', 'beacon', 'verify', 'jobs', 'customers', 'profile'];
const EQUIPMENT = CORE.EQUIPMENT;

const state = {
  token: null,
  user: null,
  driver: null,
  panel: 'feed',
  feed: [],
  filters: {},
  searches: [],
  detail: null,
  offers: [],
  beacon: null,
  capacity: [],
  verification: null,
  jobs: [],
  wallet: null,
  customers: [],
  trackLink: null,
  flash: null,
};

let CAT = {};

/* --------------------------------------------------------------- helpers --- */

const $ = (id) => document.getElementById(id);
const t = (key) => (CAT[key] === undefined ? key : CAT[key]);
const esc = (value) =>
  String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) =>
  n === null || n === undefined ? t('solo.na') : new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(Number(n));
const when = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : t('solo.na'));

async function loadCatalogue() {
  const res = await fetch('/s/locales/en.json');
  CAT = res.ok ? await res.json() : {};
  applyCatalogue();
}

/** Fill every static string the shell marked with `data-i18n`. */
function applyCatalogue() {
  [...document.querySelectorAll('[data-i18n]')].forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key && CAT[key] !== undefined) el.textContent = CAT[key];
  });
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error((data && data.error) || 'request_failed');
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

function reasonFor(error) {
  const data = error && error.data;
  if (data && data.messageKey && CAT[data.messageKey]) return CAT[data.messageKey];
  if (data && data.detail && CAT[data.detail]) return CAT[data.detail];
  if (data && data.detail && String(data.detail).startsWith('solo.')) return t(data.detail);
  const key = 'solo.error.' + ((data && data.error) || 'request_failed');
  return CAT[key] || (data && data.error) || 'request_failed';
}

function flash(panel, text, kind = 'error') {
  state.flash = { panel, text, kind };
}

function consumeFlash(panel) {
  if (state.flash && state.flash.panel === panel) {
    const out = state.flash;
    state.flash = null;
    return out;
  }
  return null;
}

function flashHtml(panel) {
  const f = consumeFlash(panel);
  if (!f) return '';
  return `<p class="alert ${f.kind === 'success' ? 'success' : 'error'}" role="status">${esc(f.text)}</p>`;
}

/* --------------------------------------------------------------- session --- */

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

function readSession() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const raw = sessionStorage.getItem(USER_KEY);
  if (!token) return false;
  state.token = token;
  try {
    state.user = raw ? JSON.parse(raw) : null;
  } catch (err) {
    state.user = null;
  }
  return true;
}

function clearSession() {
  state.token = null;
  state.user = null;
  state.driver = null;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

function showAuth() {
  $('authView').hidden = false;
  $('appView').hidden = true;
  $('appHeader').hidden = true;
}

function showApp() {
  $('authView').hidden = true;
  $('appView').hidden = false;
  $('appHeader').hidden = false;
}

/* ------------------------------------------------------------- rendering --- */

function optionList(selected, includeEmpty) {
  const empty = includeEmpty ? `<option value="">${esc(t('solo.any'))}</option>` : '';
  return (
    empty +
    EQUIPMENT.map(
      (e) =>
        `<option value="${esc(e)}"${e === selected ? ' selected' : ''}>${esc(t('equipment.' + e))}</option>`,
    ).join('')
  );
}

function feedView() {
  const rows = state.feed.length
    ? state.feed
        .map(
          (load) => `
      <li class="card">
        <div class="card-head">
          <strong>${esc(load.origin)} → ${esc(load.destination)}</strong>
          <span class="pill">${esc(t(CORE.statusKey(load.status)))}</span>
        </div>
        <p class="muted">${esc(load.equipment ? t('equipment.' + load.equipment) : t('solo.feed.anyEquipment'))} ·
          ${esc(t('solo.feed.ready'))} ${esc(when(load.loadReadyAt))} ·
          ${load.pricingMode === 'instant' ? esc(t('solo.feed.instant')) + ' ' + esc(eur(load.priceEur)) : esc(t('solo.feed.quotes'))}</p>
        <button type="button" data-action="open-load" data-id="${esc(load.id)}">${esc(t('solo.feed.open'))}</button>
      </li>`,
        )
        .join('')
    : `<li class="card muted">${esc(t('solo.feed.empty'))}</li>`;

  const chips = state.searches.length
    ? `<div class="chips">${state.searches
        .map(
          (s) =>
            `<span class="chip"><button type="button" data-action="apply-search" data-id="${esc(s.id)}">${esc(s.name)}</button>
             <button type="button" class="x" data-action="del-search" data-id="${esc(s.id)}" aria-label="${esc(t('solo.search.remove'))}">×</button></span>`,
        )
        .join('')}</div>`
    : '';

  return `
    ${flashHtml('feed')}
    <h2>${esc(t('solo.feed.title'))}</h2>
    ${chips}
    <form id="feedFilter" class="row">
      <label>${esc(t('solo.feed.origin'))}<input name="origin" value="${esc(state.filters.origin || '')}" autocomplete="off"></label>
      <label>${esc(t('solo.feed.destination'))}<input name="destination" value="${esc(state.filters.destination || '')}" autocomplete="off"></label>
      <label>${esc(t('solo.feed.equipment'))}<select name="equipment">${optionList(state.filters.equipment, true)}</select></label>
      <div class="actions">
        <button type="submit">${esc(t('solo.feed.search'))}</button>
        <button type="button" data-action="save-search">${esc(t('solo.search.save'))}</button>
      </div>
    </form>
    <ul class="list">${rows}</ul>`;
}

function loadView() {
  const detail = state.detail;
  if (!detail) return `<p class="muted">${esc(t('solo.load.gone'))}</p>`;
  const load = detail.load;
  const bidGate = state.driver && state.driver.verification ? state.driver.verification.status : 'NONE';
  // Owner #73 q5: verification is optional, so bidding never depends on it.
  const mayBid = CORE.canBid({ verificationStatus: bidGate }).allowed;
  const gate = !mayBid
    ? `<p class="alert error" role="status">${esc(t(bidGate === 'PENDING' ? 'solo.bid.pending' : 'solo.bid.unverified'))}</p>`
    : bidGate === 'VERIFIED'
      ? ''
      : `<p class="muted" role="status">${esc(t('solo.bid.optional'))}</p>`;
  const offers = (detail.offers || []).length
    ? `<ul class="list">${detail.offers
        .map(
          (o) =>
            `<li class="card"><strong>${esc(eur(o.priceEur))}</strong> <span class="pill">${esc(t(CORE.statusKey(o.status)))}</span>
             <p class="muted">${esc(t('solo.load.pickup'))} ${esc(when(o.pickupEtaAt))} · ${esc(t('solo.load.delivery'))} ${esc(when(o.deliveryEtaAt))}</p>
             ${o.note ? `<p>${esc(o.note)}</p>` : ''}</li>`,
        )
        .join('')}</ul>`
    : `<p class="muted">${esc(t('solo.load.noOffers'))}</p>`;

  const instant =
    load.pricingMode === 'instant' && load.priceEur !== null && load.priceEur !== undefined
      ? `<button type="button" data-action="accept-instant" data-id="${esc(load.id)}"${mayBid ? '' : ' disabled'}>${esc(t('solo.load.acceptInstant'))} ${esc(eur(load.priceEur))}</button>`
      : '';

  return `
    ${flashHtml('load')}
    <h2>${esc(load.origin)} → ${esc(load.destination)}</h2>
    <p class="muted">${esc(load.cargo || '')} ${load.equipment ? '· ' + esc(t('equipment.' + load.equipment)) : ''}</p>
    <p class="muted">${esc(t('solo.feed.ready'))} ${esc(when(load.loadReadyAt))} · ${esc(t('solo.load.deliverBy'))} ${esc(when(load.deliverByAt))}</p>
    ${gate}
    ${instant}
    <h3>${esc(t('solo.load.yourOffer'))}</h3>
    <form id="bidForm">
      <label>${esc(t('solo.load.price'))}<input name="priceEur" inputmode="decimal" value="${load.priceEur !== null && load.priceEur !== undefined ? esc(load.priceEur) : ''}" required></label>
      <label>${esc(t('solo.load.pickup'))}<input name="pickupEtaAt" type="datetime-local"></label>
      <label>${esc(t('solo.load.delivery'))}<input name="deliveryEtaAt" type="datetime-local"></label>
      <label>${esc(t('solo.load.note'))}<textarea name="note" rows="2"></textarea></label>
      <button type="submit"${mayBid ? '' : ' disabled'}>${esc(t('solo.load.bid'))}</button>
    </form>
    <h3>${esc(t('solo.load.offers'))}</h3>
    ${offers}
    <button type="button" data-action="nav" data-nav="feed">${esc(t('solo.back'))}</button>`;
}

function offersView() {
  const rows = state.offers.length
    ? state.offers
        .map(
          (o) => `
      <li class="card">
        <div class="card-head"><strong>${esc(o.load ? o.load.origin + ' → ' + o.load.destination : o.loadId)}</strong>
          <span class="pill">${esc(t(CORE.statusKey(o.status)))}</span></div>
        <p class="muted">${esc(eur(o.priceEur))} · ${esc(t('solo.load.pickup'))} ${esc(when(o.pickupEtaAt))}</p>
      </li>`,
        )
        .join('')
    : `<li class="card muted">${esc(t('solo.offers.empty'))}</li>`;
  return `${flashHtml('offers')}<h2>${esc(t('solo.offers.title'))}</h2><ul class="list">${rows}</ul>`;
}

function beaconView() {
  const truck = (state.driver && state.driver.truck) || {};
  const beacons = state.capacity.length
    ? `<ul class="list">${state.capacity
        .map(
          (b) =>
            `<li class="card"><strong>${esc(b.location)}</strong>${b.heading ? ' → ' + esc(b.heading) : ''}
             <p class="muted">${b.equipment ? esc(t('equipment.' + b.equipment)) + ' · ' : ''}${esc(t('solo.beacon.minRate'))} ${esc(eur(b.minRateEur))}</p></li>`,
        )
        .join('')}</ul>`
    : `<p class="muted">${esc(t('solo.beacon.none'))}</p>`;
  return `
    ${flashHtml('beacon')}
    <h2>${esc(t('solo.beacon.title'))}</h2>
    <p class="muted">${esc(t('solo.beacon.hint'))}</p>
    <form id="beaconForm">
      <label>${esc(t('solo.beacon.location'))}<input name="location" required autocomplete="off"></label>
      <label>${esc(t('solo.beacon.heading'))}<input name="heading" autocomplete="off"></label>
      <label>${esc(t('solo.beacon.availableFrom'))}<input name="availableFrom" type="datetime-local"></label>
      <label>${esc(t('solo.feed.equipment'))}<select name="equipment">${optionList(truck.equipment || '', true)}</select></label>
      <label>${esc(t('solo.beacon.minRate'))}<input name="minRateEur" inputmode="decimal"></label>
      <button type="submit">${esc(t('solo.beacon.publish'))}</button>
    </form>
    <h3>${esc(t('solo.beacon.capacity'))}</h3>
    ${beacons}`;
}

/**
 * One trust check mark for a paper. The mark is truthful by construction
 * (`verificationState().badges`): a supplied paper shows its review state, an
 * absent one shows no check. `title`/`aria-label` name the state in words so the
 * mark is not colour-only.
 */
function badgeHtml(badge) {
  const label = t('solo.verify.' + badge.docType);
  const markText = badge.mark === 'verified' ? '✓' : badge.mark === 'pending' ? '⋯' : '✕';
  const stateText = t('solo.verify.badge.' + badge.mark);
  const body = badge.mark === 'missing' ? '—' : markText;
  return `<span class="badge ${esc(badge.mark)}" title="${esc(label + ' — ' + stateText)}" aria-label="${esc(label + ' — ' + stateText)}">${body} ${esc(label)}</span>`;
}

function verifyView() {
  const verification = (state.verification && state.verification.verification) || { papers: [], missing: [], status: 'NONE', badges: [] };
  const docs = (state.verification && state.verification.documents) || [];
  // Only SUPPLIED papers render a mark (owner #73 q5: no papers → no check
  // marks); the papers list below still names every missing required paper.
  const badges = (verification.badges || []).filter((b) => b.supplied).map(badgeHtml).join(' ');
  const papers = verification.papers
    .map(
      (p) => `<li class="card"><div class="card-head"><strong>${esc(t('solo.verify.' + p.docType))}</strong>
        <span class="pill">${esc(p.present ? t(CORE.statusKey(p.status)) : t('solo.verify.missing'))}</span></div></li>`,
    )
    .join('');
  const uploaded = docs.length
    ? `<ul class="list">${docs
        .map(
          (d) =>
            `<li class="card"><span>${esc(t('solo.verify.' + d.docType))}</span> <span class="pill">${esc(t(CORE.statusKey(d.status)))}</span> <span class="muted">${esc(d.filename || '')}</span></li>`,
        )
        .join('')}</ul>`
    : '';
  const verified = verification.status === 'VERIFIED';
  return `
    ${flashHtml('verify')}
    <h2>${esc(t('solo.verify.title'))}</h2>
    <p class="muted">${esc(t('solo.verify.state'))}: <span class="pill">${esc(t(CORE.statusKey(verification.status)))}</span></p>
    <p class="alert ${verified ? 'success' : ''}" role="status">${esc(t(verified ? 'solo.verify.canBid' : 'solo.verify.optional'))}</p>
    ${badges ? `<p class="badges" role="group" aria-label="${esc(t('solo.verify.badges'))}">${badges}</p>` : ''}
    <ul class="list">${papers}</ul>
    <form id="verifyForm" enctype="multipart/form-data">
      <label>${esc(t('solo.verify.docType'))}<select name="docType">
        ${CORE.VERIFICATION_DOC_TYPES.map((d) => `<option value="${esc(d)}">${esc(t('solo.verify.' + d))}</option>`).join('')}
      </select></label>
      <label>${esc(t('solo.verify.file'))}<input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" required></label>
      <button type="submit">${esc(t('solo.verify.upload'))}</button>
    </form>
    <h3>${esc(t('solo.verify.papers'))}</h3>
    ${uploaded}`;
}

function jobsView() {
  const wallet = state.wallet || { jobs: 0, earnedEur: 0, paidEur: 0, outstandingEur: 0 };
  const customers = state.customers
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join('');
  const rows = state.jobs.length
    ? state.jobs
        .map((job) => {
          const next = CORE.nextStatusAfter(job.status);
          const pay = job.settlement ? t(CORE.statusKey(job.settlement.status)) : t('solo.jobs.unpaid');
          return `
        <li class="card">
          <div class="card-head"><strong>${esc(job.origin || '')} → ${esc(job.destination || '')}</strong>
            <span class="pill">${esc(t(CORE.statusKey(job.status)))}</span></div>
          <p class="muted">${esc(job.customer || '')} · ${esc(eur(job.rateEur))} · ${esc(t('solo.jobs.payment'))}: ${esc(pay)}</p>
          <div class="actions">
            ${next ? `<button type="button" data-action="advance" data-id="${esc(job.id)}" data-to="${esc(next)}">${esc(t('solo.jobs.advance'))} ${esc(t(CORE.statusKey(next)))}</button>` : ''}
            <button type="button" data-action="track-link" data-id="${esc(job.id)}">${esc(t('solo.jobs.share'))}</button>
          </div>
        </li>`;
        })
        .join('')
    : `<li class="card muted">${esc(t('solo.jobs.empty'))}</li>`;
  const link = state.trackLink
    ? `<p class="card"><label>${esc(t('solo.jobs.trackLink'))}<input readonly value="${esc(state.trackLink.url)}"></label></p>`
    : '';
  return `
    ${flashHtml('jobs')}
    <h2>${esc(t('solo.jobs.title'))}</h2>
    <div class="wallet">
      <div><span class="muted">${esc(t('solo.wallet.jobs'))}</span><strong>${esc(wallet.jobs)}</strong></div>
      <div><span class="muted">${esc(t('solo.wallet.earned'))}</span><strong>${esc(eur(wallet.earnedEur))}</strong></div>
      <div><span class="muted">${esc(t('solo.wallet.paid'))}</span><strong>${esc(eur(wallet.paidEur))}</strong></div>
      <div><span class="muted">${esc(t('solo.wallet.outstanding'))}</span><strong>${esc(eur(wallet.outstandingEur))}</strong></div>
    </div>
    ${link}
    <h3>${esc(t('solo.job.new'))}</h3>
    <form id="quickJobForm">
      <label>${esc(t('solo.job.customer'))}<select name="customerId"><option value="">${esc(t('solo.job.newCustomer'))}</option>${customers}</select></label>
      <label>${esc(t('solo.job.customerName'))}<input name="customerName" autocomplete="off"></label>
      <label>${esc(t('solo.feed.origin'))}<input name="origin" required autocomplete="off"></label>
      <label>${esc(t('solo.feed.destination'))}<input name="destination" required autocomplete="off"></label>
      <label>${esc(t('solo.job.rate'))}<input name="rateEur" inputmode="decimal"></label>
      <button type="submit">${esc(t('solo.job.create'))}</button>
    </form>
    <h3>${esc(t('solo.jobs.list'))}</h3>
    <ul class="list">${rows}</ul>`;
}

function customersView() {
  const rows = state.customers.length
    ? state.customers
        .map((c) => `<li class="card"><strong>${esc(c.name)}</strong> <span class="muted">${esc(c.email || c.whatsappId || '')}</span></li>`)
        .join('')
    : `<li class="card muted">${esc(t('solo.customers.empty'))}</li>`;
  return `
    ${flashHtml('customers')}
    <h2>${esc(t('solo.customers.title'))}</h2>
    <p class="muted">${esc(t('solo.customers.hint'))}</p>
    <ul class="list">${rows}</ul>
    <form id="customerForm">
      <label>${esc(t('solo.customer.name'))}<input name="name" required autocomplete="off"></label>
      <label>${esc(t('solo.customer.email'))}<input name="email" type="email" autocomplete="off"></label>
      <label>${esc(t('solo.customer.phone'))}<input name="phone" inputmode="tel" autocomplete="off"></label>
      <button type="submit">${esc(t('solo.customer.add'))}</button>
    </form>`;
}

function profileView() {
  const driver = state.driver || {};
  const truck = driver.truck || {};
  const otp = driver.otp || {};
  return `
    ${flashHtml('profile')}
    <h2>${esc(t('solo.profile.title'))}</h2>
    <p class="muted">${esc(driver.orgName || '')} · ${esc(t('solo.profile.phoneVerified'))}: ${esc(driver.phoneVerified ? t('solo.yes') : t('solo.no'))}</p>
    <form id="profileForm">
      <label>${esc(t('solo.profile.name'))}<input name="name" value="${esc(driver.name || '')}" required autocomplete="off"></label>
      <label>${esc(t('solo.profile.phone'))}<input name="phone" value="${esc(driver.phone || '')}" inputmode="tel" autocomplete="off"></label>
      <label>${esc(t('solo.profile.plate'))}<input name="truckPlate" value="${esc(truck.plate || '')}" autocomplete="off"></label>
      <label>${esc(t('solo.feed.equipment'))}<select name="truckEquipment">${optionList(truck.equipment || '', true)}</select></label>
      <label>${esc(t('solo.profile.capacity'))}<input name="truckCapacityKg" inputmode="numeric" value="${truck.capacityKg === null || truck.capacityKg === undefined ? '' : esc(truck.capacityKg)}"></label>
      <button type="submit">${esc(t('solo.profile.save'))}</button>
    </form>
    <h3>${esc(t('solo.otp.title'))}</h3>
    <p class="muted">${esc(t(otp.note || 'solo.otp.noSenderNote'))}</p>
    <form id="otpForm">
      <label>${esc(t('solo.profile.phone'))}<input name="phone" value="${esc(driver.phone || '')}" inputmode="tel"></label>
      <div class="actions">
        <button type="button" data-action="send-otp">${esc(t('solo.otp.send'))}</button>
        <button type="submit">${esc(t('solo.otp.verify'))}</button>
      </div>
      <label>${esc(t('solo.otp.code'))}<input name="code" inputmode="numeric" autocomplete="one-time-code"></label>
    </form>
    <button type="button" data-action="logout">${esc(t('solo.logout'))}</button>`;
}

function render(panel) {
  if (PANELS.indexOf(panel) === -1) panel = 'feed';
  state.panel = panel;
  const views = {
    feed: feedView,
    load: loadView,
    offers: offersView,
    beacon: beaconView,
    verify: verifyView,
    jobs: jobsView,
    customers: customersView,
    profile: profileView,
  };
  $('panel').innerHTML = views[panel]();
  [...$('soloNav').querySelectorAll('button[data-nav]')].forEach((b) => {
    b.setAttribute('aria-current', b.getAttribute('data-nav') === panel ? 'page' : 'false');
  });
}

/* --------------------------------------------------------------- loading --- */

async function refreshMe() {
  const data = await api('/api/solo/me');
  state.driver = data.driver;
  return data.driver;
}

async function loadFeed(filters) {
  state.filters = filters || state.filters;
  const query = CORE.searchQueryString(state.filters);
  const data = await api('/api/marketplace/loads' + query);
  state.feed = data.loads || [];
}

async function loadSearches() {
  const data = await api('/api/solo/searches');
  state.searches = data.searches || [];
}

async function openLoad(id) {
  state.detail = await api('/api/marketplace/loads/' + encodeURIComponent(id));
}

async function loadOffers() {
  const data = await api('/api/marketplace/offers/mine');
  state.offers = data.offers || [];
}

async function loadBeacons() {
  const data = await api('/api/marketplace/beacons');
  state.capacity = data.beacons || [];
}

async function loadVerification() {
  state.verification = await api('/api/solo/verification');
}

async function loadJobs() {
  const data = await api('/api/solo/jobs');
  state.jobs = data.jobs || [];
  state.wallet = data.wallet || null;
}

async function loadCustomers() {
  const data = await api('/api/solo/customers');
  state.customers = data.customers || [];
}

async function openPanel(panel) {
  try {
    if (panel === 'feed') {
      await Promise.all([loadFeed(), loadSearches()]);
    } else if (panel === 'offers') {
      await loadOffers();
    } else if (panel === 'beacon') {
      if (!state.driver) await refreshMe();
      await loadBeacons();
    } else if (panel === 'verify') {
      await loadVerification();
    } else if (panel === 'jobs') {
      await Promise.all([loadJobs(), loadCustomers()]);
    } else if (panel === 'customers') {
      await loadCustomers();
    } else if (panel === 'profile') {
      await refreshMe();
    }
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      showAuth();
      return;
    }
    flash(panel, reasonFor(err));
  }
  render(panel);
}

/* --------------------------------------------------------------- actions --- */

async function signIn(form) {
  const body = {
    email: form.querySelector('[name="email"]').value.trim(),
    password: form.querySelector('[name="password"]').value,
  };
  try {
    const data = await api('/api/auth/login', { method: 'POST', body });
    // The login route returns any role; only a solo login has a profile.
    saveSession(data.token, data.user);
    await refreshMe();
    showApp();
    await openPanel('feed');
  } catch (err) {
    clearSession();
    $('loginMsg').textContent = reasonFor(err);
  }
}

async function signUp(form) {
  const body = {
    name: form.querySelector('[name="name"]').value,
    email: form.querySelector('[name="email"]').value,
    phone: form.querySelector('[name="phone"]').value,
    password: form.querySelector('[name="password"]').value,
    truckPlate: form.querySelector('[name="truckPlate"]') ? form.querySelector('[name="truckPlate"]').value : '',
    truckEquipment: form.querySelector('[name="truckEquipment"]') ? form.querySelector('[name="truckEquipment"]').value : '',
  };
  const check = CORE.validateSoloSignup(body);
  if (!check.ok) {
    $('signupMsg').textContent = CAT[check.messageKey] || check.detail;
    const input = form.querySelector('[name="' + check.field + '"]');
    if (input) input.setAttribute('aria-invalid', 'true');
    return;
  }
  try {
    const data = await api('/api/solo/signup', { method: 'POST', body: check.value });
    saveSession(data.token, data.user);
    await refreshMe();
    showApp();
    await openPanel('feed');
  } catch (err) {
    $('signupMsg').textContent = reasonFor(err);
  }
}

async function placeBid(priceEur, extra) {
  try {
    await api('/api/marketplace/loads/' + encodeURIComponent(state.detail.load.id) + '/offers', {
      method: 'POST',
      body: Object.assign({ priceEur: Number(priceEur) }, extra || {}),
    });
    flash('load', t('solo.bid.placed'), 'success');
    await openLoad(state.detail.load.id);
  } catch (err) {
    flash('load', reasonFor(err));
  }
  render('load');
}

async function publishBeacon(form) {
  const body = {
    location: form.querySelector('[name="location"]').value,
    heading: form.querySelector('[name="heading"]').value,
    availableFrom: form.querySelector('[name="availableFrom"]').value || null,
    equipment: form.querySelector('[name="equipment"]').value || null,
    minRateEur: form.querySelector('[name="minRateEur"]').value || null,
  };
  try {
    const data = await api('/api/marketplace/beacons', { method: 'POST', body });
    state.beacon = data.beacon;
    flash('beacon', t('solo.beacon.published'), 'success');
    await loadBeacons();
  } catch (err) {
    flash('beacon', reasonFor(err));
  }
  render('beacon');
}

async function fileToBase64(file) {
  if (typeof file.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || String(reader.result));
    reader.onerror = () => reject(new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

async function uploadVerification(form) {
  const input = form.querySelector('[name="file"]');
  const file = input && input.files && input.files[0];
  if (!file) {
    flash('verify', t('solo.verify.error.filenameRequired'));
    render('verify');
    return;
  }
  try {
    const dataBase64 = await fileToBase64(file);
    await api('/api/solo/verification', {
      method: 'POST',
      body: {
        docType: form.querySelector('[name="docType"]').value,
        filename: file.name,
        mimeType: file.type,
        dataBase64,
      },
    });
    flash('verify', t('solo.verify.uploaded'), 'success');
    await loadVerification();
    await refreshMe();
  } catch (err) {
    flash('verify', reasonFor(err));
  }
  render('verify');
}

async function createJob(form) {
  const body = {
    customerId: form.querySelector('[name="customerId"]').value || '',
    customerName: form.querySelector('[name="customerName"]').value,
    origin: form.querySelector('[name="origin"]').value,
    destination: form.querySelector('[name="destination"]').value,
    rateEur: form.querySelector('[name="rateEur"]').value,
  };
  const check = CORE.normalizeQuickJob(body);
  if (!check.ok) {
    flash('jobs', CAT[check.messageKey] || check.detail);
    render('jobs');
    return;
  }
  try {
    await api('/api/solo/jobs', { method: 'POST', body });
    flash('jobs', t('solo.job.created'), 'success');
    await Promise.all([loadJobs(), loadCustomers()]);
  } catch (err) {
    flash('jobs', reasonFor(err));
  }
  render('jobs');
}

async function addCustomer(form) {
  const body = {
    name: form.querySelector('[name="name"]').value,
    email: form.querySelector('[name="email"]').value,
    phone: form.querySelector('[name="phone"]').value,
  };
  const check = CORE.normalizeSoloCustomer(body);
  if (!check.ok) {
    flash('customers', CAT[check.messageKey] || check.detail);
    render('customers');
    return;
  }
  try {
    await api('/api/solo/customers', { method: 'POST', body });
    flash('customers', t('solo.customer.added'), 'success');
    await loadCustomers();
  } catch (err) {
    flash('customers', reasonFor(err));
  }
  render('customers');
}

async function saveProfile(form) {
  const body = {
    name: form.querySelector('[name="name"]').value,
    phone: form.querySelector('[name="phone"]').value,
    truckPlate: form.querySelector('[name="truckPlate"]').value,
    truckEquipment: form.querySelector('[name="truckEquipment"]').value,
    truckCapacityKg: form.querySelector('[name="truckCapacityKg"]').value,
  };
  try {
    await api('/api/solo/me', { method: 'PATCH', body });
    flash('profile', t('solo.profile.saved'), 'success');
    await refreshMe();
  } catch (err) {
    flash('profile', reasonFor(err));
  }
  render('profile');
}

async function sendOtp(form) {
  const phone = form.querySelector('[name="phone"]').value;
  try {
    const data = await api('/api/solo/otp', { method: 'POST', body: { phone } });
    flash('profile', data.devCode ? t('solo.otp.devEcho') + ' ' + data.devCode : t('solo.otp.sent'), 'success');
  } catch (err) {
    flash('profile', reasonFor(err));
  }
  render('profile');
}

async function verifyOtp(form) {
  try {
    await api('/api/solo/otp/verify', { method: 'POST', body: { code: form.querySelector('[name="code"]').value } });
    flash('profile', t('solo.otp.verified'), 'success');
    await refreshMe();
  } catch (err) {
    flash('profile', reasonFor(err));
  }
  render('profile');
}

async function advanceJob(id, to) {
  try {
    await api('/api/trips/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { status: to } });
    flash('jobs', t('solo.jobs.advanced') + ' ' + t(CORE.statusKey(to)), 'success');
    await loadJobs();
  } catch (err) {
    flash('jobs', reasonFor(err));
  }
  render('jobs');
}

async function shareJob(id) {
  try {
    const data = await api('/api/trips/' + encodeURIComponent(id) + '/track-link', { method: 'POST' });
    state.trackLink = data.link;
    flash('jobs', t('solo.jobs.linkReady'), 'success');
  } catch (err) {
    flash('jobs', reasonFor(err));
  }
  render('jobs');
}

/* ------------------------------------------------------------- listeners --- */

$('panel').addEventListener('submit', (event) => {
  const form = event.target;
  event.preventDefault();
  const handlers = {
    feedFilter: () => {
      const f = {
        origin: form.querySelector('[name="origin"]').value,
        destination: form.querySelector('[name="destination"]').value,
        equipment: form.querySelector('[name="equipment"]').value,
      };
      loadFeed(f).then(() => render('feed')).catch((err) => {
        flash('feed', reasonFor(err));
        render('feed');
      });
    },
    bidForm: () => {
      // Defence in depth: the shared rule is applied in the handler too, so a
      // programmatic submit cannot bypass what the button shows. With owner
      // #73 q5 (verification optional) it allows every solo driver; the check
      // stays, so re-arming the rule re-arms the handler with it.
      const status = state.driver && state.driver.verification ? state.driver.verification.status : 'NONE';
      if (!CORE.canBid({ verificationStatus: status }).allowed) {
        flash('load', t(status === 'PENDING' ? 'solo.bid.pending' : 'solo.bid.unverified'));
        render('load');
        return;
      }
      placeBid(form.querySelector('[name="priceEur"]').value, {
        pickupEtaAt: form.querySelector('[name="pickupEtaAt"]').value || null,
        deliveryEtaAt: form.querySelector('[name="deliveryEtaAt"]').value || null,
        note: form.querySelector('[name="note"]').value,
      });
    },
    beaconForm: () => publishBeacon(form),
    verifyForm: () => uploadVerification(form),
    quickJobForm: () => createJob(form),
    customerForm: () => addCustomer(form),
    profileForm: () => saveProfile(form),
    otpForm: () => verifyOtp(form),
  };
  const handler = handlers[form.id];
  if (handler) handler();
});

$('panel').addEventListener('click', (event) => {
  const target = event.target;
  if (!target || typeof target.getAttribute !== 'function') return;
  const action = target.getAttribute('data-action');
  if (!action) return;
  event.preventDefault();
  const id = target.getAttribute('data-id');
  if (action === 'nav') {
    openPanel(target.getAttribute('data-nav'));
  } else if (action === 'open-load') {
    openLoad(id)
      .then(() => render('load'))
      .catch((err) => {
        flash('feed', reasonFor(err));
        render('feed');
      });
  } else if (action === 'accept-instant') {
    placeBid(state.detail.load.priceEur, {});
  } else if (action === 'save-search') {
    const name = window.prompt ? window.prompt(t('solo.search.namePrompt')) : '';
    if (!name) return;
    api('/api/solo/searches', { method: 'POST', body: { name, filter: state.filters } })
      .then(loadSearches)
      .then(() => render('feed'))
      .catch((err) => {
        flash('feed', reasonFor(err));
        render('feed');
      });
  } else if (action === 'apply-search') {
    const search = state.searches.find((s) => s.id === id);
    if (!search) return;
    loadFeed(search.filter)
      .then(() => render('feed'))
      .catch((err) => {
        flash('feed', reasonFor(err));
        render('feed');
      });
  } else if (action === 'del-search') {
    api('/api/solo/searches/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(loadSearches)
      .then(() => render('feed'))
      .catch((err) => {
        flash('feed', reasonFor(err));
        render('feed');
      });
  } else if (action === 'advance') {
    advanceJob(id, target.getAttribute('data-to'));
  } else if (action === 'track-link') {
    shareJob(id);
  } else if (action === 'send-otp') {
    sendOtp($('panel').querySelector('#otpForm'));
  } else if (action === 'logout') {
    clearSession();
    showAuth();
  }
});

$('soloNav').addEventListener('click', (event) => {
  const target = event.target;
  if (target && typeof target.getAttribute === 'function' && target.getAttribute('data-nav')) {
    openPanel(target.getAttribute('data-nav'));
  }
});

$('loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  signIn($('loginForm'));
});

$('signupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  signUp($('signupForm'));
});

$('showSignup').addEventListener('click', () => {
  $('loginForm').hidden = true;
  $('signupForm').hidden = false;
  $('showSignup').hidden = true;
  $('showLogin').hidden = false;
  $('authTitle').textContent = t('solo.signup.title');
});

$('showLogin').addEventListener('click', () => {
  $('signupForm').hidden = true;
  $('loginForm').hidden = false;
  $('showLogin').hidden = true;
  $('showSignup').hidden = false;
  $('authTitle').textContent = t('solo.login.title');
});

/* ------------------------------------------------------------------ boot --- */

(async function main() {
  await loadCatalogue();
  $('loginForm').hidden = false;
  $('signupForm').hidden = true;
  $('showLogin').hidden = true;
  $('showSignup').hidden = false;
  $('authTitle').textContent = t('solo.login.title');
  $('loginMsg').textContent = '';
  $('signupMsg').textContent = '';
  if (readSession()) {
    try {
      await refreshMe();
      showApp();
      await openPanel('feed');
      return;
    } catch (err) {
      clearSession();
    }
  }
  showAuth();
})();
