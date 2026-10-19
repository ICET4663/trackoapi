CREATE TABLE "ShipmentInternalNote" (
  "id" TEXT NOT NULL,
  "shipmentId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "authorRole" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentInternalNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ShipmentInternalNote_staff_role" CHECK ("authorRole" IN ('ADMIN', 'DISPATCHER')),
  CONSTRAINT "ShipmentInternalNote_body_length" CHECK (char_length(btrim("body")) BETWEEN 1 AND 4000),
  CONSTRAINT "ShipmentInternalNote_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ShipmentInternalNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ShipmentInternalNote_shipmentId_createdAt_id_idx" ON "ShipmentInternalNote"("shipmentId", "createdAt", "id");
ALTER TABLE "ShipmentInternalNote" ENABLE ROW LEVEL SECURITY;

