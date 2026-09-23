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
