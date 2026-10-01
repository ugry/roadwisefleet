/**
 * RoadwiseFleet — Customer portal UI (board task #74, UXF-C1).
 *
 * The DOM half of the customer surface: signup/sign-in, the book-a-load wizard
 * with the explicit supply choice, the shipments list with the tracking link,
 * and the account (profile, notification preferences, team, addresses).
 *
 * Every rule about *what a booking may contain* lives in
 * `lib/customer-core.js`, which the API also imports — this file only reads the
 * form, asks the core, and paints the answer. That is why a field error here
 * always matches the message the server would have produced.
 *
 * Browser-only; the pure half is what `node --test apps/api/src/` covers.
 */
import * as CORE from './lib/customer-core.js';

if (typeof window !== 'undefined') window.RoadwiseCustomer = CORE;

const TOKEN_KEY = 'rwf.customer.token';
const USER_KEY = 'rwf.customer.user';

const PANELS = {
  shipments: 'shipmentsPanel',
  book: 'bookPanel',
  shipment: 'shipmentPanel',
  offers: 'offersPanel',
  autoMatch: 'autoMatchPanel',
  reviews: 'reviewsPanel',
  account: 'accountPanel'
};

const state = {
  view: 'shipments',
  catalogue: {},
  token: '',
  user: null,
  shipmentId: null,
  loadId: null,
  me: null,
  trackLink: null,
  offerLoad: null,
  compare: [],
  autoMatch: null
};

/* ------------------------------------------------------------- helpers --- */

function $(id) {
  return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Translate a catalogue key; `{name}` placeholders are substituted. */
function t(key, params) {
  const raw = state.catalogue[key];
  let out = typeof raw === 'string' ? raw : key;
  if (params && typeof params === 'object') {
    Object.keys(params).forEach((k) => {
      out = out.split('{' + k + '}').join(String(params[k]));
    });
  }
  return out;
}

/** The catalogue key for an API failure. */
function errorKey(err) {
  if (!err) return 'error.unexpected';
  if (err.error === 'email_taken') return 'error.emailTaken';
  if (err.error === 'no_carrier_org') return 'error.noCarrierOrg';
  if (err.error === 'network') return 'error.network';
  // Marketplace (#78) failures with their own sentence.
  const byCode = {
    auto_match_pending_owner: 'autoMatch.gate',
    load_awarded: 'offers.err.loadAwarded',
    load_closed: 'offers.err.loadClosed',
    load_expired: 'offers.err.loadExpired',
    offer_closed: 'offers.err.offerClosed',
    offer_expired: 'offers.err.offerExpired',
    load_not_found: 'offers.err.loadNotFound',
    offer_not_found: 'offers.err.offerNotFound',
    // Reviews (board task #98): a second review is refused, never a rewrite.
    already_reviewed: 'reviews.already'
  };
  if (err.error && byCode[err.error]) return byCode[err.error];
  const byStatus = {
    0: 'error.network',
    400: 'error.badRequest',
    401: 'error.sessionExpired',
    403: 'error.forbidden',
    404: 'error.notFound',
    409: 'error.conflict',
    423: 'error.accountLocked',
    429: 'error.rateLimited',
    503: 'error.noCarrierOrg'
  };
  return byStatus[err.status] || 'error.unexpected';
}

function setMsg(id, messageKey, kind) {
  const node = $(id);
  if (!node) return;
  if (!messageKey) {
    node.textContent = '';
    node.hidden = true;
    node.className = 'alert';
    return;
  }
  node.textContent = t(messageKey);
  node.className = 'alert' + (kind ? ' ' + kind : '');
  node.hidden = false;
}

/** A stable id for a field's error paragraph. */
function errId(field) {
  return 'err-' + String(field).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** Render (or clear) the inline error for a field, and wire aria. */
function setFieldError(scope, field, messageKey) {
  if (!scope || !field) return;
  const input = scope.querySelector('[name="' + field + '"]');
  if (!input) return;
  let node = scope.querySelector('[data-err="' + field + '"]');
  if (!node) {
    node = document.createElement('p');
    node.className = 'field-error';
    node.setAttribute('data-err', field);
    input.insertAdjacentElement('afterend', node);
  }
  node.id = errId(field);
  node.textContent = t(messageKey);
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', node.id);
  return input;
}

function clearFieldErrors(scope) {
  if (!scope) return;
  Array.prototype.forEach.call(scope.querySelectorAll('.field-error'), (node) => {
    if (node.parentNode) node.parentNode.removeChild(node);
  });
  Array.prototype.forEach.call(scope.querySelectorAll('[aria-invalid]'), (node) => {
    node.removeAttribute('aria-invalid');
    node.removeAttribute('aria-describedby');
  });
}

/* --------------------------------------------------------- session/api --- */

function storage() {
  try {
    if (typeof sessionStorage === 'undefined' || sessionStorage === null) return null;
    sessionStorage.getItem(TOKEN_KEY);
    return sessionStorage;
  } catch (err) {
    return null;
  }
}

function readSession() {
  const store = storage();
  if (!store) return { token: '', user: null };
  let user = null;
  try {
    user = JSON.parse(store.getItem(USER_KEY) || 'null');
  } catch (err) {
    user = null;
  }
  return { token: store.getItem(TOKEN_KEY) || '', user };
}

function writeSession(token, user) {
  const store = storage();
  if (!store) return;
  if (token) store.setItem(TOKEN_KEY, token);
  if (user) store.setItem(USER_KEY, JSON.stringify(user));
}

function clearSession() {
  const store = storage();
  if (!store) return;
  store.removeItem(TOKEN_KEY);
  store.removeItem(USER_KEY);
  state.token = '';
  state.user = null;
}

/** fetch wrapper: JSON in, JSON out, one error shape. */
async function api(path, opts) {
  const options = opts || {};
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  let res;
  try {
    res = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch (err) {
    throw { status: 0, error: 'network' };
  }
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) {
    throw {
      status: res.status,
      error: (data && data.error) || 'unexpected',
      field: data && data.field,
      detail: data && data.detail
    };
  }
  return data || {};
}

/** The server is authoritative about the session; a stale token lands on login. */
async function loadMe() {
  try {
    state.me = await api('/customer/me');
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      clearSession();
      return false;
    }
    return false;
  }
}

/* ---------------------------------------------------------------- views --- */

function applyStaticCopy() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), (node) => {
    node.textContent = t(node.getAttribute('data-i18n'));
  });
}

function showView(which) {
  const auth = $('authView');
  const signup = $('signupView');
  const app = $('appView');
  if (auth) auth.hidden = which !== 'auth';
  if (signup) signup.hidden = which !== 'signup';
  if (app) app.hidden = which !== 'app';
}

