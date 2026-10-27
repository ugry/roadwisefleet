/**
 * Help page boot (board #138, UXF-DOC2 + FAv1-SUP2b).
 *
 * The one script both help mounts load (`/app/help` and `/pilot/help.html`).
 * It does exactly three things:
 *
 *   1. boots the shared i18n runtime against the surface's own catalogue
 *      directory, so the page speaks EN/DE/PL/TR like the rest of the product;
 *   2. fills the language switcher in `#langSlot`;
 *   3. renders the shared help body (`help-content.js`) into `#helpBody`, and
 *      re-renders it whenever the language changes.
 *
 * The mount owns the two facts that differ per surface, declared on `<html>`:
 *   data-surface="app"|"pilot"  which surface's status keys/wording to use
 *   data-locales="/app/locales/" where that surface's catalogues live
 *
 * No sign-in, no session, no fetch beyond the catalogues: the page is public by
 * design (a dispatcher must be able to read help before signing in). Loaded as a
 * classic script — ES5-compatible, no build step, no CDN.
 */
(function () {
  'use strict';

  var html = document.documentElement;
  var content = window.RoadwiseHelpContent;
  var ui = window.RoadwiseI18nUI;
  var body = document.getElementById('helpBody');
  var slot = document.getElementById('langSlot');

  var surface = html.getAttribute('data-surface') || 'pilot';
  var cfg = (content && content.SURFACES[surface]) || (content && content.SURFACES.pilot) || {};
  var base = html.getAttribute('data-locales') || cfg.localesBase || '/pilot/locales/';

  var back = document.getElementById('helpBack');
  if (back && cfg.backHref) back.setAttribute('href', cfg.backHref);

  function draw(t) {
    if (!body || !content) return;
    body.innerHTML = content.renderHelp(surface, t);
  }

  if (!ui || typeof ui.init !== 'function') {
    // No runtime (a stripped build, or a crawler): show English straight from
    // the catalogue the page is rendered for by falling back to the key text.
    draw(function (key) { return key; });
    return;
  }

  ui.init({
    mount: slot,
    base: base,
    navigatorLanguages: typeof navigator !== 'undefined' ? navigator.languages || navigator.language : null,
    onApply: function (instance) {
      draw(instance.t);
    }
  });
})();
