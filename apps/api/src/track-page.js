/**
 * Public customer tracking page (board task #5) — the HTML shell served at
 * `GET /track/:token` with no authentication.
 *
 * The page is deliberately self-contained: inline CSS and vanilla JS, no build
 * step, no CDN, no external font. The token is read from the URL path and the
 * data comes from the sibling JSON endpoint `GET /api/track/:token`, so the same
 * origin serves both. Invalid or expired tokens render a friendly message —
 * never a stack trace and never any trip data.
 *
 * `x-robots-tag: noindex` is set by the route *and* as a meta tag here, so a
 * crawler that does not see the header still does not index a customer link.
 *
 * Pure string function: unit-testable with `node --test` (no DOM, no install).
 */

/**
 * @returns {string} the complete HTML document
 */
export function trackPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Trip tracking — RoadwiseFleet</title>
<style>
  :root{
    --bg:oklch(0.98 0.008 258); --surface:#fff; --border:oklch(0.9 0.01 258);
    --text:oklch(0.25 0.02 258); --muted:oklch(0.55 0.02 258); --accent:oklch(0.55 0.14 258);
    --ok:oklch(0.55 0.12 155); --warn:oklch(0.6 0.14 70);
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.45}
  .wrap{max-width:680px;margin:0 auto;padding:24px 16px 64px}
  header{display:flex;align-items:baseline;gap:10px;margin-bottom:18px}
  header h1{font-size:19px;margin:0;font-weight:650}
  header .muted{font-size:13px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:14px}
  .muted{color:var(--muted)}
  .status{display:inline-block;padding:4px 10px;border-radius:999px;font-size:13px;font-weight:600;
    background:oklch(0.94 0.03 258);color:var(--accent)}
  .status.done{background:oklch(0.94 0.05 155);color:var(--ok)}
  .status.pending{background:oklch(0.95 0.05 70);color:var(--warn)}
  .route{font-size:20px;font-weight:600;margin:10px 0 2px}
  dl.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:12px 0 0;font-size:14px}
  dl.kv dt{color:var(--muted)}
  dl.kv dd{margin:0}
  .section-title{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
  ul.timeline{list-style:none;margin:0;padding:0}
  ul.timeline li{padding:8px 0;border-bottom:1px solid var(--border);font-size:14px}
  ul.timeline li:last-child{border-bottom:0}
  .tl-when{font-size:12px;color:var(--muted)}
  .msg{margin:0;padding:12px 14px;border-radius:10px;font-size:14px}
  .msg.err{background:oklch(0.96 0.04 25);color:oklch(0.45 0.16 25)}
  .flag{display:inline-block;font-size:13px;font-weight:600;padding:3px 9px;border-radius:999px}
  .flag.yes{background:oklch(0.94 0.05 155);color:var(--ok)}
  .flag.no{background:oklch(0.95 0.01 258);color:var(--muted)}
  footer{margin-top:22px;font-size:12px;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>RoadwiseFleet</h1>
    <span class="muted">shipment tracking</span>
  </header>
  <main id="app" aria-live="polite">
    <div class="card"><p class="muted">Loading shipment status…</p></div>
  </main>
  <footer>This is a private link shared by your carrier. It shows route and status only.</footer>
</div>
<script>
(function () {
  var app = document.getElementById('app');

  function token() {
    var m = /^\\/track\\/(.+)$/.exec(window.location.pathname);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }

  function statusClass(s) {
    if (s === 'DELIVERED' || s === 'POD_UPLOADED' || s === 'INVOICED' || s === 'SETTLED') return 'status done';
    if (s === 'CANCELLED') return 'status pending';
    return 'status';
  }

  function render(data) {
    var t = (data && data.tracking) || {};
    var route = t.route || {};
    var events = t.statusTimeline || [];
    var pos = t.lastKnownPosition;
    var pod = t.pod || {};

    var timeline = events.length
      ? '<ul class="timeline">' + events.map(function (e) {
          return '<li><div>' + esc(e.from) + ' → ' + esc(e.to) + '</div>' +
            '<div class="tl-when">' + esc(fmtDate(e.at)) + '</div></li>';
        }).join('') + '</ul>'
      : '<p class="muted">No status updates yet.</p>';

    var position = pos
      ? 'Last update ' + esc(fmtDate(pos.at)) + ' · ' + (pos.lat !== null && pos.lng !== null ? (pos.lat + ', ' + pos.lng) : 'position pending')
      : 'Not available yet';

    app.innerHTML =
      '<div class="card">' +
        '<span class="' + statusClass(t.status) + '">' + esc(t.status || 'UNKNOWN') + '</span>' +
        '<div class="route">' + esc(route.origin || '?') + ' → ' + esc(route.destination || '?') + '</div>' +
        (route.cargo ? '<div class="muted">' + esc(route.cargo) + '</div>' : '') +
        '<dl class="kv">' +
          '<dt>Vehicle position</dt><dd>' + esc(position) + '</dd>' +
          '<dt>Estimated arrival</dt><dd>Not available yet</dd>' +
          '<dt>Proof of delivery</dt><dd><span class="flag ' + (pod.available ? 'yes' : 'no') + '">' +
            (pod.available ? 'Available' : 'Not uploaded yet') + '</span></dd>' +
        '</dl>' +
      '</div>' +
      '<div class="card"><div class="section-title">Status history</div>' + timeline + '</div>' +
      (data && data.expiresAt ? '<p class="muted" style="font-size:13px">Link valid until ' + esc(fmtDate(data.expiresAt)) + '.</p>' : '');
  }

  function renderError(code) {
    var text = code === 'invalid_token'
      ? 'This tracking link is invalid or has expired. Please ask your carrier for a new link.'
      : 'This shipment is no longer available for tracking. Please ask your carrier for a new link.';
    app.innerHTML = '<div class="card"><p class="msg err">' + esc(text) + '</p></div>';
  }

  var tk = token();
  if (!tk) { renderError('invalid_token'); return; }

  fetch('/api/track/' + encodeURIComponent(tk), { headers: { accept: 'application/json' } })
    .then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) { renderError((data && data.error) || ('http_' + res.status)); return; }
        render(data);
      });
    })
    .catch(function () {
      app.innerHTML = '<div class="card"><p class="msg err">Could not load the shipment status. ' +
        'Please check your connection and try again.</p></div>';
    });
})();
</script>
</body>
</html>
`;
}
