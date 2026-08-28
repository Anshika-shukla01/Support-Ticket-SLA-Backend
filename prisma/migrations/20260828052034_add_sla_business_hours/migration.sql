/*
  Warnings:

  - You are about to drop the column `slaDeadline` on the `Ticket` table. All the data in the column will be lost.
  - You are about to drop the column `slaStatus` on the `Ticket` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Ticket_slaStatus_idx";

-- AlterTable
ALTER TABLE "Ticket" DROP COLUMN "slaDeadline",
DROP COLUMN "slaStatus",
ADD COLUMN     "firstResponseDueAt" TIMESTAMP(3),
ADD COLUMN     "resolutionDueAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_date_key" ON "Holiday"("date");

-- CreateIndex
CREATE INDEX "Ticket_firstResponseDueAt_idx" ON "Ticket"("firstResponseDueAt");

-- CreateIndex
CREATE INDEX "Ticket_resolutionDueAt_idx" ON "Ticket"("resolutionDueAt");