function showPanel(view) {
  if (!PANELS[view]) return;
  state.view = view;
  Object.keys(PANELS).forEach((key) => {
    const node = $(PANELS[key]);
    if (node) node.hidden = key !== view;
  });
  const nav = $('customerNav');
  if (nav) {
    Array.prototype.forEach.call(nav.querySelectorAll('button[data-nav]'), (button) => {
      const target = button.getAttribute('data-nav');
      const active = target === view || (view === 'shipment' && target === 'shipments');
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }
  if (view === 'shipments') renderShipments();
  if (view === 'book') renderBook();
  if (view === 'offers') renderOffers();
  if (view === 'autoMatch') renderAutoMatch();
  if (view === 'reviews') renderReviews();
  if (view === 'account') renderAccount();
}

/* ------------------------------------------------------------ shipments --- */

function statusPill(status) {
  const s = String(status || '').toUpperCase();
  const settled = ['DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED', 'COMPLETED'];
  const cls = settled.indexOf(s) === -1 ? 'status pending' : 'status';
  return '<span class="' + cls + '">' + esc(t(CORE.statusKey(s))) + '</span>';
}

async function renderShipments() {
  const wrap = $('shipmentsList');
  if (!wrap) return;
  wrap.innerHTML = '<p class="muted">' + esc(t('common.loading')) + '</p>';
  let data;
  try {
    data = await api('/customer/orders');
  } catch (err) {
    setMsg('globalMsg', errorKey(err), 'error');
    wrap.innerHTML = '';
    return;
  }
  setMsg('globalMsg', '');
  const orders = Array.isArray(data.orders) ? data.orders : [];
  if (orders.length === 0) {
    wrap.innerHTML = '<p class="muted">' + esc(t('shipments.empty')) + '</p>';
    return;
  }
  wrap.innerHTML = orders
    .map((order) => {
      const trip = order.trip;
      const status = trip ? trip.status : order.status;
      const booked = order.createdAt ? new Date(order.createdAt).toLocaleDateString() : '';
      return (
        '<article class="trip-row">' +
        '<span class="route">' + esc(order.origin) + ' → ' + esc(order.destination) + '</span>' +
        '<span>' + statusPill(status) + '</span>' +
        '<span class="meta">' + esc(t('shipments.created')) + ': ' + esc(booked) + '</span>' +
        '<div class="actions"><button type="button" class="secondary" data-open="' + esc(order.id) + '">' +
        esc(t('shipments.open')) + '</button></div>' +
        '</article>'
      );
    })
    .join('');
}

/* ----------------------------------------------------------- shipment --- */

async function openShipment(id) {
  state.shipmentId = id;
  state.trackLink = null;
  showPanel('shipment');
  const wrap = $('shipmentDetail');
  if (wrap) wrap.innerHTML = '<p class="muted">' + esc(t('common.loading')) + '</p>';
  let data;
  try {
    data = await api('/customer/orders/' + encodeURIComponent(id));
  } catch (err) {
    setMsg('globalMsg', errorKey(err), 'error');
    if (wrap) wrap.innerHTML = '';
    return;
  }
  setMsg('globalMsg', '');
  state.trackLink = data.trackLink || null;
  renderShipment(data.order, state.trackLink);
}

function detailRow(labelKey, value) {
  if (value === null || value === undefined || value === '') return '';
  return '<div><dt>' + esc(t(labelKey)) + '</dt><dd>' + esc(value) + '</dd></div>';
}

function renderShipment(order, trackLink) {
  const wrap = $('shipmentDetail');
  if (!wrap || !order) return;
  const booking = order.booking || {};
  const status = order.trip ? order.trip.status : order.status;
  const stops = Array.isArray(booking.stops) ? booking.stops : [];
  const rows = [
    detailRow('shipment.cargo', order.cargo),
    detailRow('shipment.status', t(CORE.statusKey(status))),
    detailRow('shipment.created', order.createdAt ? new Date(order.createdAt).toLocaleString() : ''),
    detailRow('shipment.planned', order.plannedAt ? new Date(order.plannedAt).toLocaleString() : ''),
    detailRow('shipment.trip', order.trip ? order.trip.id : ''),
    detailRow('shipment.equipment', booking.equipment ? t('equipment.' + booking.equipment) : ''),
    detailRow('shipment.loadReady', booking.loadReadyAt ? new Date(booking.loadReadyAt).toLocaleString() : ''),
    detailRow('shipment.deliverBy', booking.deliverByAt ? new Date(booking.deliverByAt).toLocaleString() : ''),
    detailRow('shipment.pricing', booking.pricingMode ? t('book.pricing.' + booking.pricingMode) : ''),
    detailRow('shipment.budget', booking.budgetEur === null || booking.budgetEur === undefined ? '' : String(booking.budgetEur)),
    detailRow('shipment.payer', booking.payer ? t('book.payer.' + booking.payer) : ''),
    detailRow('shipment.payment', booking.paymentMethod ? t('book.pay.' + booking.paymentMethod) : ''),
    detailRow('shipment.insurance', booking.insuranceValueEur === null || booking.insuranceValueEur === undefined ? '' : String(booking.insuranceValueEur)),
    detailRow('shipment.special', booking.specialRequirements),
    detailRow('shipment.notes', booking.notes)
  ].join('');

  const stopsHtml = stops.length
    ? '<h2>' + esc(t('shipment.stops')) + '</h2><ul>' +
      stops.map((s) => '<li>' + esc(t('book.kind.' + s.kind)) + ': ' + esc(s.address) + '</li>').join('') +
      '</ul>'
    : '';

  const tracking = trackLink && trackLink.url
    ? '<p><a class="link" href="' + esc(trackLink.url) + '" target="_blank" rel="noopener">' + esc(t('shipment.trackCopy')) + '</a></p>'
    : '<p class="muted">' + esc(t('shipment.trackNone')) + '</p>' +
      '<button type="button" id="mintTrackLink" class="secondary">' + esc(t('shipment.trackCreate')) + '</button>';

  wrap.innerHTML =
    '<h1>' + esc(t('shipment.heading')) + '</h1>' +
    '<p class="route">' + esc(order.origin) + ' → ' + esc(order.destination) + '</p>' +
    '<p>' + statusPill(status) + '</p>' +
    '<dl class="detail">' + rows + '</dl>' + stopsHtml +
    '<h2>' + esc(t('shipment.tracking')) + '</h2>' + tracking +
    '<p id="shipmentMsg" class="alert" role="status" hidden></p>';

  const button = wrap.querySelector('#mintTrackLink');
  if (button) button.addEventListener('click', mintTrackLink);
}

async function mintTrackLink() {
  if (!state.shipmentId) return;
  const button = $('shipmentDetail') ? $('shipmentDetail').querySelector('#mintTrackLink') : null;
  if (button) {
    button.disabled = true;
    button.textContent = t('common.loading');
  }
  try {
    const data = await api('/customer/orders/' + encodeURIComponent(state.shipmentId) + '/track-link', { method: 'POST' });
    state.trackLink = data.link || null;
    await openShipment(state.shipmentId);
  } catch (err) {
    setMsg('shipmentMsg', errorKey(err), 'error');
    if (button) {
      button.disabled = false;
      button.textContent = t('shipment.trackCreate');
    }
  }
}

/* ---------------------------------------------------------------- book --- */

function choiceCard(choice, checked) {
  const flag = choice.marketplace
    ? '<span class="choice-flag">' + esc(t('book.pendingFlag')) + '</span>'
    : '';
  return (
    '<label class="choice">' +
    '<input type="radio" name="supplyChoice" value="' + esc(choice.id) + '"' + (checked ? ' checked' : '') + '>' +
    '<span><span class="choice-title">' + esc(t(choice.i18n)) + '</span>' +
    '<span class="choice-desc">' + esc(t(choice.descI18n)) + '</span>' + flag + '</span>' +
    '</label>'
  );
}

function renderBook() {
  const host = $('bookForm');
  if (!host) return;
  const options = CORE.EQUIPMENT.map(
    (id) => '<option value="' + esc(id) + '">' + esc(t('equipment.' + id)) + '</option>'
  ).join('');
  const modes = CORE.PRICING_MODES.map(
    (id) => '<option value="' + esc(id) + '">' + esc(t('book.pricing.' + id)) + '</option>'
  ).join('');
  const payers = CORE.PAYERS.map(
    (id) => '<option value="' + esc(id) + '">' + esc(t('book.payer.' + id)) + '</option>'
  ).join('');
  const methods = CORE.PAYMENT_METHODS.map(
    (id) => '<option value="' + esc(id) + '">' + esc(t('book.pay.' + id)) + '</option>'
  ).join('');

  const choices = CORE.SUPPLY_CHOICES.map((choice) => choiceCard(choice, false)).join('') +
    choiceCard(CORE.OFF_PLATFORM_CHOICE, false);

  host.innerHTML =
    '<form id="bookingForm" novalidate>' +
    '<h2>' + esc(t('book.sectionRoute')) + '</h2>' +
    '<label for="bk-origin">' + esc(t('book.origin')) + '</label>' +
    '<input id="bk-origin" name="origin" type="text" autocomplete="street-address">' +
    '<label for="bk-destination">' + esc(t('book.destination')) + '</label>' +
    '<input id="bk-destination" name="destination" type="text" autocomplete="street-address">' +
    '<div class="actions"><button type="button" id="bk-addStop" class="secondary">' + esc(t('book.addStop')) + '</button></div>' +
    '<div id="bk-stops"></div>' +

    '<h2>' + esc(t('book.sectionCargo')) + '</h2>' +
    '<label for="bk-cargo">' + esc(t('book.cargo')) + '</label>' +
    '<input id="bk-cargo" name="cargo" type="text">' +
    '<label for="bk-weightKg">' + esc(t('book.weight')) + '</label>' +
    '<input id="bk-weightKg" name="weightKg" type="number" min="0" step="1" inputmode="decimal">' +
    '<label for="bk-pallets">' + esc(t('book.pallets')) + '</label>' +
    '<input id="bk-pallets" name="pallets" type="number" min="0" step="1" inputmode="numeric">' +
    '<label for="bk-equipment">' + esc(t('book.equipment')) + '</label>' +
    '<select id="bk-equipment" name="equipment"><option value="">' + esc(t('book.none')) + '</option>' + options + '</select>' +

    '<h2>' + esc(t('book.sectionDates')) + '</h2>' +
    '<label for="bk-loadReadyAt">' + esc(t('book.loadReady')) + '</label>' +
    '<input id="bk-loadReadyAt" name="loadReadyAt" type="datetime-local">' +
    '<label for="bk-deliverByAt">' + esc(t('book.deliverBy')) + '</label>' +
    '<input id="bk-deliverByAt" name="deliverByAt" type="datetime-local">' +

    '<h2>' + esc(t('book.sectionExtra')) + '</h2>' +
    '<label for="bk-specialRequirements">' + esc(t('book.special')) + '</label>' +
    '<textarea id="bk-specialRequirements" name="specialRequirements"></textarea>' +
    '<label for="bk-notes">' + esc(t('book.notes')) + '</label>' +
    '<textarea id="bk-notes" name="notes"></textarea>' +

    '<h2>' + esc(t('book.sectionPricing')) + '</h2>' +
    '<label for="bk-pricingMode">' + esc(t('book.pricingMode')) + '</label>' +
    '<select id="bk-pricingMode" name="pricingMode">' + modes + '</select>' +
    '<label for="bk-budgetEur">' + esc(t('book.budget')) + '</label>' +
    '<input id="bk-budgetEur" name="budgetEur" type="number" min="0" step="0.01" inputmode="decimal">' +
    '<label for="bk-payer">' + esc(t('book.payer')) + '</label>' +
    '<select id="bk-payer" name="payer">' + payers + '</select>' +
    '<label for="bk-paymentMethod">' + esc(t('book.paymentMethod')) + '</label>' +
    '<select id="bk-paymentMethod" name="paymentMethod">' + methods + '</select>' +
    '<p class="muted small">' + esc(t('book.pay.escrowNote')) + '</p>' +
    '<label for="bk-insuranceValueEur">' + esc(t('book.insurance')) + '</label>' +
    '<input id="bk-insuranceValueEur" name="insuranceValueEur" type="number" min="0" step="0.01" inputmode="decimal">' +

    '<h2>' + esc(t('book.sectionSupply')) + '</h2>' +
    '<p class="lead">' + esc(t('book.supply.lead')) + '</p>' +
    '<div class="choice-list" role="radiogroup" aria-label="' + esc(t('book.sectionSupply')) + '">' + choices + '</div>' +
    '<fieldset id="bk-carrierKindWrap" hidden>' +
    '<legend>' + esc(t('book.carrierKind')) + '</legend>' +
    '<label class="choice"><input type="radio" name="carrierKind" value="on" checked>' +
    '<span class="choice-title">' + esc(t('book.carrierKind.on')) + '</span></label>' +
    '<label class="choice"><input type="radio" name="carrierKind" value="off">' +
    '<span class="choice-title">' + esc(t('book.carrierKind.off')) + '</span></label>' +
    '<p class="muted small">' + esc(t('book.carrierKind.note')) + '</p>' +
    '</fieldset>' +

    '<button type="submit" class="primary" id="bk-submit">' + esc(t('book.submit')) + '</button>' +
    '<p id="bookMsg" class="alert" role="status" hidden></p>' +
    '</form>';

  const form = host.querySelector('#bookingForm');
  form.addEventListener('submit', onSubmitBooking);
  form.addEventListener('change', onBookingChange);
  const addStop = form.querySelector('#bk-addStop');
  if (addStop) addStop.addEventListener('click', () => addStopRow(form));
}

/** Show the "is your carrier on RoadwiseFleet?" question only for path ④. */
function onBookingChange(event) {
  const target = event.target;
  if (!target || target.name !== 'supplyChoice') return;
  const form = $('bookForm').querySelector('#bookingForm');
  const wrap = form.querySelector('#bk-carrierKindWrap');
  if (wrap) wrap.hidden = CORE.supplyChoiceInfo(target.value) ? !(target.value === 'own_carrier' || target.value === 'off_platform') : true;
}

function addStopRow(form) {
  const host = form.querySelector('#bk-stops');
  if (!host) return;
  const count = host.querySelectorAll('[data-stop]').length;
  if (count >= CORE.MAX_STOPS) return;
  const row = document.createElement('div');
  row.className = 'trip-row';
  row.setAttribute('data-stop', '');
  row.innerHTML =
    '<label>' + esc(t('book.stopAddress')) + '</label>' +
    '<input type="text" name="stopAddress" data-stop-address>' +
    '<label>' + esc(t('book.stopKind')) + '</label>' +
    '<select name="stopKind" data-stop-kind>' +
    '<option value="checkpoint">' + esc(t('book.kind.checkpoint')) + '</option>' +
    '<option value="pickup">' + esc(t('book.kind.pickup')) + '</option>' +
    '<option value="delivery">' + esc(t('book.kind.delivery')) + '</option>' +
    '</select>' +
    '<div class="actions"><button type="button" class="danger" data-remove-stop>' + esc(t('book.removeStop')) + '</button></div>';
  const remove = row.querySelector('[data-remove-stop]');
  if (remove) remove.addEventListener('click', () => row.parentNode.removeChild(row));
  host.appendChild(row);
}

/** Read the wizard form into the shape `CORE.normalizeBooking` expects. */
function readBooking(form) {
  const value = (name) => {
    const node = form.querySelector('[name="' + name + '"]');
    return node ? node.value : '';
  };
  const checked = form.querySelector('[name="supplyChoice"]:checked');
  let choice = checked ? checked.value : '';
  if (choice === 'own_carrier') {
    const kind = form.querySelector('[name="carrierKind"]:checked');
    if (kind && kind.value === 'off') choice = 'off_platform';
  }
  const stops = [];
  Array.prototype.forEach.call(form.querySelectorAll('[data-stop]'), (row) => {
    const address = row.querySelector('[data-stop-address]');
    const kindNode = row.querySelector('[data-stop-kind]');
    stops.push({ address: address ? address.value : '', kind: kindNode ? kindNode.value : 'checkpoint' });
  });
  return {
    origin: value('origin'),
    destination: value('destination'),
    stops,
    cargo: value('cargo'),
    weightKg: value('weightKg'),
    pallets: value('pallets'),
    equipment: value('equipment'),
    loadReadyAt: value('loadReadyAt'),
    deliverByAt: value('deliverByAt'),
    specialRequirements: value('specialRequirements'),
    notes: value('notes'),
    pricingMode: value('pricingMode'),
    budgetEur: value('budgetEur'),
    payer: value('payer'),
    paymentMethod: value('paymentMethod'),
    insuranceValueEur: value('insuranceValueEur'),
    supplyChoice: choice
  };
}

async function onSubmitBooking(event) {
  event.preventDefault();
  const form = event.target;
  clearFieldErrors(form);
  setMsg('bookMsg', '');
  const payload = readBooking(form);
  const check = CORE.normalizeBooking(payload);
  if (!check.ok) {
    const input = setFieldError(form, check.field, check.messageKey);
    setMsg('bookMsg', check.messageKey, 'error');
    if (input && input.focus) input.focus();
    return;
  }
  const submit = form.querySelector('#bk-submit');
  if (submit) {
    submit.disabled = true;
    submit.textContent = t('book.busy');
  }
  try {
    const data = await api('/customer/orders', { method: 'POST', body: payload });
    if (data.load && data.marketplace) {
      // Board task #78: the marketplace path posts the load and opens the
      // compare screen — the same order the wizard created, now collect offers.
      state.loadId = data.load.id;
      state.shipmentId = data.order ? data.order.id : null;
      setMsg('bookMsg', 'book.marketplacePosted', 'success');
      showPanel('offers');
      return;
    }
    if (!data.order) {
      setMsg('bookMsg', 'error.unexpected', 'error');
      return;
    }
    setMsg('bookMsg', 'book.created', 'success');
    state.shipmentId = data.order.id;
    state.trackLink = data.trackLink || null;
    renderShipment(data.order, state.trackLink);
    showPanel('shipment');
  } catch (err) {
    if (err.status === 400 && err.field) {
      const input = setFieldError(form, err.field, errorKey(err));
      if (input && input.focus) input.focus();
    }
    setMsg('bookMsg', errorKey(err), 'error');
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = t('book.submit');
    }
  }
}

/* ------------------------------------------------- offers (compare/award) --- */

function offerBadge(key) {
  return '<span class="badge">' + esc(t(key)) + '</span>';
}

/** One compare row: price, ETAs, rating, truck, verification and terms. */
function compareRow(row) {
  const flags = row.flags || {};
  const badges =
    (flags.cheapest ? offerBadge('offers.flag.cheapest') : '') +
    (flags.fastest ? offerBadge('offers.flag.fastest') : '') +
    (flags.verified ? offerBadge('offers.flag.verified') : '');
  const eta = (value) => (value ? new Date(value).toLocaleString() : t('offers.notGiven'));
  const rating = row.carrierRating === null || row.carrierRating === undefined ? t('offers.notRated') : String(row.carrierRating);
  const delta =
    row.deltaVsBudget === null || row.deltaVsBudget === undefined
      ? ''
      : '<span class="meta">' +
        esc(t(row.deltaVsBudget <= 0 ? 'offers.underBudget' : 'offers.overBudget', { amount: Math.abs(row.deltaVsBudget) })) +
        '</span>';
  const open = row.status === 'SENT' || row.status === 'VIEWED';
  const actions = open
    ? '<div class="actions">' +
      '<button type="button" class="primary" data-award="' + esc(row.id) + '">' + esc(t('offers.award')) + '</button>' +
      '<button type="button" class="secondary" data-counter="' + esc(row.id) + '">' + esc(t('offers.counter')) + '</button>' +
      '<button type="button" class="danger" data-decline="' + esc(row.id) + '">' + esc(t('offers.decline')) + '</button>' +
      '</div>'
    : '<span class="meta">' + esc(t(CORE.statusKey(row.status))) + '</span>';
  return (
    '<tr data-offer="' + esc(row.id) + '">' +
    '<td><strong>' + esc(row.carrierName || '') + '</strong>' + badges +
    '<div class="meta">' + esc(row.carrierTruck || t('offers.notGiven')) + '</div></td>' +
    '<td>' + esc(t('offers.price')) + ': ' + esc(row.priceEur === null ? '—' : row.priceEur) + delta + '</td>' +
    '<td>' + esc(t('offers.pickup')) + ': ' + esc(eta(row.pickupEtaAt)) + '</td>' +
    '<td>' + esc(t('offers.delivery')) + ': ' + esc(eta(row.deliveryEtaAt)) + '</td>' +
    '<td>' + esc(t('offers.rating')) + ': ' + esc(rating) + '</td>' +
    '<td>' + esc(t('offers.verification')) + ': ' + esc(t(row.carrierVerified ? 'offers.verifiedYes' : 'offers.verifiedNo')) + '</td>' +
    '<td>' + esc(t('offers.terms')) + ': ' + esc(t('offers.terms.' + (row.cancellationTerms || 'standard'))) + '</td>' +
    '<td>' + actions + '</td>' +
    '</tr>'
  );
}

/**
 * The compare screen. With a load id it shows that load's offers; without one
 * it lists the customer's own posted loads and lets one be opened. Every fact
 * comes from `GET /api/customer/loads(/:id)`, so a refresh restores the screen.
 */
async function renderOffers() {
  const wrap = $('offersBody');
  if (!wrap) return;
  wrap.innerHTML = '<p class="muted">' + esc(t('common.loading')) + '</p>';
  try {
    if (!state.loadId) {
      const data = await api('/customer/loads');
      const loads = Array.isArray(data.loads) ? data.loads : [];
      state.offerLoad = null;
      state.compare = [];
      wrap.innerHTML =
        '<h2>' + esc(t('offers.myLoads')) + '</h2>' +
        (loads.length === 0
          ? '<p class="muted">' + esc(t('offers.noLoads')) + '</p>'
          : loads
              .map(
                (load) =>
                  '<article class="trip-row">' +
                  '<span class="route">' + esc(load.origin) + ' → ' + esc(load.destination) + '</span>' +
                  '<span>' + esc(t(CORE.statusKey(load.status))) + '</span>' +
                  '<span class="meta">' + esc(t('offers.offerCount', { count: load.offerCount || 0 })) + '</span>' +
                  '<div class="actions"><button type="button" class="secondary" data-open-load="' + esc(load.id) + '">' +
                  esc(t('offers.open')) + '</button></div>' +
                  '</article>'
              )
              .join(''));
      return;
    }
    const data = await api('/customer/loads/' + encodeURIComponent(state.loadId));
    state.offerLoad = data.load || null;
    state.compare = Array.isArray(data.compare) ? data.compare : [];
    state.autoMatch = data.autoMatch || null;
    const load = state.offerLoad || {};
    const rows = state.compare.length
      ? '<table class="compare"><caption>' + esc(t('offers.compareCaption')) + '</caption>' +
        '<thead><tr>' +
        ['offers.col.carrier', 'offers.col.price', 'offers.col.pickup', 'offers.col.delivery', 'offers.col.rating', 'offers.col.verification', 'offers.col.terms', 'offers.col.actions']
          .map((key) => '<th scope="col">' + esc(t(key)) + '</th>')
          .join('') +
        '</tr></thead><tbody>' + state.compare.map(compareRow).join('') + '</tbody></table>'
      : '<p class="muted">' + esc(t('offers.empty')) + '</p>';
    wrap.innerHTML =
      '<button type="button" class="link" id="offersBack">' + esc(t('offers.back')) + '</button>' +
      '<h1>' + esc(load.origin || '') + ' → ' + esc(load.destination || '') + '</h1>' +
      '<p>' + esc(t(CORE.statusKey(load.status))) + ' · ' + esc(t('offers.offerCount', { count: state.compare.length })) + '</p>' +
      rows +
      '<p id="offersMsg" class="alert" role="status" hidden></p>';
    const back = wrap.querySelector('#offersBack');
    if (back) back.addEventListener('click', () => { state.loadId = null; renderOffers(); });
  } catch (err) {
    setMsg('globalMsg', errorKey(err), 'error');
    wrap.innerHTML = '';
  }
}

function onOffersClick(event) {
  const target = event.target;
  if (!target || !target.getAttribute) return;
  const openLoad = target.getAttribute('data-open-load');
  if (openLoad) { state.loadId = openLoad; renderOffers(); return; }
  const award = target.getAttribute('data-award');
  if (award) { awardOffer(award); return; }
  const decline = target.getAttribute('data-decline');
  if (decline) { declineOffer(decline); return; }
  const counter = target.getAttribute('data-counter');
  if (counter) { toggleCounterForm(counter); }
}

function toggleCounterForm(offerId) {
  const wrap = $('offersBody');
  if (!wrap) return;
  const row = wrap.querySelector('[data-offer="' + offerId + '"]');
  if (!row) return;
  const next = row.nextElementSibling;
  if (next && next.getAttribute('data-counter-form') === offerId) {
    row.parentNode.removeChild(next);
    return;
  }
  const form = document.createElement('tr');
  form.setAttribute('data-counter-form', offerId);
  form.innerHTML =
    '<td colspan="8"><form class="counter-form" novalidate>' +
    '<label for="ct-' + esc(offerId) + '-price">' + esc(t('offers.counterPrice')) + '</label>' +
    '<input id="ct-' + esc(offerId) + '-price" name="priceEur" type="number" min="0" step="0.01" inputmode="decimal">' +
    '<label for="ct-' + esc(offerId) + '-terms">' + esc(t('offers.terms')) + '</label>' +
    '<select id="ct-' + esc(offerId) + '-terms" name="cancellationTerms">' +
    ['standard', 'flexible', 'strict']
      .map((id) => '<option value="' + esc(id) + '">' + esc(t('offers.terms.' + id)) + '</option>')
      .join('') +
    '</select>' +
    '<label for="ct-' + esc(offerId) + '-note">' + esc(t('offers.counterNote')) + '</label>' +
    '<input id="ct-' + esc(offerId) + '-note" name="note" type="text">' +
    '<button type="submit" class="primary">' + esc(t('offers.counterSend')) + '</button>' +
    '</form></td>';
  const inner = form.querySelector('form');
  inner.addEventListener('submit', (event) => {
    event.preventDefault();
    sendCounter(offerId, inner);
  });
  row.parentNode.insertBefore(form, row.nextSibling);
}

async function sendCounter(offerId, form) {
  const value = (name) => {
    const node = form.querySelector('[name="' + name + '"]');
    return node ? node.value : '';
  };
  const payload = { priceEur: value('priceEur'), cancellationTerms: value('cancellationTerms'), note: value('note') };
  try {
    await api('/customer/offers/' + encodeURIComponent(offerId) + '/counter', { method: 'POST', body: payload });
    // Re-render FIRST, then show the message: renderOffers() replaces the
    // offers body (and its #offersMsg node), so a message set before it is lost.
    await renderOffers();
    setMsg('offersMsg', 'offers.countered', 'success');
  } catch (err) {
    setMsg('offersMsg', errorKey(err), 'error');
  }
}

async function declineOffer(offerId) {
  try {
    await api('/customer/offers/' + encodeURIComponent(offerId) + '/decline', { method: 'POST', body: {} });
    await renderOffers();
    setMsg('offersMsg', 'offers.declined', 'success');
  } catch (err) {
    setMsg('offersMsg', errorKey(err), 'error');
  }
}

async function awardOffer(offerId) {
  if (!state.loadId) return;
  try {
    const data = await api('/customer/loads/' + encodeURIComponent(state.loadId) + '/award', {
      method: 'POST',
      body: { offerId, paymentMethod: 'invoice' }
    });
    const count = Array.isArray(data.notifications) ? data.notifications.length : 0;
    state.shipmentId = data.trip ? data.trip.id : null;
    await renderOffers();
    setMsg('offersMsg', count > 0 ? 'offers.awarded' : 'offers.awardedNoNotice', 'success');
  } catch (err) {
    setMsg('offersMsg', errorKey(err), 'error');
  }
}

/* ------------------------------------------------------------ auto-match --- */

function renderAutoMatch() {
  const wrap = $('autoMatchBody');
  if (!wrap) return;
  wrap.innerHTML = '<p class="muted">' + esc(t('common.loading')) + '</p>';
  api('/customer/auto-match')
    .then((data) => {
      state.autoMatch = data || null;
      const rules = (data && data.rules) || CORE.autoMatchDefaults();
      const gate = (data && data.entitlement) || {};
      const gateNote = gate.allowed
        ? ''
        : '<p class="alert" role="status">' + esc(t('autoMatch.gate', { gate: gate.ownerGate || '' })) + '</p>';
      wrap.innerHTML =
        '<h1>' + esc(t('autoMatch.title')) + '</h1>' +
        '<p class="lead">' + esc(t('autoMatch.lead')) + '</p>' +
        gateNote +
        '<form id="autoMatchForm" novalidate>' +
        '<label class="choice"><input type="checkbox" name="enabled"' + (rules.enabled ? ' checked' : '') + '>' +
        '<span class="choice-title">' + esc(t('autoMatch.enabled')) + '</span></label>' +
        '<label for="am-maxPriceEur">' + esc(t('autoMatch.maxPrice')) + '</label>' +
        '<input id="am-maxPriceEur" name="maxPriceEur" type="number" min="0" step="0.01" inputmode="decimal" value="' +
        esc(rules.maxPriceEur === null || rules.maxPriceEur === undefined ? '' : rules.maxPriceEur) + '">' +
        '<label for="am-minRating">' + esc(t('autoMatch.minRating')) + '</label>' +
        '<input id="am-minRating" name="minRating" type="number" min="0" max="5" step="0.1" inputmode="decimal" value="' +
        esc(rules.minRating === null || rules.minRating === undefined ? '' : rules.minRating) + '">' +
        '<button type="submit" class="primary">' + esc(t('autoMatch.save')) + '</button>' +
        '<p id="autoMatchMsg" class="alert" role="status" hidden></p>' +
        '</form>';
      const form = wrap.querySelector('#autoMatchForm');
      form.addEventListener('submit', onSubmitAutoMatch);
    })
    .catch((err) => {
      setMsg('globalMsg', errorKey(err), 'error');
      wrap.innerHTML = '';
    });
}

async function onSubmitAutoMatch(event) {
  event.preventDefault();
  const form = event.target;
  const value = (name) => {
    const node = form.querySelector('[name="' + name + '"]');
    return node ? node.value : '';
  };
  const enabledNode = form.querySelector('[name="enabled"]');
  const payload = {
    enabled: Boolean(enabledNode && enabledNode.checked),
    maxPriceEur: value('maxPriceEur'),
    minRating: value('minRating')
  };
  try {
    await api('/customer/auto-match', { method: 'PUT', body: payload });
    setMsg('autoMatchMsg', 'autoMatch.saved', 'success');
    renderAutoMatch();
  } catch (err) {
    if (err.error === 'auto_match_pending_owner') setMsg('autoMatchMsg', 'autoMatch.gate', 'error');
    else setMsg('autoMatchMsg', errorKey(err), 'error');
  }
}

/* ------------------------------------------------------------- account --- */

function addressRows(addresses) {
  if (!addresses || addresses.length === 0) return '<p class="muted">' + esc(t('account.addressesEmpty')) + '</p>';
  return addresses
    .map(
      (a) =>
        '<article class="trip-row"><span class="route">' + esc(a.label) + '</span>' +
        '<span class="meta">' + esc([a.line1, a.city, a.postalCode, a.country].filter(Boolean).join(', ')) + '</span>' +
        '<div class="actions"><button type="button" class="danger" data-remove-address="' + esc(a.id) + '">' +
        esc(t('account.address.remove')) + '</button></div></article>'
    )
    .join('');
}

function teamRows(team) {
  if (!team || team.length === 0) return '<p class="muted">' + esc(t('account.teamEmpty')) + '</p>';
  return team
    .map((m) => '<article class="trip-row"><span class="route">' + esc(m.name) + '</span><span class="meta">' + esc(m.email || '') + '</span></article>')
    .join('');
}

async function renderAccount() {
  const host = $('accountBody');
  if (!host) return;
  host.innerHTML = '<p class="muted">' + esc(t('common.loading')) + '</p>';
  let data;
  try {
    data = await api('/customer/me');
  } catch (err) {
    setMsg('globalMsg', errorKey(err), 'error');
    host.innerHTML = '';
    return;
  }
  setMsg('globalMsg', '');
  const me = data || {};
  state.me = me;
  const profile = me.customer || {};
  const prefs = CORE.normalizeNotifyPrefs(profile.notifyPrefs);
  const channels = CORE.NOTIFY_CHANNELS.map(
    (channel) =>
      '<label class="choice"><input type="checkbox" name="notify-' + esc(channel) + '"' +
      (prefs[channel] ? ' checked' : '') + '><span class="choice-title">' + esc(t('account.notify.' + channel)) + '</span></label>'
  ).join('');

  host.innerHTML =
    '<h2>' + esc(t('account.profile')) + '</h2>' +
    '<form id="profileForm" novalidate>' +
    '<label for="ac-name">' + esc(t('account.name')) + '</label>' +
    '<input id="ac-name" name="name" type="text" value="' + esc(state.user && state.user.name ? state.user.name : '') + '">' +
    '<label for="ac-company">' + esc(t('account.company')) + '</label>' +
    '<input id="ac-company" name="company" type="text" value="' + esc(profile.name || '') + '">' +
    '<label for="ac-vatId">' + esc(t('account.vat')) + '</label>' +
    '<input id="ac-vatId" name="vatId" type="text" value="' + esc(profile.vatId || '') + '">' +
    '<label for="ac-address">' + esc(t('account.address')) + '</label>' +
    '<input id="ac-address" name="address" type="text" value="' + esc(profile.address || '') + '">' +
    '<h2>' + esc(t('account.prefs')) + '</h2>' +
    '<p class="muted small">' + esc(t('account.prefsLead')) + '</p>' +
    '<div class="choice-list">' + channels + '</div>' +
    '<button type="submit" class="primary" id="ac-save">' + esc(t('account.save')) + '</button>' +
    '<p id="profileMsg" class="alert" role="status" hidden></p>' +
    '</form>' +

    '<h2>' + esc(t('account.verification')) + '</h2>' +
    '<p class="muted">' + esc(t('account.unverified')) + '</p>' +

    '<h2>' + esc(t('account.addresses')) + '</h2>' +
    '<p class="muted small">' + esc(t('account.addressesLead')) + '</p>' +
    '<div id="addressList">' + addressRows(me.addresses) + '</div>' +
    '<form id="addressForm" novalidate>' +
    '<label for="ad-label">' + esc(t('account.address.label')) + '</label>' +
    '<input id="ad-label" name="label" type="text">' +
    '<label for="ad-line1">' + esc(t('account.address.line1')) + '</label>' +
    '<input id="ad-line1" name="line1" type="text">' +
    '<label for="ad-city">' + esc(t('account.address.city')) + '</label>' +
    '<input id="ad-city" name="city" type="text">' +
    '<label for="ad-postalCode">' + esc(t('account.address.postal')) + '</label>' +
    '<input id="ad-postalCode" name="postalCode" type="text">' +
    '<label for="ad-country">' + esc(t('account.address.country')) + '</label>' +
    '<input id="ad-country" name="country" type="text">' +
    '<button type="submit" class="secondary" id="ad-add">' + esc(t('account.address.add')) + '</button>' +
    '</form>' +

    '<h2>' + esc(t('account.team')) + '</h2>' +
    '<p class="muted small">' + esc(t('account.teamLead')) + '</p>' +
    '<div id="teamList">' + teamRows(me.team) + '</div>' +
    '<form id="teamForm" novalidate>' +
    '<label for="tm-name">' + esc(t('account.team.name')) + '</label>' +
    '<input id="tm-name" name="name" type="text">' +
    '<label for="tm-email">' + esc(t('account.team.email')) + '</label>' +
    '<input id="tm-email" name="email" type="email">' +
    '<label for="tm-password">' + esc(t('account.team.password')) + '</label>' +
    '<input id="tm-password" name="password" type="password" autocomplete="new-password">' +
    '<button type="submit" class="secondary" id="tm-invite">' + esc(t('account.team.invite')) + '</button>' +
    '<p id="teamMsg" class="alert" role="status" hidden></p>' +
    '</form>';

  const profileForm = host.querySelector('#profileForm');
  profileForm.addEventListener('submit', onSubmitProfile);

  const addressForm = host.querySelector('#addressForm');
  addressForm.addEventListener('submit', onSubmitAddress);
  host.addEventListener('click', onAccountClick);
}

function onAccountClick(event) {
  const target = event.target;
  if (!target || !target.getAttribute) return;
  const id = target.getAttribute('data-remove-address');
  if (id) removeAddress(id);
}

async function onSubmitProfile(event) {
  event.preventDefault();
  const form = event.target;
  clearFieldErrors(form);
  const value = (name) => {
    const node = form.querySelector('[name="' + name + '"]');
    return node ? node.value : '';
  };
  const notifyPrefs = {};
  CORE.NOTIFY_CHANNELS.forEach((channel) => {
    const node = form.querySelector('[name="notify-' + channel + '"]');
    notifyPrefs[channel] = Boolean(node && node.checked);
  });
  const payload = {
    name: value('name'),
    company: value('company'),
    vatId: value('vatId'),
    address: value('address'),
    notifyPrefs
  };
  const check = CORE.normalizeProfile(payload);
  if (!check.ok) {
    const input = setFieldError(form, check.field, check.messageKey);
    if (input && input.focus) input.focus();
    return;
  }
  try {
    await api('/customer/me', { method: 'PATCH', body: payload });
    if (state.user) {
      state.user.name = payload.name;
      writeSession(state.token, state.user);
    }
    setMsg('profileMsg', 'account.saved', 'success');
  } catch (err) {
    setMsg('profileMsg', errorKey(err), 'error');
  }
}

async function onSubmitAddress(event) {
  event.preventDefault();
  const form = event.target;
  clearFieldErrors(form);
  const value = (name) => {
    const node = form.querySelector('[name="' + name + '"]');
    return node ? node.value : '';
  };
  const payload = {
    label: value('label'),
    line1: value('line1'),
    city: value('city'),
    postalCode: value('postalCode'),
    country: value('country')
  };
  const check = CORE.normalizeAddress(payload);
  if (!check.ok) {
    const input = setFieldError(form, check.field, check.messageKey);
    if (input && input.focus) input.focus();
    return;
  }
  try {
    await api('/customer/addresses', { method: 'POST', body: payload });
    renderAccount();
  } catch (err) {
    setMsg('globalMsg', errorKey(err), 'error');
  }
}

async function removeAddress(id) {
  try {
    await api('/customer/addresses/' + encodeURIComponent(id), { method: 'DELETE' });
    renderAccount();
  } catch (err) {
    setMsg('globalMsg', errorKey(err), 'error');
  }
}

async function onSubmitTeam(event) {
  event.preventDefault();
  const form = event.target;
  clearFieldErrors(form);
  const value = (name) => {
    const node = form.querySelector('[name="' + name + '"]');
    return node ? node.value : '';
  };
  const payload = { name: value('name'), email: value('email'), password: value('password') };
  const check = CORE.validateSignup(payload);
  if (!check.ok) {
    const input = setFieldError(form, check.field, check.messageKey);
    if (input && input.focus) input.focus();
    return;
  }
  try {
    await api('/customer/team', { method: 'POST', body: payload });
    setMsg('teamMsg', 'account.teamInvited', 'success');
    form.reset();
  } catch (err) {
    setMsg('teamMsg', errorKey(err), 'error');
  }
}

/* ------------------------------------------------------------ reviews --- */

/* Two-sided review prompt (board task #98). A prompt appears only when the
 * server sampled this delivery; the customer rates the carrier here, and the
 * carrier rates the customer on its own surface. The rating is immutable once
 * submitted, so the panel never offers an edit. */

function closestAttr(node, attr) {
  let current = node;
  while (current && current.getAttribute) {
    if (current.getAttribute(attr)) return current;
    current = current.parentNode;
  }
  return null;
}

function reviewPromptHtml(prompt) {
  const id = esc(prompt.id);
  let stars = '';
  for (let n = 1; n <= 5; n += 1) {
    stars +=
      '<button type="button" class="star" data-rate="' + n + '" aria-label="' +
      esc(t('reviews.rate', { n })) + '">' + n + '</button>';
  }
  return (
    '<article class="card review-prompt" data-prompt="' + id + '">' +
    '<h2>' + esc(t('reviews.promptTitle')) + '</h2>' +
    (prompt.actionRef ? '<p class="muted">' + esc(prompt.actionRef) + '</p>' : '') +
    '<p class="muted small">' +
    esc(t('reviews.about', { name: prompt.counterpartyName || '' })) +
    '</p>' +
    '<div class="stars" role="group" aria-label="' + esc(t('reviews.ratingLabel')) + '">' + stars + '</div>' +
    '<label for="rev-comment-' + id + '">' + esc(t('reviews.comment')) + '</label>' +
    '<textarea id="rev-comment-' + id + '" rows="2"></textarea>' +
    '<button type="button" class="primary" data-submit-review="' + id + '">' +
    esc(t('reviews.submit')) +
    '</button>' +
    '<p class="alert review-msg" role="status" hidden></p>' +
    '</article>'
  );
}

function setReviewMsg(article, messageKey, kind) {
  const node = article.querySelector('.review-msg');
  if (!node) return;
  node.textContent = t(messageKey);
  node.className = 'alert review-msg' + (kind ? ' ' + kind : '');
  node.hidden = false;
}

async function renderReviews() {
  const host = $('reviewsBody');
  if (!host) return;
  host.innerHTML = '<p class="muted">' + esc(t('common.loading')) + '</p>';
  let data;
  try {
    data = await api('/reviews/prompts');
  } catch (err) {
    setMsg('globalMsg', errorKey(err), 'error');
    host.innerHTML = '';
    return;
  }
  setMsg('globalMsg', '');
  const prompts = data.prompts || [];
  if (!prompts.length) {
    host.innerHTML = '<p class="muted">' + esc(t('reviews.empty')) + '</p>';
    return;
  }
  host.innerHTML = prompts.map(reviewPromptHtml).join('');
  host.addEventListener('click', onReviewsClick);
}

function onReviewsClick(event) {
  const target = event.target;
  if (!target || !target.getAttribute) return;
  const article = closestAttr(target, 'data-prompt');
  if (!article) return;
  const rate = target.getAttribute('data-rate');
  if (rate) {
    article.setAttribute('data-rating', rate);
    Array.prototype.forEach.call(article.querySelectorAll('[data-rate]'), (button) => {
      const value = Number(button.getAttribute('data-rate'));
      button.classList.toggle('is-selected', value <= Number(rate));
    });
    return;
  }
  if (target.getAttribute('data-submit-review')) submitReviewPrompt(article);
}

async function submitReviewPrompt(article) {
  const promptId = article.getAttribute('data-prompt');
  const rating = Number(article.getAttribute('data-rating') || 0);
  const commentNode = article.querySelector('textarea');
  if (!rating) {
    setReviewMsg(article, 'reviews.needRating', 'error');
    return;
  }
  const button = article.querySelector('[data-submit-review]');
  if (button) button.disabled = true;
  try {
    await api('/reviews', {
      method: 'POST',
      body: { promptId, rating, comment: commentNode ? commentNode.value : '' }
    });
    renderReviews();
  } catch (err) {
    setReviewMsg(article, errorKey(err), 'error');
    if (button) button.disabled = false;
  }
}

/* ------------------------------------------------------------ auth/setup --- */

async function onSubmitLogin(event) {
  event.preventDefault();
  setMsg('authMsg', '');
  const emailNode = $('loginEmail');
  const passwordNode = $('loginPassword');
  const email = emailNode ? emailNode.value : '';
  const password = passwordNode ? passwordNode.value : '';
  const button = $('loginSubmit');
  if (button) button.disabled = true;
  try {
    const data = await api('/auth/login', { method: 'POST', body: { email, password } });
    if (!data.user || data.user.roleId !== CORE.CUSTOMER_ROLE) {
      setMsg('authMsg', 'error.forbidden', 'error');
      return;
    }
    state.token = data.token;
    state.user = data.user;
    writeSession(data.token, data.user);
    if (!(await loadMe())) {
      showView('auth');
      setMsg('authMsg', 'error.forbidden', 'error');
      return;
    }
    showView('app');
    showPanel('shipments');
  } catch (err) {
    setMsg('authMsg', errorKey(err), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function onSubmitSignup(event) {
  event.preventDefault();
  const form = event.target;
  clearFieldErrors(form);
  setMsg('signupMsg', '');
  const value = (name) => {
    const node = form.querySelector('[name="' + name + '"]');
    return node ? node.value : '';
  };
  const payload = {
    name: value('name'),
    company: value('company'),
    email: value('email'),
    phone: value('phone'),
    password: value('password')
  };
  const check = CORE.validateSignup(payload);
  if (!check.ok) {
    const input = setFieldError(form, check.field, check.messageKey);
    setMsg('signupMsg', check.messageKey, 'error');
    if (input && input.focus) input.focus();
    return;
  }
  const button = $('signupSubmit');
  if (button) button.disabled = true;
  try {
    const data = await api('/customer/signup', { method: 'POST', body: payload });
    state.token = data.token;
    state.user = data.user;
    writeSession(data.token, data.user);
    if (!(await loadMe())) {
      showView('auth');
      return;
    }
    showView('app');
    showPanel('book');
  } catch (err) {
    setMsg('signupMsg', errorKey(err), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function signOut() {
  clearSession();
  state.me = null;
  state.shipmentId = null;
  showView('auth');
}

function wireEvents() {
  const loginForm = $('loginForm');
  if (loginForm) loginForm.addEventListener('submit', onSubmitLogin);
  const signupForm = $('signupForm');
  if (signupForm) signupForm.addEventListener('submit', onSubmitSignup);
  const showSignup = $('showSignup');
  if (showSignup) showSignup.addEventListener('click', () => { setMsg('authMsg', ''); showView('signup'); });
  const showLogin = $('showLogin');
  if (showLogin) showLogin.addEventListener('click', () => { setMsg('signupMsg', ''); showView('auth'); });
  const signOutButton = $('signOut');
  if (signOutButton) signOutButton.addEventListener('click', signOut);
  const nav = $('customerNav');
  if (nav) {
    nav.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.getAttribute) return;
      const next = target.getAttribute('data-nav');
      if (next) showPanel(next);
    });
  }
  const newBooking = $('newBooking');
  if (newBooking) newBooking.addEventListener('click', () => showPanel('book'));
  const back = $('backToShipments');
  if (back) back.addEventListener('click', () => showPanel('shipments'));
  const list = $('shipmentsList');
  if (list) {
    list.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.getAttribute) return;
      const id = target.getAttribute('data-open');
      if (id) openShipment(id);
    });
  }
  const accountBody = $('accountBody');
  if (accountBody) {
    accountBody.addEventListener('submit', (event) => {
      if (event.target && event.target.id === 'teamForm') onSubmitTeam(event);
    });
  }
  const offersBody = $('offersBody');
  if (offersBody) offersBody.addEventListener('click', onOffersClick);
}

async function loadCatalogue() {
  try {
    const res = await fetch('/c/locales/en.json');
    state.catalogue = res.ok ? await res.json() : {};
  } catch (err) {
    state.catalogue = {};
  }
}

async function boot() {
  await loadCatalogue();
  applyStaticCopy();
  wireEvents();
  const stored = readSession();
  if (stored.token) {
    state.token = stored.token;
    state.user = stored.user;
    if (await loadMe()) {
      showView('app');
      showPanel('shipments');
      return;
    }
  }
  showView('auth');
}

if (typeof document !== 'undefined') {
  boot();
}

export {
  boot,
  showView,
  showPanel,
  readBooking,
  onSubmitBooking,
  renderOffers,
  onOffersClick,
  awardOffer,
  compareRow,
  renderAutoMatch,
  onSubmitAutoMatch,
  renderReviews,
  onReviewsClick,
  errorKey,
  t,
  state
};
