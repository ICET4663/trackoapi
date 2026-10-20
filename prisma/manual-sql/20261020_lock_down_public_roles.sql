-- Close Supabase's public roles out of the application tables (found 19 October: RLS off
-- and anon/authenticated holding every privilege on User, Shipment, Escrow, ...).
-- The API connects as postgres and storage uses the service role; both bypass RLS, so the
-- API is unaffected. Nothing in the app uses the Supabase anon key. Safe to re-run.
begin;

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- Tables created later (manual SQL runs as postgres) do not hand the rights back.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

commit;
