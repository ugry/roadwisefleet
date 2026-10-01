import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { tripRoutes } from './routes/trips.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { referenceRoutes } from './routes/reference.js';
import { documentRoutes } from './routes/documents.js';
import { trackPageRoutes, trackRoutes } from './routes/track.js';
import { appRoutes } from './routes/app.js';
import { customerAppRoutes } from './routes/customer-app.js';
import { customerRoutes } from './routes/customer.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { soloAppRoutes } from './routes/solo-app.js';
import { soloRoutes } from './routes/solo.js';
import { reviewRoutes } from './routes/reviews.js';
import { serverOptions } from './server-options.js';

// <repo>/pilot, resolved from this file (apps/api/src/app.ts → repo root).
const here = dirname(fileURLToPath(import.meta.url));
const pilotRoot = resolve(here, '../../../pilot');

/**
 * Build the Fastify app without binding a port, so tests and smoke scripts can
 * use `app.inject()` / an ephemeral listener. `server.ts` is the only place
 * that calls `listen()`.
 */
export function buildServer() {
  // `routerOptions.maxParamLength` must exceed a real tracking token (~203
  // chars); the Fastify default (100) returned 414 before the handler ran.
  const app = Fastify(serverOptions());

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: '/api' });
  app.register(waitlistRoutes, { prefix: '/api' });
  app.register(tripRoutes, { prefix: '/api' });
  app.register(dashboardRoutes, { prefix: '/api' });
  app.register(referenceRoutes, { prefix: '/api' });
  app.register(documentRoutes, { prefix: '/api' });
  app.register(trackRoutes, { prefix: '/api' });
  // Customer portal API (board task #74, UXF-C1).
  app.register(customerRoutes, { prefix: '/api' });

  // Connect marketplace API (board task #76, UXF-M1): load postings, capacity
  // beacons, structured offers and the award that creates the carrier's Trip.
  app.register(marketplaceRoutes, { prefix: '/api' });

  // Solo driver Connect MVP API (board task #77, UXF-M2): signup, phone OTP,
  // verification papers, own customers, quick jobs and wallet-lite. The load
  // feed/beacon/offer paths stay the marketplace's; verification is optional
  // (board #96) and only surfaces as per-paper check marks.
  app.register(soloRoutes, { prefix: '/api' });

  // Two-sided review / feedback API (board task #98, owner decision #73 q3).
  app.register(reviewRoutes, { prefix: '/api' });

  // Public customer tracking page: root path `/track/:token` (no auth, not
  // under /pilot/), so a shared link reads like a customer-facing URL.
  app.register(trackPageRoutes);

  // Fleet Manager (board task #32, FAv1-F1): the authenticated app shell at
  // `/app/`, plus its SPA fallback. Files come from <repo>/app; the app talks to
  // the same-origin `/api/*` routes above.
  app.register(appRoutes);

  // Customer portal (board task #74, UXF-C1): the customer-facing account
  // surface at `/c/`, a separate mobile-first area from the dispatcher app.
  app.register(customerAppRoutes);

  // Solo driver surface (board task #77, UXF-M2): the mobile-first solo area at
  // `/s/`, same-origin with `/api/solo/*` and the marketplace routes.
  app.register(soloAppRoutes);

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
