import Fastify from 'fastify';
import { env } from './env.js';
import { healthRoutes } from './routes/health.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { tripRoutes } from './routes/trips.js';

const app = Fastify({ logger: true });

app.register(healthRoutes);
app.register(waitlistRoutes, { prefix: '/api' });
app.register(tripRoutes, { prefix: '/api' });

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => app.log.info(`RoadwiseFleet API on ${env.HOST}:${env.PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
