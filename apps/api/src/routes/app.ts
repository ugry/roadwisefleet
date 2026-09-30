import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  APP_PREFIX,
  contentTypeFor,
  resolveAppFile,
  servesShell,
  shellHtml,
} from '../app-shell.js';

/*
 * Fleet Manager app (board task #32, FAv1-F1) — served by the API itself, so
 * the pages are same-origin with `/api/*` (no new port, no CORS, no CDN).
 *
 *   GET /app           -> 301 /app/
 *   GET /app/*         -> the file under <repo>/app when it exists, otherwise
 *                         the shell (SPA fallback) so deep links work and the
 *                         client-side guard decides where the person goes.
 *
 * Why not `@fastify/static` here, like `/pilot/`? Two reasons, both deliberate:
 *   1. the SPA fallback has to be an explicit decision (HTML for a deep link,
 *      a real 404 for a missing asset) — a static root cannot express that;
 *   2. `@fastify/static` decorates the reply with `sendFile`; the pilot
 *      registration already did that in this encapsulation context, so a second
 *      registration must pass `decorateReply: false` and could not use it
 *      anyway.
 * The file-resolution rules (traversal, dotfiles, extension allow-list, content
 * types) live in `src/app-shell.js` and are unit-tested without a server.
 *
 * `x-robots-tag: noindex, nofollow` and `cache-control: no-store` are set on
 * every response: this is an authenticated internal app behind a login, and a
 * stale shell must never survive a deploy.
 */
export async function appRoutes(app: FastifyInstance) {
  app.get('/app', async (_req, reply) => reply.redirect(APP_PREFIX, 302));

  app.get('/app/*', async (req, reply) => {
    const relPath = (req.params as Record<string, string>)['*'] ?? '';
    reply.header('x-robots-tag', 'noindex, nofollow');

    const file = resolveAppFile(relPath);
    if (file) {
      const type = contentTypeFor(file);
      if (type === 'text/html; charset=utf-8') reply.header('cache-control', 'no-store');
      return reply.type(type ?? 'application/octet-stream').send(createReadStream(file));
    }

    if (!servesShell(relPath, false)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(shellHtml());
  });
}
