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
import { resolveAuthSecret } from './auth/secret.js';

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
  // HMAC key for pilot session tokens. Required: there is no committed
  // fallback. The operator sets AUTH_SECRET in the environment (or apps/api/.env);
  // startup fails fast when it is missing. Local dev/test can opt into an
  // ephemeral random secret with ALLOW_INSECURE_AUTH_SECRET=1 (or NODE_ENV=test).
  AUTH_SECRET: resolveAuthSecret(),
  TOKEN_TTL_SECONDS: Number(process.env.TOKEN_TTL_SECONDS || 12 * 60 * 60),
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  // Document storage (board task #3): local disk for the pilot, MinIO later.
  // Files are written under this directory only (path-traversal guarded in
  // documents.js) and never served directly.
  UPLOAD_DIR: process.env.UPLOAD_DIR || resolve(here, '../../../var/uploads'),
  MAX_UPLOAD_BYTES: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  // Customer tracking links (board task #5). The signing key is derived from
  // AUTH_SECRET unless TRACK_LINK_SECRET is set — set the latter to revoke every
  // outstanding link without invalidating all sessions. TTL defaults to 30 days.
  TRACK_LINK_SECRET: process.env.TRACK_LINK_SECRET || '',
  TRACK_LINK_TTL_SECONDS: Number(process.env.TRACK_LINK_TTL_SECONDS || 30 * 24 * 60 * 60),
  // Optional absolute base for generated links (e.g. https://roadwisefleet.com).
  // Empty → origin-relative `/track/<token>`, correct for the same-origin pilot.
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '',
};
