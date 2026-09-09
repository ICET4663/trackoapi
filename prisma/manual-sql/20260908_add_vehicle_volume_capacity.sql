alter table "Vehicle"
  add column if not exists "capacityM3" double precision;

update "Vehicle"
set "capacityM3" = case
  when lower("type") like '%box%' then 45
  when lower("type") like '%flatbed%' then 55
  when lower("type") like '%tipper%' then 18
  when lower("type") like '%tanker%' then 38
  else 40
end
where "capacityM3" is null;
