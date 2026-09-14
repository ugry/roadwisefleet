import { defineConfig } from 'prisma/config';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The Prisma schema lives at the repo root (`prisma/schema.prisma`) while the
 * api package runs Prisma from `apps/api`. This config points Prisma at the
 * root schema so `prisma generate` / `prisma migrate` work from here.
 *
 * Once a Prisma config file is present the CLI stops auto-loading `.env`
 * files, which also removes the "conflict between env vars" error caused by
 * having both `apps/api/.env` and `prisma/.env` on disk. We therefore load the
 * schema-dir env file explicitly with Node 20's `process.loadEnvFile` — no
 * extra dependency, and the file stays gitignored.
 */
const here = dirname(fileURLToPath(import.meta.url));
const schemaEnv = resolve(here, '../../prisma/.env');

if (existsSync(schemaEnv)) {
  process.loadEnvFile(schemaEnv);
}

export default defineConfig({
  schema: resolve(here, '../../prisma/schema.prisma'),
  migrations: {
    seed: 'tsx scripts/seed-pilot.ts',
  },
});
