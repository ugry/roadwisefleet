import { env } from './env.js';
import { buildServer } from './app.js';

const app = buildServer();

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => app.log.info(`RoadwiseFleet API on ${env.HOST}:${env.PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
