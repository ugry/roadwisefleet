import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { contentTypeFor, servesShell } from '../app-shell.js';
import { CUSTOMER_PREFIX, customerShellHtml, resolveCustomerFile } from '../customer-shell.js';

/*
 * Customer portal surface (board task #74, UXF-C1) — served by the API itself,
 * same-origin with `/api/customer/*` (no new port, no CORS, no CDN), exactly
 * like the Fleet Manager app at `/app/`.
 *
 *   GET /c           -> 302 /c/
 *   GET /c/*         -> the file under <repo>/customer when it exists, otherwise
 *                       the shell, so a deep link renders and the client-side
 *                       session decides where the person goes.
 *
 * The file-resolution rules (traversal, dotfiles, extension allow-list, content
 * types) and the SPA-vs-404 decision are `app-shell.js`'s, reused rather than
 * re-implemented. `x-robots-tag: noindex, nofollow` on everything: this is an
 * authenticated account surface.
 *
 * NOTE (infra): production nginx proxies `/api/`, `/pilot/`, `/app/` and
 * `/track/` to the API; `/c/` needs the same `location /c/` block before the
 * portal is reachable on roadwisefleet.com. Filed as an infra request, not done
 * from here.
 */
export async function customerAppRoutes(app: FastifyInstance) {
  app.get('/c', async (_req, reply) => reply.redirect(CUSTOMER_PREFIX, 302));

  app.get('/c/*', async (req, reply) => {
    const relPath = (req.params as Record<string, string>)['*'] ?? '';
    reply.header('x-robots-tag', 'noindex, nofollow');

    const file = resolveCustomerFile(relPath);
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
      .send(customerShellHtml());
  });
}
