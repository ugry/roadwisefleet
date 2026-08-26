import { PrismaClient } from '@prisma/client';

// Single Prisma client for the app. Pooling (PgBouncer) arrives when
// connections exceed ~200 (see docs/backend-infrastructure-plan.md).
export const prisma = new PrismaClient();
