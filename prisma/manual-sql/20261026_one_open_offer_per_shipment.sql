-- At most one open driver offer or accepted driver per shipment. The API already checks
-- this before offering, but two matching runs at the same instant (approval, a driver
-- coming online, the dispatch sweep) could both pass the check; the index makes the
-- second insert fail, and the API reports "already has a driver offer". Safe to re-run.
-- Stops without changing anything if existing rows already break the rule.
begin;

do $$
declare
  duplicates integer;
begin
  select count(*) into duplicates from (
    select "shipmentId"
    from "DriverAssignment"
    where "status" in ('OFFERED', 'ACCEPTED')
    group by "shipmentId"
    having count(*) > 1
  ) as clashes;
  if duplicates > 0 then
    raise exception '% shipment(s) already have more than one open or accepted assignment; resolve them first (select "shipmentId", "id", "status" from "DriverAssignment" where "status" in (''OFFERED'', ''ACCEPTED'') order by 1)', duplicates;
  end if;
end $$;

create unique index if not exists "DriverAssignment_one_open_per_shipment"
  on "DriverAssignment"("shipmentId") where "status" in ('OFFERED', 'ACCEPTED');

commit;
