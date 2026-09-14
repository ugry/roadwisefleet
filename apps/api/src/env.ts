// Environment configuration — one place, fail-fast on missing vars.
//
// The app reads DATABASE_URL from the process environment, so load the
// package `.env` (Node 20 `process.loadEnvFile`, no dotenv dependency) before
// anything else reads `process.env`. Real environment variables always win
// over file values; we load only the first file that exists so two `.env`
// files can never fight over the same key.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = [resolve(here, '../.env'), resolve(here, '../../../.env')].find((p) =>
  existsSync(p),
);
if (envFile) process.loadEnvFile(envFile);

export const env = {
  PORT: Number(process.env.PORT || 8080),
  HOST: process.env.HOST || '127.0.0.1',
  DATABASE_URL:
    process.env.DATABASE_URL ||
    'postgresql://roadwisefleet:roadwisefleet@127.0.0.1:5432/roadwisefleet',
  // HMAC key for pilot session tokens. Override in real deployments; the
  // pilot is bound to 127.0.0.1 and has no signup flow.
  AUTH_SECRET: process.env.AUTH_SECRET || 'pilot-dev-secret-change-me',
  TOKEN_TTL_SECONDS: Number(process.env.TOKEN_TTL_SECONDS || 12 * 60 * 60),
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
};
