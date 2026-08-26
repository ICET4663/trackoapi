-- Adds: (1) admin-approval fields on Shipment, gating funded shipments before dispatch
-- can assign a driver, and (2) the Review table backing the Rate & Review feature.
-- Generated from `prisma migrate diff` against prisma/schema.prisma (not hand-written).
--
-- Apply after 20260824_add_payout_table.sql, via the Supabase SQL editor or
-- `psql "$DATABASE_URL" -f prisma/manual-sql/20260826_add_admin_approval_and_reviews.sql`.
-- Then regenerate the Prisma client (PRISMA_CLIENT_ENGINE_TYPE=binary and
-- PRISMA_CLI_QUERY_ENGINE_TYPE=binary if running on 32-bit Node, per this repo's
-- existing package.json scripts).

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "adminApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "adminApprovedAt" TIMESTAMP(3),
ADD COLUMN     "adminApprovedById" TEXT;

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "driverId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_shipmentId_key" ON "Review"("shipmentId");

-- CreateIndex
CREATE INDEX "Review_driverId_idx" ON "Review"("driverId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
