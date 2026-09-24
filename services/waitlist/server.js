'use strict';
/*
 * RoadwiseFleet — waitlist microservice.
 * Zero-dependency Node (works on Node 18+). JSONL append storage.
 * Temporary by design: replaced by the Fastify API (apps/api) when it ships.
 * Endpoints:
 *   POST /api/waitlist  { email, company_website (honeypot), lang, source } -> 201
 *   GET  /api/waitlist  (header X-Admin-Token) -> { count, entries }
 *
 * Rate limiting (board #45 / FAv1-OPS2). The 5-per-hour limit used to key on
 * `req.socket.remoteAddress`, which behind nginx is always 127.0.0.1 — so every
 * visitor shared ONE bucket and five signups an hour from anywhere rejected all
 * real users. It now keys on the real client address, taken from the proxy
 * headers ONLY when the request arrives from a loopback peer (our own nginx):
 * a direct or off-host caller can never spoof its way out of the limit.
 *
 * nginx rate limiting (infra/nginx/conf.d/roadwisefleet-limits.conf) is the
 * outer layer; this limiter is deliberately kept as the inner, per-IP one —
 * see infra/pilot-exposure.md §7 for why both exist.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.WAITLIST_DATA_DIR || '/var/lib/roadwisefleet';
const DATA_FILE = path.join(DATA_DIR, 'waitlist.jsonl');
const TOKEN_FILE = path.join(DATA_DIR, 'admin-token');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 5;
const MAX_BODY = 4096;
// Drop per-IP state for clients that have been quiet for a full window, so a
// long-running process cannot grow the map without bound (one entry per IP that
// ever posted, forever, previously).
const SWEEP_EVERY = 1000;

function json(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readAdminToken(tokenFile = TOKEN_FILE) {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return null;
  }
}

/** True for 127.0.0.0/8 and ::1 (including the IPv4-mapped ::ffff:127.0.0.1). */
function isLoopback(addr) {
  if (!addr) return false;
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return /^127\./.test(v4);
}

/**
 * The client address the limit is keyed on.
 *
 * - Peer is NOT loopback  -> the peer address is the truth; X-Real-IP /
 *   X-Forwarded-For are attacker-controlled and are ignored.
 * - Peer IS loopback (our nginx) -> trust `X-Real-IP`, which nginx sets to
 *   `$remote_addr`. Fall back to the LAST hop of `X-Forwarded-For`: nginx
 *   appends the real client with `$proxy_add_x_forwarded_for`, so only the
 *   last element is written by our own proxy; earlier elements are whatever
 *   the caller sent.
 */
function resolveClientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  if (!isLoopback(peer)) return peer || 'unknown';

  const realIp = req.headers && req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();

  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return peer;
}

/** Per-IP sliding-window limiter (injectable clock, so it is unit-testable). */
class RateLimiter {
  constructor({ windowMs = WINDOW_MS, max = MAX_PER_WINDOW, sweepEvery = SWEEP_EVERY } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.sweepEvery = sweepEvery;
    this.hits = new Map(); // ip -> ascending timestamps[]
    this.checks = 0;
  }

  /** Forget keys with no hit inside the current window. */
  prune(now) {
    for (const [ip, list] of this.hits) {
      const newest = list.length ? list[list.length - 1] : 0;
      if (!newest || now - newest >= this.windowMs) this.hits.delete(ip);
    }
  }

  /** true when this call is over the limit; records the call when it is not. */
  check(ip, now) {
    this.checks += 1;
    if (this.checks >= this.sweepEvery) {
      this.checks = 0;
      this.prune(now);
    }
    const list = (this.hits.get(ip) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(ip, list);
      return true;
    }
    list.push(now);
    this.hits.set(ip, list);
    return false;
  }
}

/**
 * Build the HTTP server. Exported so tests can drive it on an ephemeral port
 * with a scratch data file; `server.js` still starts it when run directly.
 */
function createWaitlistServer({
  limiter = new RateLimiter(),
  dataFile = DATA_FILE,
  tokenFile = TOKEN_FILE,
  log = console,
} = {}) {
  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/waitlist') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { error: 'invalid_json' });
        }
        const honeypot = String(body.company_website || '').trim();
        if (honeypot) return json(res, 201, { ok: true }); // silently drop bots
        const email = String(body.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email) || email.length > 254) {
          return json(res, 400, { error: 'invalid_email' });
        }
        const ip = resolveClientIp(req);
        if (limiter.check(ip, Date.now())) {
          log.warn(`[waitlist] rate limited ${ip}`);
          return json(res, 429, { error: 'rate_limited' });
        }
        const record = {
          email,
          lang: String(body.lang || '').slice(0, 10),
          source: String(body.source || '').slice(0, 60),
          ip_hash: crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16),
          created_at: new Date().toISOString(),
        };
        try {
          fs.appendFileSync(dataFile, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
        } catch (err) {
          log.error('append failed:', err.message);
          return json(res, 500, { error: 'storage_failure' });
        }
        return json(res, 201, { ok: true });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/waitlist') {
      const expected = readAdminToken(tokenFile);
      const provided = req.headers['x-admin-token'] || '';
      if (!expected || provided !== expected) return json(res, 401, { error: 'unauthorized' });
      let rows = [];
      try {
        const txt = fs.readFileSync(dataFile, 'utf8').trim();
        if (txt) rows = txt.split('\n').map((l) => JSON.parse(l));
      } catch {
        /* empty file */
      }
      return json(res, 200, { count: rows.length, entries: rows });
    }

    json(res, 404, { error: 'not_found' });
  });
}

if (require.main === module) {
  createWaitlistServer().listen(PORT, HOST, () => {
    console.log(`[waitlist] listening on ${HOST}:${PORT}, data: ${DATA_FILE}`);
  });
}

module.exports = {
  createWaitlistServer,
  resolveClientIp,
  isLoopback,
  RateLimiter,
  readAdminToken,
  WINDOW_MS,
  MAX_PER_WINDOW,
};
