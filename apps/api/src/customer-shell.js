/**
 * Static serving for the customer portal (board task #74, UXF-C1).
 *
 * The portal is mounted at `/c/` — a **separate** surface from the Fleet
 * Manager app (`/app/`), on purpose: the owner's requirement is a customer
 * surface that does not overload the dispatcher app, and the two have different
 * roles, sessions and navigation.
 *
 * The rules are the Fleet Manager's rules, reused rather than re-implemented:
 * `app-shell.js` owns path resolution (traversal, dotfiles, extension
 * allow-list, content types) and the SPA-vs-404 decision; this module only binds
 * them to `<repo>/customer`. Plain JavaScript, covered by
 * `node --test apps/api/src/` with no install.
 */
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFileIn, readShellFile } from './app-shell.js';

/** `<repo>/customer`, resolved from this file (apps/api/src/customer-shell.js → repo root). */
export const CUSTOMER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../customer');

/** The public mount point. Kept here so the route, the tests and the docs agree. */
export const CUSTOMER_PREFIX = '/c/';

/**
 * Resolve a `/c/*` request path to a real file inside `CUSTOMER_ROOT`.
 *
 * `package.json` is refused even though it is a real file: `customer/package.json`
 * declares `"type": "module"` for the shared ES modules the API imports (without
 * it every customer route fails under tsx — see the file), and a directory
 * manifest is a build artifact, not a portal asset. Everything else follows the
 * shared `app-shell.js` rules.
 * @param {unknown} relPath
 * @returns {string|null}
 */
export function resolveCustomerFile(relPath) {
  if (typeof relPath === 'string' && basename(relPath).toLowerCase() === 'package.json') return null;
  return resolveFileIn(CUSTOMER_ROOT, relPath);
}

let cachedShell = null;

/**
 * The portal shell (`customer/index.html`), read once per process. The route
 * sends `cache-control: no-store`; the deployer restarts this process, so there
 * is no stale-shell window to manage (same trade as the Fleet Manager app).
 * @returns {string}
 */
export function customerShellHtml() {
  if (cachedShell === null) {
    cachedShell = readShellFile(CUSTOMER_ROOT, 'index.html');
  }
  return cachedShell;
}

/** Test hook: forget the cached shell (not used in production paths). */
export function resetCustomerShellCache() {
  cachedShell = null;
}
