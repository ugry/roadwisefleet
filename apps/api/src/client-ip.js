/**
 * The client address a request is attributed to, behind the pilot's nginx.
 *
 * Board task #86 review (PR #78, P1): the register limiter keyed on `req.ip`,
 * but Fastify runs with `trustProxy` unset while the API is loopback-only
 * (`env.HOST=127.0.0.1`) and is reached through nginx (`location /api/` ->
 * `127.0.0.1:8080`, `X-Real-IP $remote_addr`). `req.ip` was therefore ALWAYS
 * the loopback peer: every visitor shared one bucket, so ten invalid attempts
 * in a window refused every signup worldwide. The key must never be the shared
 * `127.0.0.1`.
 *
 * This mirrors `services/waitlist/server.js#resolveClientIp` — the two limiters
 * must agree on what "a client" is:
 *
 * - Peer is NOT loopback -> the peer address is the truth; `X-Real-IP` /
 *   `X-Forwarded-For` are attacker-controlled and are ignored.
 * - Peer IS loopback (our nginx) -> trust `X-Real-IP`, which nginx overwrites
 *   with `$remote_addr`. Fall back to the LAST hop of `X-Forwarded-For`: nginx
 *   appends the real client with `$proxy_add_x_forwarded_for`, so only the last
 *   element is written by our own proxy; earlier elements are whatever the
 *   caller sent.
 *
 * Pure ESM + JSDoc types: no Fastify import, unit-testable with `node --test`.
 */

/**
 * True for 127.0.0.0/8 and ::1 (including the IPv4-mapped ::ffff:127.0.0.1).
 * @param {string | null | undefined} addr
 */
export function isLoopback(addr) {
  if (!addr) return false;
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return /^127\./.test(v4);
}

/**
 * @param {{ socket?: { remoteAddress?: string | null } | null, headers?: Record<string, string | string[] | undefined> } | null | undefined} req
 * @returns {string}
 */
export function resolveClientIp(req) {
  const peer = (req && req.socket && req.socket.remoteAddress) || '';
  if (!isLoopback(peer)) return peer || 'unknown';

  const headers = (req && req.headers) || {};
  const realIp = headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();

  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return peer || 'unknown';
}
