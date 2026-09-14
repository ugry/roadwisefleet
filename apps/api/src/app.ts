import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { tripRoutes } from './routes/trips.js';

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

  return app;
}
