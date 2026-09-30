/**
 * Fastify server options shared by `buildServer()` (`app.ts`) and its tests.
 *
 * `routerOptions.maxParamLength` bounds the length of a route parameter. The
 * Fastify default is **100**, but a real customer tracking token
 * (`signTrackLink`, JWT-style `header.payload.signature`) is ~203 chars — so the
 * router rejected `/track/:token` and `/api/track/:token` with
 * `414 FST_ERR_MAX_PARAM_LENGTH` before the handler ever ran (PR #25 review).
 *
 * `512` is comfortably above any token we can currently mint (tokens grow with
 * the claim set) while still bounding the URL. Use `routerOptions`: the
 * top-level `maxParamLength` is deprecated in Fastify 5.12 (FSTDEP022).
 */

/** Route-parameter cap; must stay above the longest token we can mint. */
export const MAX_PARAM_LENGTH = 512;

/**
 * Build the options object passed to `Fastify()`.
 * @param {{ logger?: boolean }} [opts]
 * @returns {{ logger: boolean, routerOptions: { maxParamLength: number } }}
 */
export function serverOptions({ logger = true } = {}) {
  return { logger, routerOptions: { maxParamLength: MAX_PARAM_LENGTH } };
}
