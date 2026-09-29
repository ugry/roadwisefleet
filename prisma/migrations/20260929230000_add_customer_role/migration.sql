-- UXF-C1 review fix (board task #74, PR #67) — put the `customer` Role row on
-- the deploy path.
--
-- The portal's signup creates `User(roleId = 'customer')`, but the deployer runs
-- exactly one DB step, `prisma migrate deploy` (roadwise-deploy-site.sh:213) — it
-- never runs the seeder. Measured on the deployed pilot 2026-09-29:
--
--   select id from "Role" order by id;   ->  accountant, dispatcher, driver, owner
--   insert into "User"(...,"roleId",...) values (..., 'customer', ...);
--     -> ERROR: violates foreign key constraint "User_roleId_fkey"
--
-- so `POST /api/customer/signup` raised Prisma P2003 and answered HTTP 500
-- before a customer could sign in, even though the route only maps P2002.
--
-- A migration is the only step guaranteed to run on every deploy, so the role
-- row belongs here. Idempotent: re-applying never fails and always leaves the
-- permission set the portal expects. Keep the array in sync with
-- `CUSTOMER_PERMISSIONS` in `customer/lib/customer-core.js` — the
-- dependency-free guard `apps/api/src/customer-role.test.js` fails if they drift.
--
-- The other four roles (owner/dispatcher/driver/accountant) are still created by
-- the pilot seeder only; that is pre-existing and deliberately out of scope.

-- InsertData
INSERT INTO "Role" (id, permissions)
VALUES ('customer', ARRAY['order:create', 'order:read', 'customer:manage'])
ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions;

-- Rollback (Prisma has no down-migration; run this by hand only once no User row
-- references the role any more):
--   DELETE FROM "Role" WHERE id = 'customer' AND NOT EXISTS (
--     SELECT 1 FROM "User" WHERE "roleId" = 'customer');
