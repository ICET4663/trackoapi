-- Adds the Payout table backing driver withdrawal requests and admin payout review.
-- Generated from `prisma migrate diff` against prisma/schema.prisma (not hand-written).
--
-- This project's database has no Prisma Migrate history (`prisma/migrations` does not
-- exist and the DB was provisioned via direct schema push), so this is a standalone
-- SQL script rather than a `prisma migrate` migration folder. Apply it via the Supabase
-- SQL editor or `psql "$DATABASE_URL" -f prisma/manual-sql/20260824_add_payout_table.sql`.
--
-- After applying, run `prisma generate` (with PRISMA_CLIENT_ENGINE_TYPE=binary and
-- PRISMA_CLI_QUERY_ENGINE_TYPE=binary set, per this repo's existing package.json scripts,
-- if running on 32-bit Node) so the Prisma Client picks up the new Payout model.

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "bankLabel" TEXT,
    "note" TEXT,
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payout_driverId_idx" ON "Payout"("driverId");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
