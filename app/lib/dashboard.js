/**
 * RoadwiseFleet Fleet Manager — dashboard view model (board task #33, FAv1-F2).
 *
 * The pure half of the app home: it turns the `GET /api/dashboard` payload into
 * the KPI cards, the alert rows and the activity rows the shell renders. Loaded
 * twice, on purpose, exactly like `app-core.js`:
 *
 *   - in the browser, as a classic script (`<script src="lib/dashboard.js">`),
 *     exposing `window.RoadwiseDashboard`;
 *   - in the API test suite (`apps/api/src/dashboard-view.test.js`), so the
 *     shaping and the labels are covered by `node --test apps/api/src/` with no
 *     install and no browser.
 *
 * Nothing here touches the DOM, the network, storage or the clock: the payload
 * already carries its timestamps. ES5-compatible syntax: the app targets cheap
 * Android WebViews.
 *
 * IMPORTANT: this module never invents a number. A KPI the server did not send
 * (or sent as `null`, e.g. on-time % with no comparable trip) renders as the
 * "no data" placeholder, never as 0.
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseDashboard = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The KPI strip, in display order. */
  var KPI_ORDER = ['activeTrips', 'onTimePct', 'pendingPayEur'];

  /** The catalogue key for a KPI label. */
  var KPI_LABELS = {
    activeTrips: 'dashboard.kpi.activeTrips',
    onTimePct: 'dashboard.kpi.onTime',
    pendingPayEur: 'dashboard.kpi.pendingPay'
  };

  /** Alert kind → catalogue key. */
  var ALERT_KEYS = {
    trip_unassigned: 'dashboard.alert.unassigned',
    document_expired: 'dashboard.alert.documentExpired',
    document_expiring: 'dashboard.alert.documentExpiring',
    settlement_pending: 'dashboard.alert.settlementPending'
  };

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function isNum(value) {
    return value !== null && value !== undefined && value !== '' && isFinite(Number(value));
  }

  /** Unwrap `{ dashboard: {...} }` so callers can pass either shape. */
  function dashboardOf(payload) {
    if (payload && typeof payload === 'object' && payload.dashboard && typeof payload.dashboard === 'object') {
      return payload.dashboard;
    }
    return payload && typeof payload === 'object' ? payload : {};
  }

  /** The catalogue key for a trip status pill (shared wording with the trips list). */
  function statusKey(status) {
    return 'trips.status.' + text(status);
  }

  /**
   * Format an on-time percentage (the server sends 0–100, or null). Returns
   * `null` when there is no value, so the caller can show its own placeholder.
   * @param {unknown} value
   * @param {{ percent?: (n: number) => string }} [i18n]
   * @returns {string|null}
   */
  function onTimeText(value, i18n) {
    if (!isNum(value)) return null;
    var n = Number(value);
    if (i18n && typeof i18n.percent === 'function') {
      var formatted = i18n.percent(n / 100);
      if (formatted) return formatted;
    }
    return (Math.round(n * 10) / 10) + '%';
  }

  /** Format a euro amount (the server sends a number). */
  function moneyText(value, i18n) {
    if (!isNum(value)) return null;
    if (i18n && typeof i18n.currency === 'function') {
      var formatted = i18n.currency(Number(value), 'EUR');
      if (formatted) return formatted;
    }
    return (Math.round(Number(value) * 100) / 100) + ' €';
  }

  /** Format a count. */
  function countText(value) {
    if (!isNum(value)) return '0';
    return String(Number(value));
  }

  /**
   * The KPI cards, in display order, with the link each one drills into.
   * A missing value renders as the placeholder (`trips.none`), never a 0.
   * @param {any} payload
   * @param {(key: string, params?: any) => string} t
   * @param {{ percent?: Function, currency?: Function }} [i18n]
   * @returns {Array<{ id: string, label: string, value: string, note: string|null, link: string|null, empty: boolean }>}
   */
  function kpiCards(payload, t, i18n) {
    var translate = typeof t === 'function' ? t : function (key) { return key; };
    var dash = dashboardOf(payload);
    var kpis = dash.kpis || {};
    var cards = [];

    for (var i = 0; i < KPI_ORDER.length; i++) {
      var id = KPI_ORDER[i];
      var kpi = kpis[id] || {};
      var value = null;
      var note = null;
      var empty = false;

      if (id === 'activeTrips') {
        value = countText(kpi.value);
        note = translate('dashboard.kpi.activeTripsNote');
      } else if (id === 'onTimePct') {
        if (isNum(kpi.sample) && Number(kpi.sample) > 0) {
          value = onTimeText(kpi.value, i18n);
          note = translate('dashboard.kpi.onTimeNote', {
            onTime: countText(kpi.onTime),
            sample: countText(kpi.sample)
          });
        }
      } else if (id === 'pendingPayEur') {
        // Always a DB aggregate: 0 when nothing is invoiced, never invented.
        value = moneyText(kpi.value, i18n);
        note = translate('dashboard.kpi.pendingPayNote', { count: countText(kpi.count) });
      }

      if (value === null) {
        value = translate('trips.none');
        empty = true;
      }

      cards.push({
        id: id,
        label: translate(KPI_LABELS[id]),
        value: value,
        note: note,
        link: typeof kpi.link === 'string' && kpi.link ? kpi.link : null,
        empty: empty
      });
    }
    return cards;
  }

  /**
   * One alert row per server alert, each linking to the trip it names. The text
   * is built from the alert's own fields; nothing is inferred.
   * @param {any} payload
   * @param {(key: string, params?: any) => string} t
   * @param {{ currency?: Function, dateTime?: Function }} [i18n]
   * @returns {Array<{ id: string, kind: string, severity: string, text: string, link: string|null }>}
   */
  function alertItems(payload, t, i18n) {
    var translate = typeof t === 'function' ? t : function (key) { return key; };
    var dash = dashboardOf(payload);
    var alerts = Array.isArray(dash.alerts) ? dash.alerts : [];
    var items = [];

    for (var i = 0; i < alerts.length; i++) {
      var alert = alerts[i] || {};
      var key = ALERT_KEYS[alert.kind] || 'dashboard.alert.generic';
      var params = {
        route: text(alert.route),
        trip: text(alert.tripId),
        docType: alert.docType ? translate('trips.doctype.' + alert.docType) : '',
        date: dateText(alert.expiresAt, i18n),
        amount: moneyText(alert.amountEur, i18n) || ''
      };
      items.push({
        id: text(alert.id),
        kind: text(alert.kind),
        severity: alert.severity === 'high' ? 'high' : 'medium',
        text: translate(key, params),
        link: typeof alert.link === 'string' && alert.link ? alert.link : null
      });
    }
    return items;
  }

  /**
   * The today feed, newest first as the server sent it, each row linking to its
   * trip.
   * @param {any} payload
   * @param {(key: string, params?: any) => string} t
   * @param {{ dateTime?: Function }} [i18n]
   * @returns {Array<{ id: string, text: string, actor: string, when: string, link: string|null }>}
   */
  function activityItems(payload, t, i18n) {
    var translate = typeof t === 'function' ? t : function (key) { return key; };
    var dash = dashboardOf(payload);
    var activity = Array.isArray(dash.activity) ? dash.activity : [];
    var items = [];

    for (var i = 0; i < activity.length; i++) {
      var event = activity[i] || {};
      var from = translate(statusKey(event.from));
      var to = translate(statusKey(event.to));
      var actor = event.actor && event.actor.name
        ? event.actor.name
        : translate('trips.actorSystem');
      items.push({
        id: text(event.id),
        text: from + ' → ' + to,
        actor: actor,
        when: dateText(event.at, i18n),
        link: typeof event.link === 'string' && event.link ? event.link : null
      });
    }
    return items;
  }

  /** Format an ISO timestamp, or '' when there is none. */
  function dateText(value, i18n) {
    if (!value) return '';
    if (i18n && typeof i18n.dateTime === 'function') {
      var formatted = i18n.dateTime(value);
      if (formatted) return formatted;
    }
    return text(value);
  }

  /**
   * The truthful empty-state decision for the whole home: which strips have
   * content. Used so the page can say "nothing needs attention" instead of
   * rendering empty boxes.
   */
  function hasContent(payload) {
    var dash = dashboardOf(payload);
    var kpis = dash.kpis || {};
    return {
      kpis: Boolean(kpis.activeTrips || kpis.onTimePct || kpis.pendingPayEur),
      alerts: Array.isArray(dash.alerts) && dash.alerts.length > 0,
      activity: Array.isArray(dash.activity) && dash.activity.length > 0,
      anywhere:
        Array.isArray(dash.alerts) && dash.alerts.length > 0 ||
        Array.isArray(dash.activity) && dash.activity.length > 0
    };
  }

  return {
    KPI_ORDER: KPI_ORDER,
    KPI_LABELS: KPI_LABELS,
    ALERT_KEYS: ALERT_KEYS,
    dashboardOf: dashboardOf,
    statusKey: statusKey,
    onTimeText: onTimeText,
    moneyText: moneyText,
    countText: countText,
    dateText: dateText,
    kpiCards: kpiCards,
    alertItems: alertItems,
    activityItems: activityItems,
    hasContent: hasContent
  };
});
