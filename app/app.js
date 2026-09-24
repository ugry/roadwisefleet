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
  var api = factory(root, root.RoadwiseAppCore, root.RoadwiseI18nUI);
  root.RoadwiseApp = api;
})(typeof window !== 'undefined' ? window : globalThis, function (win, core, i18nUI) {
  'use strict';

  var APP = core || {};
  // The pure create-trip form logic (board task #35, F4), loaded as a classic
  // script before this one. Everything missing here is a no-op, never a crash.
  var DISPATCH = win && win.RoadwiseDispatch ? win.RoadwiseDispatch : {};
  var T = function (key, params) { return key; };
  var i18n = null;
  var session = { token: '', user: null };
  /** The route the person asked for before being sent to login (if any). */
  var pendingPath = null;

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
    if (route && route.view === 'dispatch') {
      renderDispatch(outlet);
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
    rateEur: 'dispatchRateError'
  };
  /** The control each field error belongs to (focus target after a failed submit). */
  var DISPATCH_FIELD_INPUTS = {
    orderId: 'dispatchOrder',
    driverId: 'dispatchDriver',
    truckId: 'dispatchTruck',
    rateEur: 'dispatchRate'
  };
  /** Submit order for the "what went wrong" summary. */
  var DISPATCH_FIELD_ORDER = ['orderId', 'customerId', 'driverId', 'truckId', 'rateEur'];

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
    var ids = ['dispatchOrder', 'dispatchDriver', 'dispatchTruck', 'dispatchRate'];
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
      rateEur: fieldValue(outlet, 'dispatchRate')
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
    if (!opts.skipUrl) setPath(decision.route && decision.route.path ? decision.route.path : path, opts.push === true ? false : true);
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
