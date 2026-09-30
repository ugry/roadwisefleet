import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { contentTypeFor, servesShell } from '../app-shell.js';
import { SOLO_PREFIX, resolveSoloFile, soloShellHtml } from '../solo-shell.js';

/*
 * Solo driver surface (board task #77, UXF-M2) — served by the API itself,
 * same-origin with `/api/solo/*` and the marketplace routes (no new port, no
 * CORS, no CDN), exactly like the Fleet Manager app at `/app/` and the customer
 * portal at `/c/`.
 *
 *   GET /s           -> 302 /s/
 *   GET /s/*         -> the file under <repo>/solo when it exists, otherwise the
 *                       shell, so a deep link renders and the client-side
 *                       session decides where the person goes.
 *
 * The file-resolution rules (traversal, dotfiles, extension allow-list, content
 * types) and the SPA-vs-404 decision are `app-shell.js`'s, reused rather than
 * re-implemented. `x-robots-tag: noindex, nofollow` on everything: this is an
 * authenticated account surface.
 *
 * NOTE (infra): production nginx proxies `/api/`, `/pilot/`, `/app/`, `/c/` and
 * `/track/` to the API; `/s/` needs the same `location /s/` block before the
 * solo surface is reachable on roadwisefleet.com. Filed as an infra request,
 * not done from here.
 */
export async function soloAppRoutes(app: FastifyInstance) {
  app.get('/s', async (_req, reply) => reply.redirect(SOLO_PREFIX, 302));

  app.get('/s/*', async (req, reply) => {
    const relPath = (req.params as Record<string, string>)['*'] ?? '';
    reply.header('x-robots-tag', 'noindex, nofollow');

    const file = resolveSoloFile(relPath);
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
      .send(soloShellHtml());
  });
}
