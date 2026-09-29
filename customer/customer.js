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
  account: 'accountPanel'
};

const state = {
  view: 'shipments',
  catalogue: {},
  token: '',
  user: null,
  shipmentId: null,
  me: null,
  trackLink: null
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
  const byStatus = {
    0: 'error.network',
    400: 'error.badRequest',
    401: 'error.sessionExpired',
    403: 'error.forbidden',
    404: 'error.notFound',
    409: 'error.emailTaken',
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
    if (!data.order) {
      showMarketplaceNotice(form, data.marketplace);
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

/** A marketplace path: explain the phase, never a dead end. */
function showMarketplaceNotice(form, notice) {
  const box = form.querySelector('#bookMsg');
  if (!box) return;
  box.className = 'alert';
  box.hidden = false;
  box.textContent = t('book.marketplacePending') + (notice && notice.task ? ' (' + notice.task + ')' : '');
  if (box.querySelector('#bk-fallback')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'bk-fallback';
  button.className = 'secondary';
  button.textContent = t('book.marketplaceFallback');
  button.addEventListener('click', () => {
    const own = form.querySelector('[name="supplyChoice"][value="own_carrier"]');
    if (own) {
      own.checked = true;
      onBookingChange({ target: own });
      if (own.focus) own.focus();
    }
    setMsg('bookMsg', '');
  });
  box.appendChild(document.createElement('br'));
  box.appendChild(button);
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

export { boot, showView, showPanel, readBooking, onSubmitBooking, errorKey, t, state };
