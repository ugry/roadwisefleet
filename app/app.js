/**
 * RoadwiseFleet Fleet Manager — application shell (board task #32, FAv1-F1).
 *
 * Owner of the DOM and the session. `app-core.js` holds the pure decisions
 * (routes, roles, guard, renderers); this file only applies them:
 *
 *   boot      -> i18n, session restore, first guard decision
 *   login     -> POST /api/auth/login, remember the token, land on the role home
 *   session   -> GET /api/auth/me on every cold load (the server is authoritative
 *                about the role; a hand-edited role in storage cannot widen it)
 *   guard     -> every /app/* path is decided by `app-core.guardDecision`
 *   logout    -> drop the token, replace the URL with /app/login, re-check on
 *                popstate/pageshow so a back-button or bfcache restore is refused
 *
 * The session lives in `sessionStorage`, not a cookie: the API authenticates
 * with a bearer token, the token must not survive the tab, and the app must not
 * become CSRF-able. Nothing here touches cookies at all, on purpose.
 *
 * Browser-only: the pure half is what the Node tests cover.
 */
(function (root, factory) {
  var api = factory(root, root.RoadwiseAppCore, root.RoadwiseI18nUI, root.RoadwiseTrips);
  root.RoadwiseApp = api;
})(typeof window !== 'undefined' ? window : globalThis, function (win, core, i18nUI, TRIPS) {
  'use strict';

  var APP = core || {};
  // The pure create-trip form logic (board task #35, F4), loaded as a classic
  // script before this one. Everything missing here is a no-op, never a crash.
  var DISPATCH = win && win.RoadwiseDispatch ? win.RoadwiseDispatch : {};
  // The pure trips list/detail shaping (board task #34, F3), loaded before this one.
  var TRIPVIEW = TRIPS || {};
  // The pure dashboard shaping (board task #33, F2), loaded before this one.
  var DASH = win && win.RoadwiseDashboard ? win.RoadwiseDashboard : {};
  // The pure assign/reassign shaping (board task #36, F5), loaded before this one.
  var ASSIGN = win && win.RoadwiseAssign ? win.RoadwiseAssign : {};
  // The pure documents view model (board task #37, F6), loaded before this one.
  var DOC = win && win.RoadwiseDocuments ? win.RoadwiseDocuments : {};
  // The pure tracking-link view model (board task #39, F8), loaded before this one.
  var TRACK = win && win.RoadwiseTracking ? win.RoadwiseTracking : {};
  // The shared document rules / checklist owner (board task #4), loaded before
  // this one from `/pilot/lib/driver-core.js`. The documents UI never restates
  // the POD gate — it asks this module.
  var DRCORE = win && win.RoadwiseDriverCore ? win.RoadwiseDriverCore : {};
  var T = function (key, params) { return key; };
  var i18n = null;
  var session = { token: '', user: null };
  /** The route the person asked for before being sent to login (if any). */
  var pendingPath = null;
  /** Incremented on every panel render; a stale async response is discarded. */
  var renderToken = 0;
  /** The rows the current list shows — the CSV exports exactly these. */
  var shownTrips = [];

  /* ------------------------------------------------------------ helpers --- */

  function el(id) {
    return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
  }

  function setText(id, value) {
    var node = el(id);
    if (node) node.textContent = value === null || value === undefined ? '' : String(value);
  }

  function setHidden(id, hidden) {
    var node = el(id);
    if (!node) return;
    node.hidden = Boolean(hidden);
    if (node.classList) {
      if (hidden) node.classList.add('hidden');
      else node.classList.remove('hidden');
    }
  }

  function show(alertId, message) {
    var node = el(alertId);
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    if (node.classList) node.classList.remove('hidden');
  }

  function hide(alertId) {
    var node = el(alertId);
    if (!node) return;
    node.textContent = '';
    node.hidden = true;
    if (node.classList) node.classList.add('hidden');
  }

  function storage() {
    try {
      if (typeof sessionStorage === 'undefined' || sessionStorage === null) return null;
      sessionStorage.getItem(APP.TOKEN_KEY);
      return sessionStorage;
    } catch (err) {
      return null;
    }
  }

  function readSession() {
    var store = storage();
    if (!store) return { token: '', user: null };
    var token = store.getItem(APP.TOKEN_KEY) || '';
    var user = null;
    try {
      user = JSON.parse(store.getItem(APP.USER_KEY) || 'null');
    } catch (err) {
      user = null;
    }
    return { token: token, user: user };
  }

  function writeSession(token, user) {
    var store = storage();
    if (!store) return;
    store.setItem(APP.TOKEN_KEY, token);
    store.setItem(APP.USER_KEY, JSON.stringify(user || null));
  }

  function clearSession() {
    var store = storage();
    if (!store) return;
    store.removeItem(APP.TOKEN_KEY);
    store.removeItem(APP.USER_KEY);
  }

  /** Push or replace the URL without leaving the page (SPA routing). */
  function setPath(path, replace) {
    if (typeof history === 'undefined' || !history) return;
    try {
      if (replace && history.replaceState) history.replaceState(null, '', path);
      else if (!replace && history.pushState) history.pushState(null, '', path);
    } catch (err) {
      /* file:// or a locked-down WebView: routing still works, the URL just does not change */
    }
  }

  function currentPath() {
    return typeof location !== 'undefined' && location.pathname ? location.pathname : APP.HOME_PATH;
  }

  function request(path, options) {
    var opts = options || {};
    var headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }).then(function (res) {
      return res.json().then(function (data) { return { status: res.status, ok: res.ok, data: data }; })
        .catch(function () { return { status: res.status, ok: res.ok, data: null }; });
    }).catch(function () {
      return { status: 0, ok: false, data: { error: 'network' }, offline: true };
    });
  }

  /* ------------------------------------------------------------- render --- */

  function renderNav(role, route) {
    var slot = el('navSlot');
    if (!slot) return 0;
    slot.innerHTML = APP.navHtml(role, T, route && route.path ? route.path : currentPath());
    var links = slot.querySelectorAll ? slot.querySelectorAll('a[data-nav]') : [];
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', onNavClick);
    }
    return links.length;
  }

  function onNavClick(ev) {
    var anchor = ev && ev.currentTarget ? ev.currentTarget : (ev && ev.target);
    if (!anchor || typeof anchor.getAttribute !== 'function') return;
    var href = anchor.getAttribute('href') || '';
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    route({ path: href, push: true });
  }

  function renderPanel(route) {
    var outlet = el('outlet');
    if (!outlet) return null;
    var panel = APP.panelFor(route, T);
    var token = ++renderToken;
    if (route && route.view === 'trips') {
      outlet.innerHTML = '';
      renderTripsList(outlet, token);
      if (typeof document !== 'undefined') document.title = panel.title + ' — ' + T('brand.name');
      if (outlet.focus) outlet.focus();
      return panel;
    }
    if (route && route.view === 'trip-detail') {
      outlet.innerHTML = '';
      renderTripDetail(outlet, route, token);
      if (typeof document !== 'undefined') document.title = panel.title + ' — ' + T('brand.name');
      if (outlet.focus) outlet.focus();
      return panel;
    }
    if (route && route.view === 'dispatch') {
      renderDispatch(outlet);
      if (typeof document !== 'undefined') document.title = panel.title + ' — ' + T('brand.name');
      if (outlet.focus) outlet.focus();
      return panel;
    }
    if (route && route.view === 'dashboard') {
      outlet.innerHTML = '';
      renderDashboard(outlet, token);
      if (typeof document !== 'undefined') document.title = panel.title + ' — ' + T('brand.name');
      if (outlet.focus) outlet.focus();
      return panel;
    }
    if (route && route.view === 'documents') {
      outlet.innerHTML = '';
      renderDocuments(outlet, token);
      if (typeof document !== 'undefined') document.title = panel.title + ' — ' + T('brand.name');
      if (outlet.focus) outlet.focus();
      return panel;
    }
    if (route && route.view === 'tracking') {
      outlet.innerHTML = '';
      renderTracking(outlet, token);
      if (typeof document !== 'undefined') document.title = panel.title + ' — ' + T('brand.name');
      if (outlet.focus) outlet.focus();
      return panel;
    }
    var html = '<h1>' + APP.escapeHtml(panel.title) + '</h1>';
    if (route && route.id === 'overview') {
      html += '<div class="panel"><p class="lead">' + APP.escapeHtml(panel.body) + '</p>' +
        '<p class="lead">' + APP.escapeHtml(T('overview.roleNav')) + '</p></div>';
    } else if (route && route.id === 'settings') {
      html += '<div class="panel">' +
        '<p class="lead">' + APP.escapeHtml(T('common.signedInAs')) + ' ' +
        APP.escapeHtml((session.user && session.user.name) || '') + '</p>' +
        '<p><span class="role-badge">' + APP.escapeHtml(T(APP.roleKey(session.user && session.user.roleId))) + '</span></p>' +
        '</div>';
    } else {
      html += '<div class="empty-state">' +
        '<p class="title">' + APP.escapeHtml(panel.title) + '</p>' +
        '<p>' + APP.escapeHtml(panel.body) + '</p>' +
        (panel.task ? '<p><span class="task-note">' + APP.escapeHtml(panel.task) + '</span></p>' : '') +
        '</div>';
    }
    outlet.innerHTML = html;
    if (typeof document !== 'undefined') document.title = panel.title + ' — ' + T('brand.name');
    if (outlet.focus) outlet.focus();
    return panel;
  }

  /* ------------------------------------------------------- trips (F3) --- */

  /** Current filter set for the trips list (kept across re-renders). */
  var listFilters = {};

  function esc(value) { return APP.escapeHtml(value); }

  /** Parse `location.search` into a plain object (last value wins). */
  function parseSearch(search) {
    var out = {};
    var raw = String(search || '').replace(/^\?/, '');
    if (!raw) return out;
    var parts = raw.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var idx = parts[i].indexOf('=');
      var key = idx === -1 ? parts[i] : parts[i].slice(0, idx);
      var value = idx === -1 ? '' : parts[i].slice(idx + 1);
      try {
        out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
      } catch (err) { /* a malformed pair is ignored, never thrown */ }
    }
    return out;
  }

  function money(value) {
    if (value === null || value === undefined) return T('trips.none');
    if (i18n && typeof i18n.currency === 'function') {
      var formatted = i18n.currency(value, 'EUR');
      if (formatted !== null && formatted !== undefined) return formatted;
    }
    return String(value) + ' €';
  }

  function fmtDate(value) {
    if (!value) return T('trips.none');
    if (i18n && typeof i18n.dateTime === 'function') {
      var formatted = i18n.dateTime(value);
      if (formatted) return formatted;
    }
    return String(value);
  }

  function statusLabel(status) {
    return T(TRIPVIEW.statusKey ? TRIPVIEW.statusKey(status) : 'trips.status.' + status);
  }

  function errorText(res) {
    var code = res && res.data ? res.data.error : null;
    if (code === 'invalid_filter' && res && res.data && res.data.detail) {
      return T('trips.filterInvalid', { field: String(res.data.detail) });
    }
    return T(APP.errorKey(code, res ? res.status : 0));
  }

  function handleExpired() {
    session = { token: '', user: null };
    clearSession();
    setPath(APP.LOGIN_PATH, true);
    showLogin('error.sessionExpired');
  }

  function refreshTrips() {
    renderPanel(APP.routeForPath('/app/trips'));
  }

  /** The filters form + the list container. */
  function renderTripsList(outlet, token) {
    listFilters = TRIPVIEW.normalizeFilters ? TRIPVIEW.normalizeFilters(parseSearch(
      typeof location !== 'undefined' ? location.search : ''
    )) : {};
    var statusOptions = ['<option value="">' + esc(T('trips.filterAnyStatus')) + '</option>'];
    var statuses = TRIPVIEW.TRIP_STATUSES || [];
    for (var s = 0; s < statuses.length; s++) {
      statusOptions.push('<option value="' + esc(statuses[s]) + '"' +
        (listFilters.status === statuses[s] ? ' selected' : '') + '>' + esc(statusLabel(statuses[s])) + '</option>');
    }

    outlet.innerHTML =
      '<h1>' + esc(T('nav.trips')) + '</h1>' +
      '<form class="filters" id="tripFilters" novalidate>' +
        '<div class="field"><label for="filterStatus">' + esc(T('trips.filterStatus')) + '</label>' +
          '<select id="filterStatus">' + statusOptions.join('') + '</select></div>' +
        '<div class="field"><label for="filterDriver">' + esc(T('trips.filterDriver')) + '</label>' +
          '<select id="filterDriver"><option value="">' + esc(T('trips.filterAnyDriver')) + '</option></select></div>' +
        '<div class="field"><label for="filterFrom">' + esc(T('trips.filterFrom')) + '</label>' +
          '<input id="filterFrom" type="date" value="' + esc(listFilters.from ? String(listFilters.from).slice(0, 10) : '') + '"></div>' +
        '<div class="field"><label for="filterTo">' + esc(T('trips.filterTo')) + '</label>' +
          '<input id="filterTo" type="date" value="' + esc(listFilters.to ? String(listFilters.to).slice(0, 10) : '') + '"></div>' +
        '<div class="field field-grow"><label for="filterQ">' + esc(T('trips.filterText')) + '</label>' +
          '<input id="filterQ" type="search" maxlength="80" value="' + esc(listFilters.q || '') + '" ' +
          'placeholder="' + esc(T('trips.filterTextPlaceholder')) + '"></div>' +
        '<div class="filters-actions">' +
          '<button class="primary" type="submit">' + esc(T('trips.apply')) + '</button>' +
          '<button class="ghost" type="button" id="filterReset">' + esc(T('trips.reset')) + '</button>' +
        '</div>' +
      '</form>' +
      '<p class="alert" id="filterError" role="alert" hidden></p>' +
      '<p class="muted" id="tripsSummary">' + esc(T('common.loading')) + '</p>' +
      '<div id="tripsTableWrap"></div>';

    bindFiltersForm(outlet);
    loadDriverOptions(outlet, token);
    loadTrips(outlet, token);
  }

  function bindFiltersForm(outlet) {
    var form = outlet.querySelector('#tripFilters');
    if (form) {
      form.addEventListener('submit', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        applyFilters(outlet);
      });
    }
    var reset = outlet.querySelector('#filterReset');
    if (reset) {
      reset.addEventListener('click', function () {
        listFilters = {};
        setPath('/app/trips', true);
        refreshTrips();
      });
    }
  }

  function applyFilters(outlet) {
    var error = outlet.querySelector('#filterError');
    var next = TRIPVIEW.normalizeFilters({
      status: (outlet.querySelector('#filterStatus') || {}).value || '',
      driverId: (outlet.querySelector('#filterDriver') || {}).value || '',
      from: (outlet.querySelector('#filterFrom') || {}).value || '',
      to: (outlet.querySelector('#filterTo') || {}).value || '',
      q: (outlet.querySelector('#filterQ') || {}).value || ''
    });
    if (next.from && next.to && Date.parse(next.from) > Date.parse(next.to)) {
      if (error) { error.textContent = T('trips.filterBadRange'); error.hidden = false; }
      return;
    }
    if (error) { error.textContent = ''; error.hidden = true; }
    listFilters = next;
    var search = TRIPVIEW.buildQuery ? TRIPVIEW.buildQuery(next) : '';
    setPath('/app/trips' + search, true);
    refreshTrips();
  }

  /** Fill the driver filter from the same reference endpoint the dispatch form uses. */
  function loadDriverOptions(outlet, token) {
    request('/api/reference', { token: session.token }).then(function (res) {
      if (token !== renderToken) return;
      var select = outlet.querySelector('#filterDriver');
      if (!select || !res.ok || !res.data) return;
      var drivers = (res.data.reference && res.data.reference.drivers) || [];
      var html = '<option value="">' + esc(T('trips.filterAnyDriver')) + '</option>';
      for (var i = 0; i < drivers.length; i++) {
        html += '<option value="' + esc(drivers[i].id) + '"' +
          (listFilters.driverId === drivers[i].id ? ' selected' : '') + '>' +
          esc(drivers[i].name || drivers[i].id) + '</option>';
      }
      select.innerHTML = html;
    });
  }

  function loadTrips(outlet, token) {
    var path = TRIPVIEW.tripsPath ? TRIPVIEW.tripsPath(listFilters) : '/api/trips';
    return request(path, { token: session.token }).then(function (res) {
      if (token !== renderToken) return;
      var summary = outlet.querySelector('#tripsSummary');
      if (!summary) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        summary.textContent = '';
        outlet.querySelector('#tripsTableWrap').innerHTML =
          '<p class="alert">' + esc(errorText(res)) + '</p>';
        return;
      }
      var trips = (res.data && res.data.trips) || [];
      shownTrips = trips;
      summary.textContent = T('trips.count', { count: String(trips.length) });
      renderTripTable(outlet, trips);
    });
  }

  function renderTripTable(outlet, trips) {
    var wrap = outlet.querySelector('#tripsTableWrap');
    if (!wrap) return;
    if (!trips.length) {
      wrap.innerHTML = '<div class="empty-state"><p>' +
        esc(T(TRIPVIEW.emptyStateKey ? TRIPVIEW.emptyStateKey(listFilters) : 'trips.empty')) + '</p></div>';
      return;
    }
    var rows = trips.map(function (trip) {
      var row = TRIPVIEW.tripRow ? TRIPVIEW.tripRow(trip) : {};
      return '<tr class="clickable" data-trip="' + esc(row.id) + '">' +
        '<td data-label="' + esc(T('trips.colRoute')) + '">' + esc(row.origin || '?') + ' → ' + esc(row.destination || '?') + '</td>' +
        '<td data-label="' + esc(T('trips.colCustomer')) + '">' + esc(row.customer) + '</td>' +
        '<td data-label="' + esc(T('trips.colDriver')) + '">' + esc(row.driver) + '</td>' +
        '<td data-label="' + esc(T('trips.colStatus')) + '"><span class="status s-' + esc(row.status) + '">' + esc(statusLabel(row.status)) + '</span></td>' +
        '<td data-label="' + esc(T('trips.colRate')) + '">' + esc(money(TRIPVIEW.toNumber ? TRIPVIEW.toNumber(row.rate_eur) : row.rate_eur)) + '</td>' +
        '<td data-label="' + esc(T('trips.colCreated')) + '">' + esc(fmtDate(row.created_at)) + '</td>' +
        '</tr>';
    }).join('');

    wrap.innerHTML =
      '<div class="table-actions"><button class="ghost" type="button" id="exportCsv">' +
        esc(T('trips.exportCsv')) + '</button></div>' +
      '<table class="trips-table"><thead><tr>' +
        '<th>' + esc(T('trips.colRoute')) + '</th>' +
        '<th>' + esc(T('trips.colCustomer')) + '</th>' +
        '<th>' + esc(T('trips.colDriver')) + '</th>' +
        '<th>' + esc(T('trips.colStatus')) + '</th>' +
        '<th>' + esc(T('trips.colRate')) + '</th>' +
        '<th>' + esc(T('trips.colCreated')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    var links = wrap.querySelectorAll('tr[data-trip]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', onTripRowClick);
    }
    var exportBtn = wrap.querySelector('#exportCsv');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);
  }

  function onTripRowClick(ev) {
    var tr = ev && ev.currentTarget ? ev.currentTarget : ev.target;
    if (!tr || typeof tr.getAttribute !== 'function') return;
    var id = tr.getAttribute('data-trip');
    if (!id) return;
    route({ path: '/app/trips/' + encodeURIComponent(id), push: true });
  }

  /** Export exactly the rows the list shows (`shownTrips`), row-for-row. */
  function exportCsv() {
    if (!TRIPVIEW.toCsv) return;
    var csv = TRIPVIEW.toCsv(shownTrips);
    var name = TRIPVIEW.csvFileName ? TRIPVIEW.csvFileName() : 'trips.csv';
    try {
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      /* no Blob/URL (very old WebView): the list is still the source of truth */
    }
  }

  function tripDetailHtml(trip) {
    var order = trip.order || {};
    var totals = trip.totals || {};
    var customer = order.customer ? order.customer.name : T('trips.none');
    var pnl = totals.pnlEur;
    var pnlClass = (pnl === null || pnl === undefined) ? '' : (pnl < 0 ? 'neg' : 'pos');

    var html = '<p><span class="status s-' + esc(trip.status) + '">' + esc(statusLabel(trip.status)) + '</span></p>';
    html += '<dl class="kv">' +
      '<dt>' + esc(T('trips.colRoute')) + '</dt><dd>' + esc(order.origin || '?') + ' → ' + esc(order.destination || '?') + '</dd>' +
      '<dt>' + esc(T('trips.colCustomer')) + '</dt><dd>' + esc(customer) + '</dd>' +
      '<dt>' + esc(T('trips.colDriver')) + '</dt><dd>' + esc(trip.driver ? (trip.driver.name || trip.driver.email || trip.driver.id) : T('trips.none')) + '</dd>' +
      '<dt>' + esc(T('trips.truck')) + '</dt><dd>' + esc(trip.truck ? (trip.truck.plate || trip.truck.id) : T('trips.none')) + '</dd>' +
      '<dt>' + esc(T('trips.colRate')) + '</dt><dd>' + esc(money(trip.rateEur)) + '</dd>' +
      '<dt>' + esc(T('trips.createdAt')) + '</dt><dd>' + esc(fmtDate(trip.createdAt)) + '</dd>' +
      '</dl>';

    html += assignBoxHtml(trip);
    html += '<h2 class="section-title">' + esc(T('trips.timeline')) + '</h2>' + timelineHtml(trip.statusEvents || []);
    html += documentsPanelHtml(trip);
    html += trackingPanelHtml(trip);
    html += '<h2 class="section-title">' + esc(T('trips.expenses')) + '</h2>' + expensesHtml(trip.expenses || []);
    html += '<h2 class="section-title">' + esc(T('trips.pnl')) + '</h2>' +
      '<p class="pnl ' + pnlClass + '">' + esc(money(pnl)) + '</p>' +
      '<p class="muted">' + esc(T('trips.pnlFormula', {
        rate: money(trip.rateEur),
        expenses: money(totals.expensesEur)
      })) + '</p>';
    return html;
  }

  function timelineHtml(events) {
    if (!events.length) return '<p class="empty">' + esc(T('trips.noEvents')) + '</p>';
    var items = events.map(function (event) {
      var actor = event.actor && event.actor.name ? event.actor.name : T('trips.actorSystem');
      // Board task #36 (F5): a reassignment keeps the status, so its event is
      // `from === to`. Name it as a reassignment — a "Assigned → Assigned" line
      // would read like a no-op.
      var reassigned = ASSIGN.isReassignment ? ASSIGN.isReassignment(event) : false;
      var what = reassigned
        ? T('trips.reassigned', { status: statusLabel(event.to) })
        : statusLabel(event.from) + ' → ' + statusLabel(event.to);
      return '<li' + (reassigned ? ' class="tl-reassign"' : '') + '>' +
        '<div class="tl-what">' + esc(what) + '</div>' +
        '<div class="tl-when">' + esc(fmtDate(event.at)) + ' · ' + esc(actor) + '</div>' +
        '</li>';
    }).join('');
    return '<ul class="timeline">' + items + '</ul>';
  }

  /**
   * The documents panel of the trip detail (board task #37, FAv1-F6).
   *
   * The checklist / POD-gate decisions come from `pilot/lib/driver-core.js`
   * (via `lib/documents.js`), never from this file: the app and the driver
   * client must not disagree about which requirement is outstanding. The panel
   * is the list + status, the region checklist, the upload form and the
   * owner/dispatcher verify-or-reject actions.
   */
  function documentsPanelHtml(trip) {
    var documents = trip.documents || [];
    var role = session.user && session.user.roleId;
    var html = '<h2 class="section-title">' + esc(T('trips.documents')) + '</h2>';
    html += '<p class="alert" id="docMessage" role="alert" hidden></p>';
    html += docGateHtml(documents);
    html += docChecklistHtml(DOC.checklistRows ? DOC.checklistRows(documents, DRCORE) : []);
    html += docTableHtml(documents, role);
    if (DOC.canUploadDocuments && DOC.canUploadDocuments(role, false)) {
      html += docUploadFormHtml();
    }
    return html;
  }

  /** The POD-gate line: is the POD/eCMR requirement met, or what is missing. */
  function docGateHtml(documents) {
    var ready = DOC.podSatisfied ? DOC.podSatisfied(documents, DRCORE) : false;
    return '<p class="doc-gate ' + (ready ? 'ok' : 'missing') + '">' +
      esc(T(ready ? 'docs.gateReady' : 'docs.gateMissing')) + '</p>';
  }

  /** The required-document checklist rows (label / requirement / state). */
  function docChecklistHtml(checklist) {
    if (!checklist || !checklist.length) return '';
    var items = checklist.map(function (row) {
      var badge = row.required
        ? (row.alternative ? T('docs.alternative') : T('docs.required'))
        : T('docs.optional');
      var state = row.present
        ? T('docs.attached') + (row.status ? ' · ' + T(DOC.statusKey(row.status)) : '')
        : T('docs.notAttached');
      return '<li class="doc-check' + (row.required ? ' is-required' : '') + '">' +
        '<span class="doc-check-label">' + esc(T(row.labelKey)) + '</span>' +
        '<span class="doc-check-badge">' + esc(badge) + '</span>' +
        '<span class="doc-check-state' + (row.present ? ' present' : '') + '">' + esc(state) + '</span>' +
        '</li>';
    }).join('');
    return '<h3 class="doc-subtitle">' + esc(T('docs.checklistTitle')) + '</h3>' +
      '<ul class="doc-checklist">' + items + '</ul>';
  }

  /** The document list. Verify/reject render only for a managing role. */
  function docTableHtml(documents, role) {
    var canManage = DOC.canManageDocuments ? DOC.canManageDocuments(role) : false;
    if (!documents.length) {
      return '<p class="empty">' + esc(T('trips.noDocuments')) + '</p>';
    }
    var head = '<th>' + esc(T('trips.docType')) + '</th><th>' + esc(T('trips.docStatus')) +
      '</th><th>' + esc(T('trips.docUploaded')) + '</th>' + (canManage ? '<th>' + esc(T('docs.actions')) + '</th>' : '');
    var rows = documents.map(function (d) {
      var cells = '<td>' + esc(T(DOC.docTypeKey ? DOC.docTypeKey(d.docType) : 'trips.doctype.' + d.docType)) + '</td>' +
        '<td><span class="doc-status s-' + esc(d.status) + '">' +
          esc(T(DOC.statusKey ? DOC.statusKey(d.status) : 'trips.docstatus.' + d.status)) + '</span></td>' +
        '<td>' + esc(fmtDate(d.uploadedAt)) + '</td>';
      if (canManage) {
        cells += '<td class="doc-actions">' +
          '<button class="ghost" type="button" data-doc="' + esc(d.id) + '" data-doc-status="VERIFIED">' +
            esc(T('docs.verify')) + '</button>' +
          '<button class="ghost" type="button" data-doc="' + esc(d.id) + '" data-doc-status="REJECTED">' +
            esc(T('docs.reject')) + '</button>' +
          '</td>';
      }
      return '<tr data-doc-row="' + esc(d.id) + '">' + cells + '</tr>';
    }).join('');
    return '<div class="doc-table-wrap"><table class="trips-table"><thead><tr>' + head +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /** The upload form: doc type + file. The file is validated before any request. */
  function docUploadFormHtml() {
    var entries = DOC.docTypeEntries ? DOC.docTypeEntries() : [];
    var options = '';
    for (var i = 0; i < entries.length; i++) {
      options += '<option value="' + esc(entries[i].value) + '">' + esc(T(entries[i].labelKey)) + '</option>';
    }
    return '<h3 class="doc-subtitle">' + esc(T('docs.uploadTitle')) + '</h3>' +
      '<form class="doc-upload" id="docForm" novalidate>' +
        '<div class="field">' +
          '<label for="docType">' + esc(T('docs.type')) + '</label>' +
          '<select id="docType">' + options + '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label for="docFile">' + esc(T('docs.file')) + '</label>' +
          '<input id="docFile" type="file" accept="' + esc(DOC.acceptAttribute ? DOC.acceptAttribute() : '') + '">' +
          '<p class="helper">' + esc(T('docs.fileHint', { max: DOC.formatBytes ? DOC.formatBytes(DOC.DEFAULT_MAX_UPLOAD_BYTES) : '' })) + '</p>' +
          '<p class="field-error" id="docFileError" hidden></p>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="primary" type="submit" id="docSubmit">' + esc(T('docs.upload')) + '</button>' +
        '</div>' +
      '</form>';
  }

  function expensesHtml(expenses) {
    if (!expenses.length) return '<p class="empty">' + esc(T('trips.noExpenses')) + '</p>';
    var rows = expenses.map(function (e) {
      return '<tr><td>' + esc(T('trips.expense.' + e.category)) + '</td><td>' + esc(money(e.amountEur)) + '</td></tr>';
    }).join('');
    return '<table class="trips-table"><thead><tr>' +
      '<th>' + esc(T('trips.expenseCategory')) + '</th><th>' + esc(T('trips.expenseAmount')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ------------------------------------------------- tracking link (F8) --- */

  /**
   * The customer tracking-link control (board task #39, FAv1-F8).
   *
   * Rendered on the trip detail for a `trip:*` role only. The link is minted
   * with `POST /api/trips/:id/track-link`, read back from the same path (the
   * API recomputes the identical token from the persisted mint parameters) and
   * revoked with `DELETE`. The pure decisions (state, path, copy target, error
   * mapping) live in `lib/tracking.js`; this section only touches the DOM and
   * the network. Element ids are dynamic, so they are resolved from the outlet
   * (`el()` is reserved for ids present in index.html).
   */

  /** The link currently shown for the visible trip (null = none). */
  var trackCurrent = null;

  function trackNode(outlet, id) {
    return outlet && outlet.querySelector ? outlet.querySelector('#' + id) : null;
  }

  function trackingPanelHtml() {
    var role = session.user && session.user.roleId;
    if (!(TRACK.canManageTracking && TRACK.canManageTracking(role))) return '';
    return '<h2 class="section-title">' + esc(T('tracking.title')) + '</h2>' +
      '<p class="alert" id="trackMessage" role="alert" hidden></p>' +
      '<div id="trackBody" class="track-body"><p class="muted">' + esc(T('common.loading')) + '</p></div>';
  }

  /** Set or clear the panel's message line. `kind` is 'success' or ''. */
  function setTrackMessage(outlet, text, kind) {
    var node = trackNode(outlet, 'trackMessage');
    if (!node) return;
    if (!text) {
      node.textContent = '';
      node.hidden = true;
      node.className = 'alert';
      return;
    }
    node.textContent = text;
    node.className = 'alert' + (kind ? ' ' + kind : '');
    node.hidden = false;
  }

  /** The message for a failed tracking request (catalogue key or detail). */
  function trackErrorText(res) {
    var detail = TRACK.errorDetail ? TRACK.errorDetail(res) : '';
    if (detail) return detail;
    return T(TRACK.errorKey ? TRACK.errorKey(res) : 'error.unexpected');
  }

  function renderTrackingBody(outlet, body, link) {
    var state = TRACK.linkState ? TRACK.linkState(link) : (link ? 'active' : 'none');
    if (state === 'active') {
      body.innerHTML =
        '<p class="track-state active">' + esc(T('tracking.state.active')) + '</p>' +
        '<div class="track-link-row">' +
          '<input class="track-url" id="trackUrl" type="text" readonly value="' + esc(link.url) + '">' +
          '<button class="ghost" type="button" data-track-action="copy" id="trackCopy">' +
            esc(T('tracking.copy')) + '</button>' +
        '</div>' +
        '<p class="muted" id="trackExpiry">' +
          esc(T('tracking.expires', { date: fmtDate(link.expiresAt) })) + '</p>' +
        '<div class="form-actions">' +
          '<button class="ghost danger" type="button" data-track-action="revoke" id="trackRevoke">' +
            esc(T('tracking.revoke')) + '</button>' +
        '</div>';
      return;
    }
    body.innerHTML =
      '<p class="track-state none">' + esc(T(TRACK.stateKey ? TRACK.stateKey(state) : 'tracking.state.none')) + '</p>' +
      '<div class="form-actions">' +
        '<button class="primary" type="button" data-track-action="mint" id="trackMint">' +
          esc(T('tracking.mint')) + '</button>' +
      '</div>';
  }

  /** Load the trip's current link and wire the one-action controls. */
  function loadTrackingControl(outlet, trip) {
    var body = trackNode(outlet, 'trackBody');
    if (!body) return;
    trackCurrent = null;
    body.addEventListener('click', function (ev) {
      var target = ev && ev.target;
      var action = target && target.getAttribute ? target.getAttribute('data-track-action') : null;
      if (!action) return;
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (action === 'mint') mintTrackingLink(outlet, trip);
      else if (action === 'copy') copyTrackingLink(outlet);
      else if (action === 'revoke') revokeTrackingLink(outlet, trip);
    });

    request(TRACK.trackingPath(trip.id), { token: session.token }).then(function (res) {
      if (trackNode(outlet, 'trackBody') !== body) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        setTrackMessage(outlet, trackErrorText(res), '');
        body.innerHTML = '';
        return;
      }
      trackCurrent = TRACK.linkFrom ? TRACK.linkFrom(res.data) : null;
      renderTrackingBody(outlet, body, trackCurrent);
    });
  }

  function mintTrackingLink(outlet, trip) {
    var body = trackNode(outlet, 'trackBody');
    if (!body) return;
    setTrackMessage(outlet, T('tracking.minting'), '');
    var button = trackNode(outlet, 'trackMint');
    if (button) button.disabled = true;
    request(TRACK.trackingPath(trip.id), { method: 'POST', token: session.token }).then(function (res) {
      if (trackNode(outlet, 'trackBody') !== body) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        setTrackMessage(outlet, trackErrorText(res), '');
        if (button) button.disabled = false;
        return;
      }
      trackCurrent = TRACK.linkFrom ? TRACK.linkFrom(res.data) : null;
      renderTrackingBody(outlet, body, trackCurrent);
      setTrackMessage(outlet, T('tracking.minted'), 'success');
    });
  }

  /** One action: put the full URL on the clipboard (fallback: select it). */
  function copyTrackingLink(outlet) {
    var url = TRACK.copyTarget ? TRACK.copyTarget(trackCurrent) : '';
    var input = trackNode(outlet, 'trackUrl');
    if (!url) return;
    var after = function (ok) {
      if (ok) setTrackMessage(outlet, T('tracking.copied'), 'success');
      else {
        if (input && input.focus) input.focus();
        if (input && input.select) input.select();
        setTrackMessage(outlet, T('tracking.copyManual'), '');
      }
    };
    if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { after(true); }, function () { after(false); });
      return;
    }
    var ok = false;
    if (input && input.select) {
      input.focus();
      input.select();
      try {
        ok = typeof document !== 'undefined' && document.execCommand
          ? Boolean(document.execCommand('copy'))
          : false;
      } catch (err) {
        ok = false;
      }
    }
    after(ok);
  }

  function revokeTrackingLink(outlet, trip) {
    var body = trackNode(outlet, 'trackBody');
    if (!body) return;
    if (typeof win.confirm === 'function' && !win.confirm(T('tracking.confirmRevoke'))) return;
    var button = trackNode(outlet, 'trackRevoke');
    if (button) button.disabled = true;
    request(TRACK.trackingPath(trip.id), { method: 'DELETE', token: session.token }).then(function (res) {
      if (trackNode(outlet, 'trackBody') !== body) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        setTrackMessage(outlet, trackErrorText(res), '');
        if (button) button.disabled = false;
        return;
      }
      trackCurrent = null;
      renderTrackingBody(outlet, body, null);
      setTrackMessage(outlet, T('tracking.revoked'), 'success');
    });
  }

  function renderTripDetail(outlet, route_, token, flash) {
    var id = route_ && route_.params ? route_.params.id : '';
    outlet.innerHTML =
      '<p class="crumbs"><a href="/app/trips" id="tripsBack">' + esc(T('trips.back')) + '</a></p>' +
      '<h1>' + esc(T('trips.detailTitle')) + '</h1>' +
      '<div id="tripDetailBody" class="panel">' + esc(T('common.loading')) + '</div>';

    var back = outlet.querySelector('#tripsBack');
    if (back) {
      back.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        route({ path: '/app/trips', push: true });
      });
    }

    return request('/api/trips/' + encodeURIComponent(id), { token: session.token }).then(function (res) {
      if (token !== renderToken) return;
      var box = outlet.querySelector('#tripDetailBody');
      if (!box) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        box.innerHTML = '<p class="alert">' + esc(errorText(res)) + '</p>';
        return;
      }
      var trip = (res.data && res.data.trip) || {};
      box.innerHTML = tripDetailHtml(trip);
      loadAssignControl(outlet, route_, trip);
      loadDocumentsControl(outlet, route_, trip, flash);
      loadTrackingControl(outlet, trip);
    });
  }

  /* --------------------------------------------- assign driver (F5) --- */

  /**
   * Assign / reassign the trip's driver (board task #36, FAv1-F5).
   *
   * The control is only rendered for a role that holds `trip:*` (owner,
   * dispatcher) and only while the trip is still open: a driver can never
   * assign, and a settled/cancelled trip takes no driver change. The pure
   * decisions (option entries, validation, payload, error mapping) live in
   * `lib/assign.js`; this section only reads/writes the DOM and the network.
   * Element ids are dynamic, so they are resolved from the outlet.
   */

  /** The trip the visible assign form belongs to (its id and current driver). */
  var assignTrip = null;
  /** The loaded driver list, or null before it arrives. */
  var assignDrivers = null;

  function assignNode(outlet, id) {
    return outlet && outlet.querySelector ? outlet.querySelector('#' + id) : null;
  }

  /** The driver section: a real form for a dispatcher, or an honest note. */
  function assignBoxHtml(trip) {
    if (!(APP.canManageTrips && APP.canManageTrips(session.user && session.user.roleId))) return '';
    if (ASSIGN.isClosed && ASSIGN.isClosed(trip && trip.status)) {
      return '<h2 class="section-title">' + esc(T('assign.title')) + '</h2>' +
        '<p class="muted">' + esc(T('assign.closed')) + '</p>';
    }
    return '<h2 class="section-title">' + esc(T('assign.title')) + '</h2>' +
      '<form class="assign-form" id="assignForm" novalidate>' +
        '<p class="alert" id="assignMessage" role="alert" hidden></p>' +
        '<div class="field">' +
          '<label for="assignDriver">' + esc(T('assign.driver')) + '</label>' +
          '<select id="assignDriver"><option value="">' + esc(T('common.loading')) + '</option></select>' +
          '<p class="field-error" id="assignDriverError" hidden></p>' +
        '</div>' +
        '<div class="form-actions">' +
          '<span class="helper">' + esc(T('assign.hint')) + '</span>' +
          '<button class="primary" type="submit" id="assignSubmit">' + esc(T('assign.submit')) + '</button>' +
        '</div>' +
      '</form>';
  }

  function currentDriverId(trip) {
    if (!trip) return '';
    if (trip.driverId) return String(trip.driverId);
    return trip.driver && trip.driver.id ? String(trip.driver.id) : '';
  }

  /** Fill the driver select from the same reference endpoint the dispatch form uses. */
  function loadAssignControl(outlet, route_, trip) {
    var form = assignNode(outlet, 'assignForm');
    if (!form) return;
    assignTrip = trip;
    assignDrivers = null;

    form.addEventListener('submit', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      submitAssign(outlet, route_);
    });

    request('/api/reference', { token: session.token }).then(function (res) {
      if (assignNode(outlet, 'assignForm') !== form) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        assignDrivers = [];
        setSelectFromEntries(outlet, 'assignDriver', [], T('assign.loadFailed'));
        setAssignMessage(outlet, 'assign.loadFailed', null, null);
        var submit = assignNode(outlet, 'assignSubmit');
        if (submit) submit.disabled = true;
        return;
      }
      var reference = res.data && res.data.reference ? res.data.reference : {};
      assignDrivers = Array.isArray(reference.drivers) ? reference.drivers : [];
      setSelectFromEntries(
        outlet,
        'assignDriver',
        ASSIGN.driverEntries ? ASSIGN.driverEntries(assignDrivers, currentDriverId(trip)) : [],
        T('assign.choose')
      );
    });
  }

  /** Replace a select's options with pure `{value,label,selected}` entries. */
  function setSelectFromEntries(outlet, id, entries, placeholder) {
    var node = assignNode(outlet, id);
    if (!node) return;
    var html = placeholder ? '<option value="">' + esc(placeholder) + '</option>' : '';
    for (var i = 0; i < entries.length; i++) {
      html += '<option value="' + esc(entries[i].value) + '"' +
        (entries[i].selected ? ' selected' : '') + '>' + esc(entries[i].label) + '</option>';
    }
    node.innerHTML = html;
  }

  /** Show or clear the form-level message (the `alert` element carries `success`). */
  function setAssignMessage(outlet, key, params, kind) {
    var node = assignNode(outlet, 'assignMessage');
    if (!node) return;
    var message = key ? T(key, params) : '';
    node.textContent = message;
    node.hidden = message === '';
    if (node.classList) {
      node.classList.remove('hidden');
      if (kind === 'success') node.classList.add('success');
      else node.classList.remove('success');
    }
  }

  function clearAssignErrors(outlet) {
    var field = assignNode(outlet, 'assignDriverError');
    if (field) { field.textContent = ''; field.hidden = true; }
    setAssignMessage(outlet, null, null, null);
  }

  function submitAssign(outlet, route_) {
    if (!ASSIGN.validateAssign || !assignTrip) return;
    var select = assignNode(outlet, 'assignDriver');
    var check = ASSIGN.validateAssign(
      { driverId: select ? select.value : '' },
      assignTrip,
      assignDrivers || []
    );

    clearAssignErrors(outlet);
    var errorNode = assignNode(outlet, 'assignDriverError');
    if (!check.ok) {
      if (errorNode) {
        errorNode.textContent = T(check.errors.driverId);
        errorNode.hidden = false;
        if (errorNode.classList) errorNode.classList.remove('hidden');
      }
      if (select && select.focus) select.focus();
      return;
    }

    var submit = assignNode(outlet, 'assignSubmit');
    if (submit) submit.disabled = true;

    request(ASSIGN.assignPath(assignTrip.id), {
      method: 'POST',
      token: session.token,
      body: check.payload
    }).then(function (res) {
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        if (submit) submit.disabled = false;
        var key = ASSIGN.assignErrorKey ? ASSIGN.assignErrorKey(res) : 'error.unexpected';
        var detail = ASSIGN.assignErrorDetail ? ASSIGN.assignErrorDetail(res) : '';
        setAssignMessage(outlet, key, detail ? { detail: detail } : null, null);
        return;
      }
      var driver = (res.data && res.data.driver) || {};
      var name = driver.name || T('trips.none');
      // Re-render from the server so the driver shown and the new timeline event
      // come from the same source of truth, then confirm what happened.
      var next = ++renderToken;
      renderTripDetail(outlet, route_, next).then(function () {
        setAssignMessage(outlet, 'assign.assigned', { name: name }, 'success');
      });
    });
  }

  /* ---------------------------------------------- documents (F6) --- */

  /**
   * Documents panel wiring (board task #37, FAv1-F6): the pre-upload size/MIME
   * check, the upload itself, and verify/reject. The decisions live in
   * `lib/documents.js` (which delegates the checklist/POD gate to
   * `pilot/lib/driver-core.js`); this section only touches the DOM and the
   * network.
   *
   * The panel is injected by `documentsPanelHtml`, so its element ids are
   * dynamic and resolved from the outlet — never with the static `el()` helper
   * (which the shell test constrains to ids present in index.html).
   */

  function docNode(outlet, id) {
    return outlet && outlet.querySelector ? outlet.querySelector('#' + id) : null;
  }

  /** Show / clear the panel-level message (an `alert`, `success` when a success). */
  function setDocMessage(outlet, key, params, kind) {
    var node = docNode(outlet, 'docMessage');
    if (!node) return;
    var message = key ? T(key, params) : '';
    node.textContent = message;
    node.hidden = message === '';
    if (node.classList) {
      node.classList.remove('hidden');
      if (kind === 'success') node.classList.add('success');
      else node.classList.remove('success');
    }
  }

  /**
   * Show / clear the file field error. A `<select>` built from DOC_TYPES cannot
   * hold an unknown value, so a doc-type rejection is surfaced as the panel
   * message instead of being lost.
   */
  function setDocFieldError(outlet, field, message) {
    if (field !== 'file') {
      if (message) setDocMessage(outlet, 'docs.error.docType', null, null);
      return;
    }
    var node = docNode(outlet, 'docFileError');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
    if (node.classList) {
      if (message) node.classList.remove('hidden');
      else node.classList.add('hidden');
    }
  }

  function clearDocErrors(outlet) {
    setDocFieldError(outlet, 'file', '');
    setDocMessage(outlet, null, null, null);
  }

  /** The chosen `File`, or null. */
  function selectedFile(outlet) {
    var input = docNode(outlet, 'docFile');
    if (!input || !input.files || !input.files.length) return null;
    return input.files[0] || null;
  }

  function selectedDocType(outlet) {
    var select = docNode(outlet, 'docType');
    return select && select.value !== undefined ? String(select.value) : '';
  }

  /** Best-effort GPS fix for a capture; never blocks an upload for more than 5s. */
  function captureGeo(callback) {
    var done = false;
    function finish(geo) { if (done) return; done = true; callback(geo); }
    try {
      if (typeof navigator === 'undefined' || !navigator.geolocation ||
          typeof navigator.geolocation.getCurrentPosition !== 'function') {
        finish(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          var c = pos && pos.coords ? pos.coords : {};
          finish({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy });
        },
        function () { finish(null); },
        { timeout: 5000, maximumAge: 60000 }
      );
    } catch (err) {
      finish(null);
      return;
    }
    if (typeof setTimeout === 'function') setTimeout(function () { finish(null); }, 6000);
  }

  /** Read a File as a data URL (the API decodes an optional `data:` prefix). */
  function readFileBase64(file, callback) {
    if (typeof FileReader === 'undefined' || !file) { callback(''); return; }
    try {
      var reader = new FileReader();
      reader.onload = function () {
        callback(typeof reader.result === 'string' ? reader.result : '');
      };
      reader.onerror = function () { callback(''); };
      reader.readAsDataURL(file);
    } catch (err) {
      callback('');
    }
  }

  function loadDocumentsControl(outlet, route_, trip, flash) {
    if (!trip || !trip.id) return;
    if (flash) setDocMessage(outlet, flash.key, flash.params, flash.kind);

    var input = docNode(outlet, 'docFile');
    if (input) {
      input.addEventListener('change', function () {
        var file = selectedFile(outlet);
        if (!file) { setDocFieldError(outlet, 'file', ''); return; }
        // Refuse an over-limit / unsupported file in the UI, before a request.
        var check = DOC.validateUpload
          ? DOC.validateUpload({
              docType: selectedDocType(outlet),
              mimeType: file.type,
              size: file.size,
            })
          : { ok: true };
        setDocFieldError(outlet, 'file', check.ok ? '' : T(check.key, check.params));
      });
    }

    var form = docNode(outlet, 'docForm');
    if (form) {
      form.addEventListener('submit', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        submitDocument(outlet, route_, trip);
      });
    }

    var buttons = outlet.querySelectorAll ? outlet.querySelectorAll('button[data-doc-status]') : [];
    for (var i = 0; i < buttons.length; i += 1) {
      bindDocAction(outlet, route_, buttons[i]);
    }
  }

  function bindDocAction(outlet, route_, button) {
    button.addEventListener('click', function () {
      submitDocumentStatus(outlet, route_, button);
    });
  }

  function submitDocument(outlet, route_, trip) {
    var file = selectedFile(outlet);
    var check = DOC.validateUpload
      ? DOC.validateUpload({
          docType: selectedDocType(outlet),
          mimeType: file ? file.type : '',
          size: file ? file.size : 0,
        })
      : { ok: true };
    clearDocErrors(outlet);
    if (!check.ok) {
      setDocFieldError(outlet, check.field, T(check.key, check.params));
      return;
    }
    if (!file) { setDocFieldError(outlet, 'file', T('docs.error.empty')); return; }

    var submit = docNode(outlet, 'docSubmit');
    if (submit) submit.disabled = true;
    var docType = selectedDocType(outlet);
    // The capture carries when it was taken; the location is best-effort (the
    // API stores what is present and accepts an upload without a fix).
    var capturedAt = new Date().toISOString();

    captureGeo(function (geo) {
      readFileBase64(file, function (dataBase64) {
        if (!dataBase64) {
          if (submit) submit.disabled = false;
          setDocFieldError(outlet, 'file', T('docs.error.file'));
          return;
        }
        var payload = DOC.uploadPayload({
          docType: docType,
          filename: file.name,
          mimeType: file.type,
          dataBase64: dataBase64,
          capturedAt: capturedAt,
          geo: geo,
        });
        request(DOC.uploadPath(trip.id), { method: 'POST', token: session.token, body: payload })
          .then(function (res) {
            if (res.status === 401) { handleExpired(); return; }
            if (!res.ok) {
              if (submit) submit.disabled = false;
              var detail = DOC.errorDetail ? DOC.errorDetail(res) : '';
              setDocMessage(outlet, DOC.errorKey(res), detail ? { detail: detail } : null, null);
              return;
            }
            // Re-render from the server so the list and the checklist come from
            // the same source of truth, then confirm what happened.
            var next = ++renderToken;
            renderTripDetail(outlet, route_, next, {
              key: 'docs.uploaded',
              params: { docType: T(DOC.docTypeKey(docType)) },
              kind: 'success',
            });
          });
      });
    });
  }

  function submitDocumentStatus(outlet, route_, button) {
    var id = button && button.getAttribute ? button.getAttribute('data-doc') : '';
    var status = button && button.getAttribute ? button.getAttribute('data-doc-status') : '';
    if (!id) return;
    button.disabled = true;
    request(DOC.documentPath(id), {
      method: 'PATCH',
      token: session.token,
      body: DOC.verifyPayload(status),
    }).then(function (res) {
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        button.disabled = false;
        var detail = DOC.errorDetail ? DOC.errorDetail(res) : '';
        setDocMessage(outlet, DOC.errorKey(res), detail ? { detail: detail } : null, null);
        return;
      }
      var next = ++renderToken;
      renderTripDetail(outlet, route_, next, {
        key: String(status).toUpperCase() === 'REJECTED' ? 'docs.rejected' : 'docs.verified',
        kind: 'success',
      });
    });
  }

  /* -------------------------------------------------- dispatch (F4) --- */

  /**
   * Create-trip form (board task #35): the dispatcher picks an order, a driver
   * and a truck from the org's own lists — no raw ids are ever typed. The pure
   * decisions (labels, validation, payload, error keys) live in
   * `lib/dispatch.js`; this section only reads/writes the DOM and the network.
   *
   * Element ids are dynamic (the form is injected), so they are resolved from
   * the outlet with `querySelector`, never with `el()` (which is for the static
   * shell only).
   */

  /** The loaded `GET /api/reference` payload, or null before it arrives. */
  var dispatchReference = null;
  /** Bumped per render so a stale reference response cannot overwrite a newer one. */
  var dispatchLoadToken = 0;

  /** Dynamic error node per form field. */
  var DISPATCH_FIELD_ERRORS = {
    orderId: 'dispatchOrderError',
    customerId: 'dispatchCustomerError',
    driverId: 'dispatchDriverError',
    truckId: 'dispatchTruckError',
    rateEur: 'dispatchRateError',
    plannedAt: 'dispatchPlannedError'
  };
  /** The control each field error belongs to (focus target after a failed submit). */
  var DISPATCH_FIELD_INPUTS = {
    orderId: 'dispatchOrder',
    driverId: 'dispatchDriver',
    truckId: 'dispatchTruck',
    rateEur: 'dispatchRate',
    plannedAt: 'dispatchPlanned'
  };
  /** Submit order for the "what went wrong" summary. */
  var DISPATCH_FIELD_ORDER = ['orderId', 'customerId', 'driverId', 'truckId', 'rateEur', 'plannedAt'];

  function dispatchNode(outlet, id) {
    return outlet && outlet.querySelector ? outlet.querySelector('#' + id) : null;
  }

  /** Local shorthand for the core's escaper (distinct from any later helper). */
  function escHtml(value) { return APP.escapeHtml(value); }

  function fieldValue(outlet, id) {
    var node = dispatchNode(outlet, id);
    return node && node.value !== undefined ? String(node.value) : '';
  }

  /** Show or clear a node's message. Takes the node, so no id is hard-coded. */
  function setMessage(node, message, kind) {
    if (!node) return;
    if (message) {
      node.textContent = message;
      node.hidden = false;
      if (node.classList) {
        node.classList.remove('hidden');
        if (kind === 'success') node.classList.add('success');
        else node.classList.remove('success');
      }
    } else {
      node.textContent = '';
      node.hidden = true;
      if (node.classList) node.classList.add('hidden');
    }
  }

  /** The form-level message, translated. */
  function dispatchMessage(outlet, key, params, kind) {
    setMessage(dispatchNode(outlet, 'dispatchMessage'), key ? T(key, params) : '', kind);
  }

  /** Fill a select from pure `optionEntries` output, optionally with a placeholder. */
  function setSelectEntries(outlet, id, entries, placeholder, disabled) {
    var node = dispatchNode(outlet, id);
    if (!node) return;
    var html = placeholder ? '<option value="">' + escHtml(placeholder) + '</option>' : '';
    for (var i = 0; i < entries.length; i++) {
      html += '<option value="' + escHtml(entries[i].value) + '">' + escHtml(entries[i].label) + '</option>';
    }
    node.innerHTML = html;
    if (disabled !== undefined) node.disabled = Boolean(disabled);
  }

  function renderDispatch(outlet) {
    dispatchLoadToken += 1;
    var loadToken = dispatchLoadToken;
    dispatchReference = null;

    outlet.innerHTML =
      '<h1>' + escHtml(T('nav.dispatch')) + '</h1>' +
      '<p class="lead">' + escHtml(T('dispatch.lead')) + '</p>' +
      '<form class="dispatch-form" id="dispatchForm" novalidate>' +
        '<p class="alert" id="dispatchMessage" role="alert" hidden></p>' +
        '<div class="field">' +
          '<label for="dispatchOrder">' + escHtml(T('dispatch.order')) + '</label>' +
          '<select id="dispatchOrder" required>' +
            '<option value="">' + escHtml(T('common.loading')) + '</option>' +
          '</select>' +
          '<p class="field-error" id="dispatchOrderError" hidden></p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="dispatchCustomer">' + escHtml(T('dispatch.customer')) + '</label>' +
          '<input id="dispatchCustomer" type="text" readonly>' +
          '<p class="helper">' + escHtml(T('dispatch.customerHint')) + '</p>' +
          '<p class="field-error" id="dispatchCustomerError" hidden></p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="dispatchDriver">' + escHtml(T('dispatch.driver')) + '</label>' +
          '<select id="dispatchDriver"></select>' +
          '<p class="field-error" id="dispatchDriverError" hidden></p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="dispatchTruck">' + escHtml(T('dispatch.truck')) + '</label>' +
          '<select id="dispatchTruck"></select>' +
          '<p class="field-error" id="dispatchTruckError" hidden></p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="dispatchRate">' + escHtml(T('dispatch.rate')) + '</label>' +
          '<input id="dispatchRate" type="number" min="0" step="0.01" inputmode="decimal">' +
          '<p class="helper">' + escHtml(T('dispatch.rateHint')) + '</p>' +
          '<p class="field-error" id="dispatchRateError" hidden></p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="dispatchPlanned">' + escHtml(T('dispatch.planned')) + '</label>' +
          '<input id="dispatchPlanned" type="datetime-local">' +
          '<p class="helper">' + escHtml(T('dispatch.plannedHint')) + '</p>' +
          '<p class="field-error" id="dispatchPlannedError" hidden></p>' +
        '</div>' +
        '<div class="form-actions">' +
          '<span class="helper">' + escHtml(T('dispatch.draftNote')) + '</span>' +
          '<button class="primary" type="submit" id="dispatchSubmit">' + escHtml(T('dispatch.submit')) + '</button>' +
        '</div>' +
      '</form>';

    var form = dispatchNode(outlet, 'dispatchForm');
    if (form) {
      form.addEventListener('submit', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        submitDispatch(outlet);
      });
    }
    var order = dispatchNode(outlet, 'dispatchOrder');
    if (order) order.addEventListener('change', function () { syncDispatchCustomer(outlet); });

    loadDispatchReference(outlet, loadToken);
  }

  function loadDispatchReference(outlet, loadToken) {
    return request('/api/reference', { token: session.token }).then(function (res) {
      if (loadToken !== dispatchLoadToken) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        dispatchReference = null;
        setSelectEntries(outlet, 'dispatchOrder', [], T('dispatch.loadFailed'), true);
        setSelectEntries(outlet, 'dispatchDriver', [], T('dispatch.assignLater'), true);
        setSelectEntries(outlet, 'dispatchTruck', [], T('dispatch.assignLater'), true);
        var submit = dispatchNode(outlet, 'dispatchSubmit');
        if (submit) submit.disabled = true;
        dispatchMessage(outlet, DISPATCH.createTripErrorKey ? DISPATCH.createTripErrorKey(res) : 'error.unexpected');
        return;
      }
      dispatchReference = DISPATCH.referenceState ? DISPATCH.referenceState(res.data && res.data.reference) : null;
      fillDispatchOptions(outlet);
    });
  }

  function fillDispatchOptions(outlet) {
    var ref = dispatchReference || { orders: [], drivers: [], trucks: [] };
    setSelectEntries(outlet, 'dispatchOrder', DISPATCH.optionEntries(ref.orders, 'order'), T('dispatch.orderPlaceholder'));
    setSelectEntries(outlet, 'dispatchDriver', DISPATCH.optionEntries(ref.drivers, 'driver'), T('dispatch.assignLater'));
    setSelectEntries(outlet, 'dispatchTruck', DISPATCH.optionEntries(ref.trucks, 'truck'), T('dispatch.assignLater'));
    var submit = dispatchNode(outlet, 'dispatchSubmit');
    if (submit) submit.disabled = ref.orders.length === 0;
    if (ref.orders.length === 0) dispatchMessage(outlet, 'dispatch.noOrders');
    syncDispatchCustomer(outlet);
  }

  /** The customer is a property of the order, so it is shown, never chosen. */
  function syncDispatchCustomer(outlet) {
    var orderId = fieldValue(outlet, 'dispatchOrder');
    var order = dispatchReference && DISPATCH.findById
      ? DISPATCH.findById(dispatchReference.orders, orderId)
      : null;
    var input = dispatchNode(outlet, 'dispatchCustomer');
    if (input) input.value = order && order.customer ? String(order.customer.name || '') : '';
  }

  function clearDispatchErrors(outlet) {
    for (var i = 0; i < DISPATCH_FIELD_ORDER.length; i++) {
      setMessage(dispatchNode(outlet, DISPATCH_FIELD_ERRORS[DISPATCH_FIELD_ORDER[i]]), '');
    }
    dispatchMessage(outlet, null);
  }

  function showDispatchFieldErrors(outlet, errors) {
    var focusField = null;
    for (var i = 0; i < DISPATCH_FIELD_ORDER.length; i++) {
      var field = DISPATCH_FIELD_ORDER[i];
      var key = errors ? errors[field] : null;
      if (key) {
        setMessage(dispatchNode(outlet, DISPATCH_FIELD_ERRORS[field]), T(key));
        if (!focusField) focusField = field;
      }
    }
    var input = focusField ? dispatchNode(outlet, DISPATCH_FIELD_INPUTS[focusField]) : null;
    if (input && input.focus) input.focus();
  }

  function resetDispatchForm(outlet) {
    var ids = ['dispatchOrder', 'dispatchDriver', 'dispatchTruck', 'dispatchRate', 'dispatchPlanned'];
    for (var i = 0; i < ids.length; i++) {
      var node = dispatchNode(outlet, ids[i]);
      if (node) node.value = '';
    }
    syncDispatchCustomer(outlet);
  }

  function submitDispatch(outlet) {
    if (!DISPATCH.validateDispatchForm) return;
    var orderId = fieldValue(outlet, 'dispatchOrder');
    var order = dispatchReference && DISPATCH.findById
      ? DISPATCH.findById(dispatchReference.orders, orderId)
      : null;
    var check = DISPATCH.validateDispatchForm({
      orderId: orderId,
      customerId: order && order.customer ? String(order.customer.id || '') : '',
      driverId: fieldValue(outlet, 'dispatchDriver'),
      truckId: fieldValue(outlet, 'dispatchTruck'),
      rateEur: fieldValue(outlet, 'dispatchRate'),
      plannedAt: fieldValue(outlet, 'dispatchPlanned')
    }, dispatchReference);

    clearDispatchErrors(outlet);
    if (!check.ok) {
      showDispatchFieldErrors(outlet, check.errors);
      dispatchMessage(outlet, 'dispatch.fixErrors');
      return;
    }

    var submit = dispatchNode(outlet, 'dispatchSubmit');
    if (submit) submit.disabled = true;
    request('/api/trips', { method: 'POST', token: session.token, body: check.payload }).then(function (res) {
      if (res.status === 401) { handleExpired(); return; }
      if (res.ok && res.data && res.data.trip) {
        if (submit) submit.disabled = false;
        resetDispatchForm(outlet);
        dispatchMessage(outlet, 'dispatch.created', { id: String(res.data.trip.id) }, 'success');
        return;
      }
      if (submit) submit.disabled = false;
      var detail = DISPATCH.errorDetail ? DISPATCH.errorDetail(res) : '';
      dispatchMessage(
        outlet,
        DISPATCH.createTripErrorKey ? DISPATCH.createTripErrorKey(res) : 'error.unexpected',
        detail ? { detail: detail } : null
      );
    });
  }

  /* ------------------------------------------------- dashboard (F2) --- */

  /**
   * The dashboard home (board task #33, FAv1-F2): a KPI strip, an alerts strip
   * and today's activity feed, all from `GET /api/dashboard`. The pure shaping
   * lives in `lib/dashboard.js`; this section only reads/writes the DOM and the
   * network. Dynamic element ids are resolved from the outlet.
   */

  /** Drill-down: switch to a filtered trips-list URL and render it in place. */
  function dashboardDrill(link) {
    if (!link) return;
    setPath(link, false);
    // skipUrl: the URL was just set with its query; `route` must not drop it.
    route({ path: link, push: true, skipUrl: true });
  }

  function bindDrillDowns(outlet) {
    var nodes = outlet.querySelectorAll ? outlet.querySelectorAll('[data-dash-link]') : [];
    for (var i = 0; i < nodes.length; i++) {
      (function (node) {
        node.addEventListener('click', function (ev) {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          dashboardDrill(node.getAttribute('data-dash-link'));
        });
      })(nodes[i]);
    }
    return nodes.length;
  }

  function renderDashboard(outlet, token) {
    if (!DASH.kpiCards) {
      outlet.innerHTML = '<h1>' + esc(T('overview.title')) + '</h1>' +
        '<p class="alert">' + esc(T('error.unexpected')) + '</p>';
      return;
    }

    // A driver may open Overview but holds no `reports:read`, so the dashboard
    // payload would be a 403 — send them to their own home instead.
    if (!(APP.canReadReports && APP.canReadReports(session.user && session.user.roleId))) {
      outlet.innerHTML =
        '<h1>' + esc(T('overview.title')) + '</h1>' +
        '<div class="empty-state">' +
          '<p class="title">' + esc(T('dashboard.driverTitle')) + '</p>' +
          '<p>' + esc(T('dashboard.driverBody')) + '</p>' +
          '<p><a class="primary-link" href="/app/my-trips" data-dash-link="/app/my-trips">' +
            esc(T('nav.myTrips')) + '</a></p>' +
        '</div>';
      bindDrillDowns(outlet);
      return;
    }

    outlet.innerHTML =
      '<h1>' + esc(T('overview.title')) + '</h1>' +
      '<p class="lead">' + esc(T('dashboard.lead')) + '</p>' +
      '<p class="alert" id="dashError" role="alert" hidden></p>' +
      '<div class="kpi-strip" id="kpiStrip"><p class="muted">' + esc(T('common.loading')) + '</p></div>' +
      '<h2 class="section-title">' + esc(T('dashboard.alertsTitle')) + '</h2>' +
      '<div id="dashAlerts" class="alert-strip"><p class="muted">' + esc(T('common.loading')) + '</p></div>' +
      '<h2 class="section-title">' + esc(T('dashboard.activityTitle')) + '</h2>' +
      '<div id="dashActivity"><p class="muted">' + esc(T('common.loading')) + '</p></div>';

    return request('/api/dashboard', { token: session.token }).then(function (res) {
      if (token !== renderToken) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        outlet.querySelector('#kpiStrip').innerHTML = '<p class="alert">' + esc(errorText(res)) + '</p>';
        outlet.querySelector('#dashAlerts').innerHTML = '';
        outlet.querySelector('#dashActivity').innerHTML = '';
        return;
      }
      renderDashboardBody(outlet, DASH.dashboardOf ? DASH.dashboardOf(res.data) : (res.data || {}));
    });
  }

  function renderDashboardBody(outlet, dashboard) {
    var cards = DASH.kpiCards(dashboard, T, i18n) || [];
    var strip = outlet.querySelector('#kpiStrip');
    if (strip) {
      var html = '';
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var inner = '<span class="kpi-label">' + esc(card.label) + '</span>' +
          '<span class="kpi-value' + (card.empty ? ' is-empty' : '') + '">' + esc(card.value) + '</span>' +
          (card.note ? '<span class="kpi-note">' + esc(card.note) + '</span>' : '');
        if (card.link) {
          html += '<a class="kpi" data-kpi="' + esc(card.id) + '" href="' + esc(card.link) +
            '" data-dash-link="' + esc(card.link) + '">' + inner + '</a>';
        } else {
          html += '<div class="kpi" data-kpi="' + esc(card.id) + '">' + inner + '</div>';
        }
      }
      strip.innerHTML = html;
    }

    var alerts = DASH.alertItems ? DASH.alertItems(dashboard, T, i18n) : [];
    var alertBox = outlet.querySelector('#dashAlerts');
    if (alertBox) {
      if (!alerts.length) {
        alertBox.innerHTML = '<p class="muted">' + esc(T('dashboard.noAlerts')) + '</p>';
      } else {
        var rows = '';
        for (var a = 0; a < alerts.length; a += 1) {
          var alert = alerts[a];
          var body = '<span class="alert-kind">' + esc(alert.text) + '</span>';
          rows += alert.link
            ? '<a class="alert-row sev-' + esc(alert.severity) + '" data-alert="' + esc(alert.id) +
              '" href="' + esc(alert.link) + '" data-dash-link="' + esc(alert.link) + '">' + body + '</a>'
            : '<div class="alert-row sev-' + esc(alert.severity) + '" data-alert="' + esc(alert.id) + '">' + body + '</div>';
        }
        alertBox.innerHTML = rows;
      }
    }

    var activity = DASH.activityItems ? DASH.activityItems(dashboard, T, i18n) : [];
    var feed = outlet.querySelector('#dashActivity');
    if (feed) {
      if (!activity.length) {
        feed.innerHTML = '<p class="muted">' + esc(T('dashboard.noActivity')) + '</p>';
      } else {
        var items = '';
        for (var e = 0; e < activity.length; e += 1) {
          var event = activity[e];
          var text = '<span class="act-what">' + esc(event.text) + '</span>' +
            '<span class="act-when">' + esc(event.when) + ' · ' + esc(event.actor) + '</span>';
          items += '<li data-activity="' + esc(event.id) + '">' + (event.link
            ? '<a href="' + esc(event.link) + '" data-dash-link="' + esc(event.link) +
              '" data-activity-link="' + esc(event.id) + '">' + text + '</a>'
            : text) + '</li>';
        }
        feed.innerHTML = '<ul class="activity">' + items + '</ul>';
      }
    }

    bindDrillDowns(outlet);
  }

  /* -------------------------------------------- documents list (F6) --- */

  /**
   * The Documents workspace (board task #37, FAv1-F6): the trips whose paperwork
   * matters right now, each linking into the trip-detail documents panel where
   * upload / verify / reject live. One request — the existing trips list — and
   * the same pure row shaping the trips screen uses.
   */
  function renderDocuments(outlet, token) {
    outlet.innerHTML =
      '<h1>' + esc(T('nav.documents')) + '</h1>' +
      '<p class="lead">' + esc(T('docs.lead')) + '</p>' +
      '<p class="alert" id="docsError" role="alert" hidden></p>' +
      '<div id="docsList"><p class="muted">' + esc(T('common.loading')) + '</p></div>';

    // Only the lifecycle stages where documentation is captured or checked.
    var path = TRIPVIEW.tripsPath
      ? TRIPVIEW.tripsPath({ status: 'LOADED,IN_TRANSIT,DELIVERED,POD_UPLOADED' })
      : '/api/trips?status=LOADED%2CIN_TRANSIT%2CDELIVERED%2CPOD_UPLOADED';
    return request(path, { token: session.token }).then(function (res) {
      if (token !== renderToken) return;
      var box = outlet.querySelector('#docsList');
      if (!box) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        var error = outlet.querySelector('#docsError');
        if (error) { error.textContent = errorText(res); error.hidden = false; }
        box.innerHTML = '';
        return;
      }
      box.innerHTML = docsWorklistHtml((res.data && res.data.trips) || []);
      bindDocsWorklist(outlet);
    });
  }

  function docsWorklistHtml(trips) {
    if (!trips.length) return '<div class="empty-state"><p>' + esc(T('docs.empty')) + '</p></div>';
    var rows = trips.map(function (trip) {
      var row = TRIPVIEW.tripRow ? TRIPVIEW.tripRow(trip) : { id: trip.id, status: trip.status };
      return '<tr>' +
        '<td><a href="/app/trips/' + esc(row.id) + '" data-doc-trip="' + esc(row.id) + '">' +
          esc(row.origin || '?') + ' → ' + esc(row.destination || '?') + '</a></td>' +
        '<td>' + esc(row.driver || T('trips.none')) + '</td>' +
        '<td><span class="status s-' + esc(row.status) + '">' + esc(statusLabel(row.status)) + '</span></td>' +
        '</tr>';
    }).join('');
    return '<table class="trips-table"><thead><tr>' +
      '<th>' + esc(T('trips.colRoute')) + '</th><th>' + esc(T('trips.colDriver')) +
      '</th><th>' + esc(T('trips.colStatus')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function bindDocsWorklist(outlet) {
    var links = outlet.querySelectorAll ? outlet.querySelectorAll('a[data-doc-trip]') : [];
    for (var i = 0; i < links.length; i += 1) {
      (function (link) {
        link.addEventListener('click', function (ev) {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          route({ path: link.getAttribute('href'), push: true });
        });
      })(links[i]);
    }
  }

  /* ------------------------------------------- tracking workspace (F8) --- */

  /**
   * The tracking-links workspace (board task #39, FAv1-F8). Lists the org's
   * trips with the link state the API reports (a boolean + expiry, never the
   * token) and offers the same mint/revoke actions; the one-action copy appears
   * for the link just minted here. The full URL is always visible on the trip
   * detail, which is the token's only authenticated surface.
   */

  /** The link just minted from the workspace, for the one-action copy. */
  var workLink = null;

  function renderTracking(outlet, token) {
    outlet.innerHTML =
      '<h1>' + esc(T('nav.tracking')) + '</h1>' +
      '<p class="lead">' + esc(T('tracking.lead')) + '</p>' +
      '<p class="alert" id="trackWorkMessage" role="alert" hidden></p>' +
      '<div id="trackWorkLink"></div>' +
      '<div id="trackList"><p class="muted">' + esc(T('common.loading')) + '</p></div>';
    workLink = null;
    return loadTrackingList(outlet, token);
  }

  function loadTrackingList(outlet, token) {
    return request('/api/trips', { token: session.token }).then(function (res) {
      if (token !== renderToken) return;
      var box = outlet.querySelector ? outlet.querySelector('#trackList') : null;
      if (!box) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        setTrackWorkMessage(outlet, errorText(res), '');
        box.innerHTML = '';
        return;
      }
      box.innerHTML = trackingWorklistHtml((res.data && res.data.trips) || []);
      bindTrackingWorklist(outlet, token);
    });
  }

  function setTrackWorkMessage(outlet, message, kind) {
    var node = outlet.querySelector ? outlet.querySelector('#trackWorkMessage') : null;
    if (!node) return;
    if (!message) {
      node.textContent = '';
      node.hidden = true;
      node.className = 'alert';
      return;
    }
    node.textContent = message;
    node.className = 'alert' + (kind ? ' ' + kind : '');
    node.hidden = false;
  }

  function trackingWorklistHtml(trips) {
    if (!trips.length) {
      return '<div class="empty-state"><p>' + esc(T('tracking.empty')) + '</p></div>';
    }
    var rows = trips.map(function (trip) {
      var row = TRIPVIEW.tripRow ? TRIPVIEW.tripRow(trip) : { id: trip.id, status: trip.status };
      var tracking = trip.tracking || {};
      var state = tracking.active
        ? T('tracking.state.activeUntil', { date: fmtDate(tracking.expiresAt) })
        : T('tracking.state.none');
      var action = tracking.active
        ? '<button class="ghost danger" type="button" data-track-revoke="' + esc(row.id) + '">' +
            esc(T('tracking.revoke')) + '</button>'
        : '<button class="ghost" type="button" data-track-mint="' + esc(row.id) + '">' +
            esc(T('tracking.mint')) + '</button>';
      return '<tr>' +
        '<td><a href="/app/trips/' + esc(row.id) + '" data-track-trip="' + esc(row.id) + '">' +
          esc(row.origin || '?') + ' → ' + esc(row.destination || '?') + '</a></td>' +
        '<td>' + esc(row.driver || T('trips.none')) + '</td>' +
        '<td><span class="status s-' + esc(row.status) + '">' + esc(statusLabel(row.status)) + '</span></td>' +
        '<td class="track-state-cell' + (tracking.active ? ' active' : '') + '">' + esc(state) + '</td>' +
        '<td class="track-actions">' + action + '</td>' +
        '</tr>';
    }).join('');
    return '<div class="doc-table-wrap"><table class="trips-table"><thead><tr>' +
      '<th>' + esc(T('trips.colRoute')) + '</th><th>' + esc(T('trips.colDriver')) +
      '</th><th>' + esc(T('trips.colStatus')) + '</th><th>' + esc(T('tracking.colState')) +
      '</th><th>' + esc(T('tracking.colActions')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function bindTrackingWorklist(outlet, token) {
    var links = outlet.querySelectorAll ? outlet.querySelectorAll('a[data-track-trip]') : [];
    for (var i = 0; i < links.length; i += 1) {
      (function (link) {
        link.addEventListener('click', function (ev) {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          route({ path: link.getAttribute('href'), push: true });
        });
      })(links[i]);
    }
    var mints = outlet.querySelectorAll ? outlet.querySelectorAll('button[data-track-mint]') : [];
    for (var m = 0; m < mints.length; m += 1) {
      (function (button) {
        button.addEventListener('click', function (ev) {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          mintWorkLink(outlet, button.getAttribute('data-track-mint'), button, token);
        });
      })(mints[m]);
    }
    var revokes = outlet.querySelectorAll ? outlet.querySelectorAll('button[data-track-revoke]') : [];
    for (var r = 0; r < revokes.length; r += 1) {
      (function (button) {
        button.addEventListener('click', function (ev) {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          revokeWorkLink(outlet, button.getAttribute('data-track-revoke'), button, token);
        });
      })(revokes[r]);
    }
  }

  function mintWorkLink(outlet, tripId, button, token) {
    if (button) button.disabled = true;
    setTrackWorkMessage(outlet, T('tracking.minting'), '');
    request(TRACK.trackingPath(tripId), { method: 'POST', token: session.token }).then(function (res) {
      if (token !== renderToken) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        setTrackWorkMessage(outlet, trackErrorText(res), '');
        if (button) button.disabled = false;
        return;
      }
      workLink = TRACK.linkFrom ? TRACK.linkFrom(res.data) : null;
      showWorkLink(outlet);
      setTrackWorkMessage(outlet, T('tracking.minted'), 'success');
      return loadTrackingList(outlet, token);
    });
  }

  function revokeWorkLink(outlet, tripId, button, token) {
    if (typeof win.confirm === 'function' && !win.confirm(T('tracking.confirmRevoke'))) return;
    if (button) button.disabled = true;
    request(TRACK.trackingPath(tripId), { method: 'DELETE', token: session.token }).then(function (res) {
      if (token !== renderToken) return;
      if (res.status === 401) { handleExpired(); return; }
      if (!res.ok) {
        setTrackWorkMessage(outlet, trackErrorText(res), '');
        if (button) button.disabled = false;
        return;
      }
      setTrackWorkMessage(outlet, T('tracking.revoked'), 'success');
      return loadTrackingList(outlet, token);
    });
  }

  function showWorkLink(outlet) {
    var box = outlet.querySelector ? outlet.querySelector('#trackWorkLink') : null;
    if (!box) return;
    var url = TRACK.copyTarget ? TRACK.copyTarget(workLink) : '';
    if (!url) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="track-result"><div class="track-link-row">' +
      '<input class="track-url" id="trackWorkUrl" type="text" readonly value="' + esc(url) + '">' +
      '<button class="ghost" type="button" id="trackWorkCopy">' + esc(T('tracking.copy')) + '</button>' +
      '</div></div>';
    var copy = outlet.querySelector('#trackWorkCopy');
    if (copy) {
      copy.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        copyWorkLink(outlet);
      });
    }
  }

  function copyWorkLink(outlet) {
    var url = TRACK.copyTarget ? TRACK.copyTarget(workLink) : '';
    if (!url) return;
    var input = outlet.querySelector ? outlet.querySelector('#trackWorkUrl') : null;
    var after = function (ok) {
      if (ok) setTrackWorkMessage(outlet, T('tracking.copied'), 'success');
      else {
        if (input && input.focus) input.focus();
        if (input && input.select) input.select();
        setTrackWorkMessage(outlet, T('tracking.copyManual'), '');
      }
    };
    if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { after(true); }, function () { after(false); });
      return;
    }
    var ok = false;
    if (input && input.select) {
      input.focus();
      input.select();
      try {
        ok = typeof document !== 'undefined' && document.execCommand
          ? Boolean(document.execCommand('copy'))
          : false;
      } catch (err) {
        ok = false;
      }
    }
    after(ok);
  }

  function showLogin(messageKey) {
    setHidden('appView', true);
    setHidden('loginView', false);
    hide('globalError');
    var submit = el('loginSubmit');
    if (submit) submit.disabled = false;
    if (messageKey) show('loginError', T(messageKey));
    else hide('loginError');
    var email = el('email');
    if (email && email.focus) email.focus();
  }

  function showApp() {
    setHidden('loginView', true);
    setHidden('appView', false);
    hide('loginError');
    var user = session.user || {};
    setText('whoName', user.name || '');
    setText('whoRole', T(APP.roleKey(user.roleId)));
    var badge = el('whoRole');
    if (badge && badge.classList) badge.classList.add('role-badge');
  }

  /**
   * Remember the route the person was trying to reach, so a successful login
   * returns them there when their role may open it.
   */
  function rememberIntent(path) {
    if (APP.isAppPath(path) && !APP.isLoginPath(path)) pendingPath = path;
  }

  /* -------------------------------------------------------------- guard --- */

  /**
   * Decide and apply. `push` is true for in-app navigation (history entry),
   * false for a cold load (replace, so the back button does not bounce).
   * @returns {{ action: string, route?: any }}
   */
  function route(options) {
    var opts = options || {};
    var path = opts.path || currentPath();
    var sys = { role: session.user && session.user.roleId, hasToken: Boolean(session.token) };
    var decision = APP.guardDecision({ path: path, hasToken: sys.hasToken, role: sys.role });

    if (decision.action === 'login') {
      if (APP.isAppPath(path) && !APP.isLoginPath(path)) rememberIntent(path);
      setPath(APP.LOGIN_PATH, true);
      showLogin(null);
      return decision;
    }
    if (decision.action === 'home') {
      setPath(decision.to, true);
      showApp();
      renderNav(sys.role, { path: decision.to });
      renderPanel(APP.routeForPath(decision.to));
      return decision;
    }
    if (decision.action === 'redirect') {
      setPath(decision.to, true);
      showApp();
      renderNav(sys.role, { path: decision.to });
      renderPanel(APP.routeForPath(decision.to));
      return decision;
    }
    // render
    if (!sys.hasToken) {
      setPath(APP.LOGIN_PATH, true);
      showLogin(null);
      return decision;
    }
    if (!opts.skipUrl) {
      // Board task #34: the trips list keeps its filters in the URL, so a
      // reload or a shared link restores them. Only a render that stays on the
      // same path keeps the query; a redirect/home target drops it.
      var target = decision.route && decision.route.path ? decision.route.path : path;
      var search = (typeof location !== 'undefined' && location.search) ? location.search : '';
      var samePath = APP.normalizePath(target) === APP.normalizePath(path);
      setPath(samePath ? target + search : target, opts.push === true ? false : true);
    }
    showApp();
    renderNav(sys.role, decision.route);
    renderPanel(decision.route);
    return decision;
  }

  /* -------------------------------------------------------------- login --- */

  function login(email, password) {
    if (!email || !password) {
      show('loginError', T('error.requiredFields'));
      return Promise.resolve({ ok: false });
    }
    var submit = el('loginSubmit');
    if (submit) submit.disabled = true;
    return request('/api/auth/login', { method: 'POST', body: { email: email, password: password } })
      .then(function (res) {
        if (submit) submit.disabled = false;
        if (!res.ok || !res.data || !res.data.token) {
          showLogin(APP.errorKey(res.data && res.data.error, res.status));
          return { ok: false, status: res.status };
        }
        session = { token: res.data.token, user: res.data.user || null };
        writeSession(session.token, session.user);
        if (i18n && typeof i18n.setUser === 'function') i18n.setUser(res.data.user || {});
        var role = session.user && session.user.roleId;
        var target = pendingPath && APP.canOpen(role, pendingPath)
          ? pendingPath
          : (APP.ROLE_HOME[role] || APP.HOME_PATH);
        pendingPath = null;
        setPath(target, true);
        showApp();
        renderNav(role, { path: target });
        renderPanel(APP.routeForPath(target));
        return { ok: true, status: res.status, user: session.user };
      });
  }

  function logout() {
    session = { token: '', user: null };
    pendingPath = null;
    clearSession();
    setPath(APP.LOGIN_PATH, true);
    showLogin(null);
    if (typeof document !== 'undefined') document.title = T('login.title');
    return true;
  }

  /* --------------------------------------------------------------- boot --- */

  function bindEvents() {
    var form = el('loginForm');
    if (form) {
      form.addEventListener('submit', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        hide('loginError');
        var email = (el('email') || {}).value || '';
        var password = (el('password') || {}).value || '';
        login(String(email).trim(), String(password));
      });
    }
    var logoutBtn = el('logout');
    if (logoutBtn) logoutBtn.addEventListener('click', function () { logout(); });

    if (typeof win.addEventListener === 'function') {
      // A back navigation (or a bfcache restore) re-runs the guard, so a page
      // signed out in this tab can never be revisited from history.
      win.addEventListener('popstate', function () { route({ skipUrl: true }); });
      win.addEventListener('pageshow', function (ev) {
        if (ev && ev.persisted) route({ skipUrl: true });
      });
    }
  }

  /** Establish the session from storage, verifying the token with the API. */
  function restoreSession() {
    var stored = readSession();
    session = stored;
    if (!stored.token) return Promise.resolve({ action: 'login' });
    return request('/api/auth/me', { token: stored.token }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        clearSession();
        session = { token: '', user: null };
        return { action: 'expired' };
      }
      if (res.ok && res.data && res.data.user) {
        session = { token: stored.token, user: res.data.user };
        writeSession(session.token, session.user);
        return { action: 'render' };
      }
      // Network/unknown: keep the stored session but say so rather than
      // silently signing the person out.
      return { action: 'error' };
    });
  }

  function boot() {
    var base = APP.APP_BASE + '/locales/';
    if (i18nUI && typeof i18nUI.init === 'function') {
      var mount = el('langSlot');
      i18n = null;
      i18nUI.init({
        mount: mount,
        base: base,
        navigatorLanguages: typeof navigator !== 'undefined' ? navigator.languages || navigator.language : null,
        onApply: function (instance) {
          i18n = instance;
          T = function (key, params) { return instance.t(key, params); };
          var outlet = el('outlet');
          if (outlet && outlet.innerHTML) {
            var decision = APP.guardDecision({
              path: currentPath(),
              hasToken: Boolean(session.token),
              role: session.user && session.user.roleId,
            });
            if (decision.action === 'render' || decision.action === 'redirect' || decision.action === 'home') {
              renderNav(session.user && session.user.roleId, decision.route || { path: currentPath() });
              renderPanel(decision.route || APP.routeForPath(currentPath()));
            }
          }
        },
      });
    }
    bindEvents();
    rememberIntent(currentPath());
    return restoreSession().then(function (state) {
      if (state.action === 'login') {
        setPath(APP.LOGIN_PATH, true);
        showLogin(null);
        return { action: 'login' };
      }
      if (state.action === 'expired') {
        setPath(APP.LOGIN_PATH, true);
        showLogin('error.sessionExpired');
        return { action: 'expired' };
      }
      if (state.action === 'error') {
        setPath(APP.LOGIN_PATH, true);
        showLogin(null);
        show('loginError', T('error.loadFailed'));
        return { action: 'error' };
      }
      return route();
    });
  }

  var api = {
    boot: boot,
    route: route,
    login: login,
    logout: logout,
    renderNav: renderNav,
    renderPanel: renderPanel,
    showLogin: showLogin,
    showApp: showApp,
    readSession: readSession,
    clearSession: clearSession,
    session: function () { return session; },
    i18n: function () { return i18n; },
  };
  api._setSession = function (token, user) { session = { token: token, user: user || null }; };
  // Test seams for the scratch DOM-free harness (board task #37): the renderers
  // are otherwise closure-private, and the pure modules cannot exercise the
  // markup that carries the role gate.
  api._documentsPanelHtml = documentsPanelHtml;
  api._docsWorklistHtml = docsWorklistHtml;
  // Test seams for the scratch DOM-free harness (board task #39): the tracking
  // renderers are closure-private too, and the pure module cannot exercise the
  // role gate or the "state only, never the token" list markup.
  api._trackingPanelHtml = trackingPanelHtml;
  api._trackingWorklistHtml = trackingWorklistHtml;

  if (typeof document !== 'undefined') {
    boot();
  }

  return api;
});
