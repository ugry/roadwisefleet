/**
 * Help routes (board #138, UXF-DOC2 + FAv1-SUP2b) — HTTP-level proof.
 *
 * The issue's acceptance for the routes is explicit: "each route returns real
 * help content with a document title distinct from the app shell (prove with
 * status + size + a content marker, not just a 200)". The dependency-free guard
 * (`../src/help-content.test.js`) checks the markup and the catalogues; only a
 * real request through `buildServer()` proves what the server answers.
 *
 * `pnpm --filter @roadwisefleet/api test:router`
 *
 * No database, no listener, no credentials: every request is anonymous, which is
 * itself the "no login needed" row of the acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set before `env.ts` is imported (it throws without AUTH_SECRET).
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');

const app = buildServer();
await app.ready();
test.after(() => app.close());

/** The smallest honest bar for "this is a page, not the shell". */
const MIN_HELP_BYTES = 1200;

test('GET /app/help serves the real help page, not the SPA shell', async () => {
  const help = await app.inject({ method: 'GET', url: '/app/help' });
  const shell = await app.inject({ method: 'GET', url: '/app/trips' });

  assert.equal(help.statusCode, 200);
  assert.match(String(help.headers['content-type']), /text\/html/);
  assert.equal(help.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(help.headers['cache-control'], 'no-store');

  // status + size + a content marker, in that order, as the acceptance asks.
  assert.ok(help.payload.length >= MIN_HELP_BYTES, `help page is only ${help.payload.length} bytes`);
  assert.match(help.payload, /id="helpBody"/, 'the render target is present');
  assert.match(help.payload, /data-i18n="help\.documentTitle"/, 'the page declares its own title');

  const helpTitle = /<title[^>]*>([^<]+)<\/title>/.exec(help.payload);
  const shellTitle = /<title[^>]*>([^<]+)<\/title>/.exec(shell.payload);
  assert.ok(helpTitle && shellTitle);
  assert.notEqual(helpTitle[1], shellTitle[1], 'the help title must differ from the shell title');
  assert.match(helpTitle[1], /Help/);
  assert.notEqual(help.payload, shell.payload, 'the help route must not answer with the shell');
  assert.ok(!help.payload.includes('id="loginView"'), 'the login screen is not help content');
});

test('/app/help needs no session, cookie or token', async () => {
  const res = await app.inject({ method: 'GET', url: '/app/help' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['set-cookie'], undefined, 'a public page must not start a session');
  assert.match(res.payload, /help-boot\.js/, 'the page ships its renderer to an anonymous reader');
});

test('GET /pilot/help.html serves the pilot help page from the static root', async () => {
  const res = await app.inject({ method: 'GET', url: '/pilot/help.html' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.ok(res.payload.length >= MIN_HELP_BYTES, `pilot help is only ${res.payload.length} bytes`);
  assert.match(res.payload, /id="helpBody"/);
  assert.match(res.payload, /data-surface="pilot"/);
  const title = /<title[^>]*>([^<]+)<\/title>/.exec(res.payload);
  assert.ok(title);
  assert.match(title[1], /Help/);
});

test('both mounts render the same content table, so they cannot drift', async () => {
  const appHelp = await app.inject({ method: 'GET', url: '/app/help' });
  const pilotHelp = await app.inject({ method: 'GET', url: '/pilot/help.html' });
  for (const marker of ['help-content.js', 'help-boot.js']) {
    assert.ok(appHelp.payload.includes(marker), `/app/help must load ${marker}`);
    assert.ok(pilotHelp.payload.includes(marker), `/pilot/help.html must load ${marker}`);
  }
  assert.match(appHelp.payload, /data-locales="\/app\/locales\/"/);
  assert.match(pilotHelp.payload, /data-locales="\/pilot\/locales\/"/);
});

test('the routing still works as before: deep links are the shell, missing assets 404', async () => {
  const deep = await app.inject({ method: 'GET', url: '/app/settings' });
  assert.equal(deep.statusCode, 200);
  assert.match(deep.payload, /id="appView"/, 'a client route still gets the shell');

  const missing = await app.inject({ method: 'GET', url: '/app/help.css' });
  assert.equal(missing.statusCode, 404, 'a missing asset under /app/ is still a real 404');
});
