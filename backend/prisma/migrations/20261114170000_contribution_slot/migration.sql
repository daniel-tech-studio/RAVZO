-- DropIndex
DROP INDEX "PlannedContribution_goalId_dueAt_kind_key";

-- AlterTable
ALTER TABLE "PlannedContribution" ADD COLUMN     "slotKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PlannedContribution_goalId_slotKey_key" ON "PlannedContribution"("goalId", "slotKey");

