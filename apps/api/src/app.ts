import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { fleetRoutes } from './routes/fleet.js';
import { fleetCustomerRoutes } from './routes/fleet-customers.js';
import { deviceAuthRoutes } from './routes/device-auth.js';
import { emailOtpRoutes } from './routes/email-otp.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { tripRoutes } from './routes/trips.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { referenceRoutes } from './routes/reference.js';
import { documentRoutes } from './routes/documents.js';
import { trackPageRoutes, trackRoutes } from './routes/track.js';
import { documentShareRoutes, guestShareRoutes } from './routes/guest-share.js';
import { appRoutes } from './routes/app.js';
import { customerAppRoutes } from './routes/customer-app.js';
import { customerRoutes } from './routes/customer.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { soloAppRoutes } from './routes/solo-app.js';
import { soloRoutes } from './routes/solo.js';
import { reviewRoutes } from './routes/reviews.js';
import { serverOptions } from './server-options.js';
import { createGpsHub } from './gps-stream.js';

// <repo>/pilot, resolved from this file (apps/api/src/app.ts → repo root).
const here = dirname(fileURLToPath(import.meta.url));
const pilotRoot = resolve(here, '../../../pilot');

/**
 * Build the Fastify app without binding a port, so tests and smoke scripts can
 * use `app.inject()` / an ephemeral listener. `server.ts` is the only place
 * that calls `listen()`.
 *
 * `emailSender` is a test seam for the email-OTP route (board task #125): the
 * DB-backed router test injects a fake that records what was delivered, so the
 * endpoints are exercised without a real SMTP credential. Production passes
 * nothing and the route builds the env-configured sender. `otpSchedule` is the
 * companion seam for the route's background mint+send: the test passes a
 * scheduler it can drain, so it never races the fake transport.
 */
export function buildServer(options: { emailSender?: any; otpSchedule?: (task: () => Promise<void>) => void } = {}) {
  // `routerOptions.maxParamLength` must exceed a real tracking token (~203
  // chars); the Fastify default (100) returned 414 before the handler ran.
  const app = Fastify(serverOptions());

  // Realtime GPS fan-out (board task #106, AND1-A4): one in-process hub per
  // server instance. The ingest route publishes accepted points; the SSE routes
  // subscribe. Decorated here so a test can also subscribe/publish directly.
  app.decorate('gpsHub', createGpsHub());

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: '/api' });
  // Fleet-managed driver accounts (board task #111, AND2-REG1): a fleet manager
  // creates a driver inside its own org.
  app.register(fleetRoutes, { prefix: '/api' });
  // Fleet self-serve customer lane (board task #120): quick-add a customer and
  // create/repeat a manual order for the fleet's OWN customers.
  app.register(fleetCustomerRoutes, { prefix: '/api' });
  // Passwordless Android device auth (board task #104, AND1-A2): public
  // challenge/verify plus the authenticated register/revoke.
  app.register(deviceAuthRoutes, { prefix: '/api' });
  // Email one-time codes (board task #125): passwordless sign-in codes and email
  // confirmation, delivered through the #124 SMTP contract.
  app.register(emailOtpRoutes, { prefix: '/api', sender: options.emailSender, schedule: options.otpSchedule });
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

  // Guest document + invoice share views (board task #132, UXF-O1a): their own
  // prefix `/g/<scope>/<token>` (no auth) plus the authenticated mint/read
  // endpoints under /api. `/s/` is the solo shell and `/track/` the tracking
  // link, so this surface never reuses either location.
  app.register(guestShareRoutes);
  app.register(documentShareRoutes, { prefix: '/api' });

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
