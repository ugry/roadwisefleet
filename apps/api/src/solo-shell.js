/**
 * Static serving for the solo driver surface (board task #77, UXF-M2).
 *
 * The surface is mounted at `/s/` — a **separate**, mobile-first area from the
 * Fleet Manager app (`/app/`) and the customer portal (`/c/`), on purpose: the
 * solo driver has a different role, session and navigation, and the diagram 08
 * menu survey keeps them apart.
 *
 * The rules are the Fleet Manager's rules, reused rather than re-implemented:
 * `app-shell.js` owns path resolution (traversal, dotfiles, extension
 * allow-list, content types) and the SPA-vs-404 decision; this module only binds
 * them to `<repo>/solo`. Plain JavaScript, covered by
 * `node --test apps/api/src/` with no install.
 */
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFileIn, readShellFile } from './app-shell.js';

/** `<repo>/solo`, resolved from this file (apps/api/src/solo-shell.js → repo root). */
export const SOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../solo');

/** The public mount point. Kept here so the route, the tests and the docs agree. */
export const SOLO_PREFIX = '/s/';

/**
 * Resolve an `/s/*` request path to a real file inside `SOLO_ROOT`.
 *
 * `package.json` is refused even though it is a real file: `solo/package.json`
 * declares `"type": "module"` for the shared ES module the API imports (without
 * it every solo route fails under tsx — see the file), and a directory manifest
 * is a build artifact, not a surface asset. Everything else follows the shared
 * `app-shell.js` rules.
 * @param {unknown} relPath
 * @returns {string|null}
 */
export function resolveSoloFile(relPath) {
  if (typeof relPath === 'string' && basename(relPath).toLowerCase() === 'package.json') return null;
  return resolveFileIn(SOLO_ROOT, relPath);
}

let cachedShell = null;

/**
 * The surface shell (`solo/index.html`), read once per process. The route sends
 * `cache-control: no-store`; the deployer restarts this process, so there is no
 * stale-shell window to manage (same trade as the Fleet Manager app).
 * @returns {string}
 */
export function soloShellHtml() {
  if (cachedShell === null) {
    cachedShell = readShellFile(SOLO_ROOT, 'index.html');
  }
  return cachedShell;
}

/** Test hook: forget the cached shell (not used in production paths). */
export function resetSoloShellCache() {
  cachedShell = null;
}
