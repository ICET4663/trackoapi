-- Adds shipmentId/customerId/driverId to Conversation so a shipment thread can be
-- scoped to its actual participants. Backend code enforces "only the customer/driver
-- on the conversation (or ADMIN/DISPATCHER) may list/read/write it" once these columns
-- exist; before this, any authenticated user could list and read every conversation
-- on the platform. Existing legacy/admin-mock conversations keep working with these
-- columns left NULL.
-- Generated from `prisma migrate diff` against prisma/schema.prisma (not hand-written).
--
-- Apply after 20260826_add_admin_approval_and_reviews.sql, via the Supabase SQL editor or
-- `psql "$DATABASE_URL" -f prisma/manual-sql/20260827_scope_conversations_to_shipments.sql`.
-- Then regenerate the Prisma client (PRISMA_CLIENT_ENGINE_TYPE=binary and
-- PRISMA_CLI_QUERY_ENGINE_TYPE=binary if running on 32-bit Node, per this repo's
-- existing package.json scripts).

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "driverId" TEXT,
ADD COLUMN     "shipmentId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_customerId_idx" ON "Conversation"("customerId");

-- CreateIndex
CREATE INDEX "Conversation_driverId_idx" ON "Conversation"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_shipmentId_key" ON "Conversation"("shipmentId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
