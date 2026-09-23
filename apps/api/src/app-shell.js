/**
 * Static serving for the Fleet Manager app (board task #32, FAv1-F1).
 *
 * The app is mounted at `/app/`. Unlike the pilot (one flat static root), the
 * app needs SPA semantics: every deep link under `/app/` must return the shell
 * so the client-side guard can run, while a *missing asset* must still be a
 * real 404 (never HTML served as JavaScript).
 *
 * This module is the pure half of that contract — path resolution, extension
 * allow-list, content types and the fallback decision — so it is covered by
 * `node --test apps/api/src/` with no install, no Fastify and no server. The
 * route wiring lives in `routes/app.ts`. Plain JavaScript (no build step): the
 * no-install CI job loads this file directly.
 *
 * Security posture:
 *   - the request path is resolved inside `<repo>/app` and the resolved real
 *     path (symlinks included) must stay inside it — `../`, encoded or not,
 *     cannot escape;
 *   - dotfiles are never served;
 *   - only an explicit extension allow-list is served, so an unexpected file
 *     dropped into the directory is not exposed by accident;
 *   - no directory listings.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<repo>/app`, resolved from this file (apps/api/src/app-shell.js → repo root). */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../app');

/** The public mount point. Kept here so the route, the tests and the docs agree. */
export const APP_PREFIX = '/app/';

/** Extensions the app may serve. Anything else is not exposed. */
export const ALLOWED_EXTENSIONS = Object.freeze([
  '.html', '.css', '.js', '.json', '.svg', '.png', '.webmanifest', '.ico', '.woff2',
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * The content type for a file name, or `null` when the extension is not served.
 * @param {unknown} file
 * @returns {string|null}
 */
export function contentTypeFor(file) {
  if (typeof file !== 'string' || file.length === 0) return null;
  const ext = extname(file).toLowerCase();
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : null;
}

/**
 * Resolve a request path (the `/app/*` wildcard, no leading slash) to an
 * absolute file inside `APP_ROOT`, or `null` when it is not a servable file.
 *
 * `null` means "not a file we serve" — the caller then decides between the SPA
 * shell and a 404 (`servesShell`).
 * @param {unknown} relPath
 * @returns {string|null}
 */
export function resolveAppFile(relPath) {
  if (typeof relPath !== 'string') return null;
  // Decode once more defensively: Fastify decodes route params, but a stray
  // percent-encoding must not become a traversal.
  let decoded = relPath;
  try {
    decoded = decodeURIComponent(relPath);
  } catch (err) {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const candidate = resolve(APP_ROOT, decoded);
  if (candidate !== APP_ROOT && !candidate.startsWith(APP_ROOT + sep)) return null;
  if (candidate === APP_ROOT) return null; // the directory itself is never served

  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s.startsWith('.'))) return null; // dotfiles, ./, ../

  const type = contentTypeFor(decoded);
  if (!type) return null;

  try {
    const real = realpathSync(candidate);
    if (real !== APP_ROOT && !real.startsWith(APP_ROOT + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch (err) {
    return null;
  }
}

/**
 * Should a request that did not resolve to a file receive the SPA shell?
 *
 * Yes for extension-less paths and `.html` (the client router decides); no for
 * anything that looks like an asset — a missing `.js` must 404, or the browser
 * would parse HTML as a script.
 * @param {unknown} relPath
 * @param {boolean} [fileExists]
 * @returns {boolean}
 */
export function servesShell(relPath, fileExists) {
  if (fileExists) return false;
  if (typeof relPath !== 'string') return false;
  const clean = relPath.split('#')[0].split('?')[0];
  const segments = clean.split('/').filter((s) => s.length > 0);
  // A dotfile is never a client route (and extension-less names like `.env` would
  // otherwise reach the shell).
  if (segments.some((s) => s.startsWith('.'))) return false;
  const ext = extname(clean).toLowerCase();
  return ext === '' || ext === '.html';
}

let cachedShell = null;

/**
 * The shell HTML (`app/index.html`), read once per process.
 *
 * A deploy replaces the file on disk; the route sends `cache-control: no-store`
 * so a browser never keeps an old shell across a deploy. Reading once is a
 * deliberate trade — the deployer restarts this process (see `deploy.sh`), so
 * there is no stale-shell window to manage here.
 * @returns {string}
 */
export function shellHtml() {
  if (cachedShell === null) {
    cachedShell = readFileSync(resolve(APP_ROOT, 'index.html'), 'utf8');
  }
  return cachedShell;
}

/** Test hook: forget the cached shell (not used in production paths). */
export function resetShellCache() {
  cachedShell = null;
}
