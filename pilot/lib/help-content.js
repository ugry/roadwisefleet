/**
 * RoadwiseFleet help content (board #138, UXF-DOC2 + FAv1-SUP2b).
 *
 * One page, two mounts: `/app/help` (Fleet Manager) and `/pilot/help.html`
 * (pilot + driver). The *content* lives here once — a table of sections whose
 * every visible string is an i18n key — so the two surfaces cannot drift and a
 * new language only has to translate the catalogue, never this file.
 *
 * Loaded twice, on purpose, like `pilot/lib/i18n.js`:
 *   - in the browser as a classic script (`<script src="/pilot/lib/help-content.js">`),
 *     which exposes `window.RoadwiseHelpContent`;
 *   - in the API test suite (`apps/api/src/help-content.test.js`), which asserts
 *     every key exists in every catalogue (EN/DE/PL/TR) and that no help string
 *     promises a feature the pilot does not ship (board #135 R50).
 *
 * Nothing here touches the DOM, the network, storage or the clock. ES5-compatible
 * syntax: the pilot targets cheap Android WebViews.
 *
 * Copy rules (issue #138):
 *   - no invented claims: every statement is grounded in a shipped screen
 *     (`app/lib/*`, `pilot/*.html`, `apps/api/src/track-page.js`,
 *     `apps/api/src/trip-status.js`);
 *   - no promise of notifications, SMS or WhatsApp (R50 — the transport is not
 *     installed in the pilot);
 *   - the status list is rendered from the catalogue's existing `status.*` /
 *     `trips.status.*` labels, so a status cannot appear here unlabelled.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseHelpContent = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Per-surface wiring. `statusPrefix` is the key family the catalogue of that
   * surface uses for a trip status: the pilot catalogue keys `status.DRAFT`, the
   * Fleet Manager catalogue keys `trips.status.DRAFT`.
   */
  var SURFACES = {
    app: {
      localesBase: '/app/locales/',
      backHref: '/app/',
      backKey: 'help.backApp',
      statusPrefix: 'trips.status.'
    },
    pilot: {
      localesBase: '/pilot/locales/',
      backHref: 'index.html',
      backKey: 'help.backPilot',
      statusPrefix: 'status.'
    }
  };

  /**
   * The trip status sequence, in order. Mirrors `apps/api/src/trip-status.js`
   * (`TRIP_STATUSES`); `help-content.test.js` fails if the two lists drift.
   * @type {readonly string[]}
   */
  var HELP_STATUSES = [
    'DRAFT',
    'ASSIGNED',
    'EN_ROUTE',
    'AT_PICKUP',
    'LOADED',
    'IN_TRANSIT',
    'AT_DELIVERY',
    'DELIVERED',
    'POD_UPLOADED',
    'INVOICED',
    'SETTLED',
    'REFUSED',
    'BREAKDOWN',
    'DELAYED',
    'CUSTOMS_HOLD',
    'CANCELLED'
  ];

  /**
   * The sections, in reading order. `items` are i18n keys for one paragraph
   * each; `statusList` renders the status chain between the section's items.
   * @type {ReadonlyArray<{id: string, titleKey: string, items: string[], statusList?: boolean}>}
   */
  var TOPICS = [
    {
      id: 'start',
      titleKey: 'help.start.title',
      items: ['help.start.signIn', 'help.start.roles', 'help.start.language', 'help.start.offline']
    },
    {
      id: 'statuses',
      titleKey: 'help.statuses.title',
      statusList: true,
      items: ['help.statuses.note']
    },
    {
      id: 'trips',
      titleKey: 'help.trips.title',
      items: ['help.trips.create', 'help.trips.assign', 'help.trips.next', 'help.trips.documents']
    },
    {
      id: 'track',
      titleKey: 'help.track.title',
      items: ['help.track.create', 'help.track.what', 'help.track.expiry', 'help.track.customer']
    },
    {
      id: 'solo',
      titleKey: 'help.solo.title',
      items: ['help.solo.signUp', 'help.solo.beacon', 'help.solo.offers', 'help.solo.jobs', 'help.solo.customers']
    },
    {
      id: 'customer',
      titleKey: 'help.customer.title',
      items: ['help.customer.open', 'help.customer.shows', 'help.customer.pod', 'help.customer.expired']
    },
    {
      id: 'faq',
      titleKey: 'help.faq.title',
      items: ['help.faq.status', 'help.faq.stuck', 'help.faq.notifications']
    }
  ];

  /** Every key this page renders, for the catalogue parity test. */
  function helpKeys() {
    var keys = [
      'help.title',
      'help.documentTitle',
      'help.lead',
      'help.toc',
      'help.contact',
      'help.backApp',
      'help.backPilot',
      'help.open',
      'help.openNoSignIn'
    ];
    for (var i = 0; i < TOPICS.length; i += 1) {
      keys.push(TOPICS[i].titleKey);
      for (var j = 0; j < TOPICS[i].items.length; j += 1) keys.push(TOPICS[i].items[j]);
    }
    return keys;
  }

  /** Escape text for both element content and a double-quoted attribute. */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Render the help body for a surface.
   * @param {string} surface `'app'` or `'pilot'`
   * @param {(key: string) => string} t translator (the i18n instance's `t`)
   * @returns {string} HTML for the page's `#helpBody`
   */
  function renderHelp(surface, t) {
    var cfg = SURFACES[surface] || SURFACES.pilot;
    var translate = typeof t === 'function' ? t : function (key) { return key; };

    var toc = ['<nav class="help-toc" aria-label="' + esc(translate('help.toc')) + '">',
      '<p class="section-title">' + esc(translate('help.toc')) + '</p><ul>'];
    for (var i = 0; i < TOPICS.length; i += 1) {
      toc.push('<li><a href="#help-' + esc(TOPICS[i].id) + '">' + esc(translate(TOPICS[i].titleKey)) + '</a></li>');
    }
    toc.push('</ul></nav>');

    var body = [];
    for (var n = 0; n < TOPICS.length; n += 1) {
      var topic = TOPICS[n];
      body.push('<section class="help-section" id="help-' + esc(topic.id) + '">');
      body.push('<h2>' + esc(translate(topic.titleKey)) + '</h2>');
      var paragraphs = [];
      for (var p = 0; p < topic.items.length; p += 1) {
        paragraphs.push('<li>' + esc(translate(topic.items[p])) + '</li>');
      }
      if (topic.statusList) {
        var rows = [];
        for (var s = 0; s < HELP_STATUSES.length; s += 1) {
          rows.push('<li>' + esc(translate(cfg.statusPrefix + HELP_STATUSES[s])) + '</li>');
        }
        body.push('<ol class="help-statuses">' + rows.join('') + '</ol>');
      }
      if (paragraphs.length) body.push('<ul class="help-items">' + paragraphs.join('') + '</ul>');
      body.push('</section>');
    }

    return toc.join('') + body.join('');
  }

  return {
    SURFACES: SURFACES,
    HELP_STATUSES: HELP_STATUSES,
    TOPICS: TOPICS,
    helpKeys: helpKeys,
    renderHelp: renderHelp,
    esc: esc
  };
});
