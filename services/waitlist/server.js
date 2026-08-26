'use strict';
/*
 * RoadwiseFleet — waitlist microservice.
 * Zero-dependency Node (works on Node 18+). JSONL append storage.
 * Temporary by design: replaced by the Fastify API (apps/api) when it ships.
 * Endpoints:
 *   POST /api/waitlist  { email, company_website (honeypot), lang, source } -> 201
 *   GET  /api/waitlist  (header X-Admin-Token) -> { count, entries }
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
const hits = new Map(); // ip -> timestamps[]

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

function readAdminToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function rateLimited(ip, now) {
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) return true;
  list.push(now);
  hits.set(ip, list);
  return false;
}

const server = http.createServer((req, res) => {
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
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip, Date.now())) return json(res, 429, { error: 'rate_limited' });
      const record = {
        email,
        lang: String(body.lang || '').slice(0, 10),
        source: String(body.source || '').slice(0, 60),
        ip_hash: crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16),
        created_at: new Date().toISOString(),
      };
      try {
        fs.appendFileSync(DATA_FILE, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        console.error('append failed:', err.message);
        return json(res, 500, { error: 'storage_failure' });
      }
      return json(res, 201, { ok: true });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/waitlist') {
    const expected = readAdminToken();
    const provided = req.headers['x-admin-token'] || '';
    if (!expected || provided !== expected) return json(res, 401, { error: 'unauthorized' });
    let rows = [];
    try {
      const txt = fs.readFileSync(DATA_FILE, 'utf8').trim();
      if (txt) rows = txt.split('\n').map((l) => JSON.parse(l));
    } catch {
      /* empty file */
    }
    return json(res, 200, { count: rows.length, entries: rows });
  }

  json(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[waitlist] listening on ${HOST}:${PORT}, data: ${DATA_FILE}`);
});
