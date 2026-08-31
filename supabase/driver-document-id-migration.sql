-- Fixes existing DriverDocument rows created before the per-user id scoping fix
-- (trackoapi commit 07b791c). Before that fix, the row id was the bare document type
-- ("license" / "insurance") with no per-user scoping - a global primary key shared by
-- every driver. If more than one driver ever uploaded the same document type, only the
-- LAST uploader's file/data survived under that shared row (the row's own userId column
-- still correctly reflects whoever uploaded last).
--
-- Run the SELECT first to see what's actually there before changing anything.

-- 1) READ-ONLY CHECK: any row still using the old bare-slug id format is a legacy row
-- that needs migrating. Compare its userId against your own records if you want to
-- confirm whether that user is the "last uploader" and not a driver who lost their file.
select "id", "userId", "title", "state", "fileUrl", "createdAt", "updatedAt"
from "DriverDocument"
where "id" in ('license', 'insurance');

-- 2) MIGRATION: renames each legacy row's id to the new `${userId}_${id}` format, so it
-- becomes visible again under its rightful owner instead of orphaned. Safe to run even if
-- there's nothing to migrate (the WHERE clause simply matches zero rows). Skips a rename
-- if a row already exists at the target id (shouldn't happen, but do-nothing is safer
-- than erroring out or overwriting).
update "DriverDocument" d
set "id" = d."userId" || '_' || d."id"
where d."id" in ('license', 'insurance')
  and not exists (
    select 1 from "DriverDocument" existing
    where existing."id" = d."userId" || '_' || d."id"
  );
