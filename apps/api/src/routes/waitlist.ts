import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Waitlist endpoint for the landing page. Succeeds the temporary
// services/waitlist/server.js once this API is deployed.
export async function waitlistRoutes(app: FastifyInstance) {
  app.post('/waitlist', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '').trim().toLowerCase();
    // Honeypot: bots fill hidden fields; real users never see them.
    if (String(body.company_website ?? '').trim()) return reply.code(201).send({ ok: true });
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return reply.code(400).send({ error: 'invalid_email' });
    }
    try {
      await prisma.waitlistEntry.upsert({
        where: { email },
        update: {
          lang: String(body.lang ?? '').slice(0, 10),
          source: String(body.source ?? '').slice(0, 60),
          lastSeenAt: new Date(),
        },
        create: {
          email,
          lang: String(body.lang ?? '').slice(0, 10),
          source: String(body.source ?? '').slice(0, 60),
        },
      });
    } catch {
      return reply.code(500).send({ error: 'storage_failure' });
    }
    return reply.code(201).send({ ok: true });
  });

  app.get('/waitlist', async (req, reply) => {
    // Admin-only once auth lands; temporary guard mirrors the VPS service.
    const token = req.headers['x-admin-token'] ?? '';
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const entries = await prisma.waitlistEntry.findMany({ orderBy: { createdAt: 'desc' } });
    return reply.send({ count: entries.length, entries });
  });
}
