import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

// Single Prisma client for the app. Pooling (PgBouncer) arrives when
// connections exceed ~200 (see docs/backend-infrastructure-plan.md).
// `datasourceUrl` is passed explicitly so the connection string comes from the
// loaded `.env` rather than depending on import evaluation order.
export const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
