-- Fixes two live production bugs, both the same root cause (schema.prisma changed after
-- the initial hand-written SQL, and the follow-up ALTER was never run against production):
--
-- 1. "DriverDocument" was created early (backend-stage-two.sql) before the document-
--    review workflow (uploadDriverDocument()'s admin approve/reject path,
--    settings.service.ts) added reviewNote/reviewedAt/reviewedById to the Prisma schema.
--    Every read of a driver's documents (GET /v1/driver/documents) currently fails with:
--      column "reviewNote" does not exist
--    which breaks the "Driver documents" screen for every driver on the platform.
--
-- 2. "DriverDocumentState" was originally created with only 3 values (VERIFIED, EXPIRING,
--    MISSING) - PENDING_REVIEW and REJECTED were added to the Prisma schema later to give
--    the document-review lifecycle its own real states, but the live Postgres enum type
--    was never updated to match. Since EVERY document upload (uploadDriverDocument() and
--    uploadVehicleDocument()) sets the new row's state to 'PENDING_REVIEW', and
--    pendingVehicleDocuments()/admin review queries filter on it too, this currently
--    breaks the actual upload flow end-to-end on production - the media file itself
--    uploads fine (that part was already fixed), but creating the DriverDocument/
--    VehicleDocument record that tracks it fails with:
--      invalid input value for enum "DriverDocumentState": "PENDING_REVIEW"
--
-- Safe to run even if some/all of these already exist. ALTER TYPE ... ADD VALUE cannot
-- run inside an explicit transaction block on older Postgres, but Supabase's SQL editor
-- runs each statement standalone, so this is safe to paste and run as-is.

alter table public."DriverDocument"
  add column if not exists "reviewNote" text,
  add column if not exists "reviewedAt" timestamptz,
  add column if not exists "reviewedById" text references public."User"("id");

alter type public."DriverDocumentState" add value if not exists 'PENDING_REVIEW';
alter type public."DriverDocumentState" add value if not exists 'REJECTED';
