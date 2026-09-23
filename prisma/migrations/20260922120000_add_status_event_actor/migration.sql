-- Trip detail timeline (board task #2): record who performed each status
-- transition so `GET /api/trips/:id` can show the actor next to from/to/at.
-- Purely additive and nullable: existing rows stay valid with a NULL actor.

-- AlterTable
ALTER TABLE "StatusEvent" ADD COLUMN "actorId" TEXT;

-- AddForeignKey
ALTER TABLE "StatusEvent" ADD CONSTRAINT "StatusEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
