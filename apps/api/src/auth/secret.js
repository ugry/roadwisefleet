/**
 * AUTH_SECRET resolution — fail fast, never fall back to a committed default.
 *
 * The API signs bearer tokens with `AUTH_SECRET`. A committed fallback (the
 * former `'pilot-dev-secret-change-me'`) is a public key: anyone could forge a
 * token for any user/org. So a missing secret is a hard startup error, with a
 * single explicit escape hatch for local dev/test:
 *
 *   - `NODE_ENV === 'test'`, or
 *   - `ALLOW_INSECURE_AUTH_SECRET=1`
 *
 * In that mode we generate an ephemeral random secret per process. It is never
 * written to disk or committed, and because it is random each restart, tokens
 * issued before a restart stop verifying — exactly what you want in tests.
 *
 * Keep this dependency-light ESM + JSDoc so `node --test` can exercise it with
 * no install and no build step.
 */

import { randomBytes } from 'node:crypto';

const INSECURE_SECRET_BYTES = 32;

/**
 * @returns {string} a fresh, non-committed random secret
 */
function ephemeralSecret() {
  return randomBytes(INSECURE_SECRET_BYTES).toString('base64url');
}

/**
 * Resolve the token-signing secret from the environment.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   random?: () => string,
 * }} [opts]
 * @returns {string}
 * @throws {Error} when `AUTH_SECRET` is missing and insecure mode is not enabled
 */
export function resolveAuthSecret({ env = process.env, random = ephemeralSecret } = {}) {
  const provided = env?.AUTH_SECRET;
  if (typeof provided === 'string' && provided.trim().length > 0) {
    return provided;
  }

  const insecureMode = env?.NODE_ENV === 'test' || env?.ALLOW_INSECURE_AUTH_SECRET === '1';
  if (insecureMode) {
    return random();
  }

  throw new Error(
    'AUTH_SECRET is required: set a strong AUTH_SECRET in the environment ' +
      '(or apps/api/.env) before starting the API. For local development and ' +
      'tests only, set ALLOW_INSECURE_AUTH_SECRET=1 to use an ephemeral random ' +
      'secret for this process. Never commit a secret to the repository.',
  );
}
