import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { tripRoutes } from './routes/trips.js';
import { documentRoutes } from './routes/documents.js';

// <repo>/pilot, resolved from this file (apps/api/src/app.ts → repo root).
const here = dirname(fileURLToPath(import.meta.url));
const pilotRoot = resolve(here, '../../../pilot');

/**
 * Build the Fastify app without binding a port, so tests and smoke scripts can
 * use `app.inject()` / an ephemeral listener. `server.ts` is the only place
 * that calls `listen()`.
 */
export function buildServer() {
  const app = Fastify({ logger: true });

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: '/api' });
  app.register(waitlistRoutes, { prefix: '/api' });
  app.register(tripRoutes, { prefix: '/api' });
  app.register(documentRoutes, { prefix: '/api' });

  // Pilot-only web surface. Served from the API itself so the pages are
  // same-origin with `/api/*` (no new port, no nginx). The root is locked to
  // <repo>/pilot — @fastify/static never serves outside it, and production
  // `web/` is untouched.
  app.register(fastifyStatic, {
    root: pilotRoot,
    prefix: '/pilot/',
    index: ['index.html'],
  });

  return app;
}
