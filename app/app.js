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
  var TRIPVIEW = TRIPS || {};
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

    html += '<h2 class="section-title">' + esc(T('trips.timeline')) + '</h2>' + timelineHtml(trip.statusEvents || []);
    html += '<h2 class="section-title">' + esc(T('trips.documents')) + '</h2>' + documentsHtml(trip.documents || []);
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
      return '<li>' +
        '<div class="tl-what">' + esc(statusLabel(event.from)) + ' → ' + esc(statusLabel(event.to)) + '</div>' +
        '<div class="tl-when">' + esc(fmtDate(event.at)) + ' · ' + esc(actor) + '</div>' +
        '</li>';
    }).join('');
    return '<ul class="timeline">' + items + '</ul>';
  }

  function documentsHtml(documents) {
    if (!documents.length) return '<p class="empty">' + esc(T('trips.noDocuments')) + '</p>';
    var rows = documents.map(function (d) {
      return '<tr><td>' + esc(T('trips.doctype.' + d.docType)) + '</td>' +
        '<td>' + esc(T('trips.docstatus.' + d.status)) + '</td>' +
        '<td>' + esc(fmtDate(d.uploadedAt)) + '</td></tr>';
    }).join('');
    return '<table class="trips-table"><thead><tr>' +
      '<th>' + esc(T('trips.docType')) + '</th><th>' + esc(T('trips.docStatus')) + '</th><th>' + esc(T('trips.docUploaded')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
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

  function renderTripDetail(outlet, route_, token) {
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
      box.innerHTML = tripDetailHtml((res.data && res.data.trip) || {});
    });
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

  if (typeof document !== 'undefined') {
    boot();
  }

  return api;
});
