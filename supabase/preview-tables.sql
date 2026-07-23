-- Tracko preview tables for the current Expo app.
-- Run this in Supabase SQL Editor to support the app's direct Supabase reads during development.
-- These tables use quoted names because the current frontend calls names such as "active-trips".

create table if not exists public."active-trips" (
  id text primary key,
  sender text,
  "senderInitial" text,
  receiver text,
  origin text,
  destination text,
  cargo text,
  distance text,
  eta text,
  "stageIndex" integer default 0,
  completed boolean default false,
  "createdAt" timestamptz default now()
);

insert into public."active-trips" (id, sender, "senderInitial", receiver, origin, destination, cargo, distance, eta, "stageIndex", completed)
values
  ('TRK-1024', 'Tracko Customer', 'TC', 'Abuja Receiver', 'Lagos', 'Abuja', 'Consumer goods', '752 km', 'Today, 6:30 PM', 2, false)
on conflict (id) do nothing;

create table if not exists public."customer-shipments" (
  id text primary key,
  status text,
  date text,
  month text,
  origin text,
  destination text,
  commodity text,
  amount text,
  meta text,
  "createdAt" timestamptz default now()
);

insert into public."customer-shipments" (id, status, date, month, origin, destination, commodity, amount, meta)
values
  ('TRK-1024', 'IN_TRANSIT', '21', 'JUL', 'Lagos', 'Abuja', 'Consumer goods', 'N240,000', 'Preview shipment')
on conflict (id) do nothing;

create table if not exists public."wallet-transactions" (
  id text primary key,
  title text,
  amount text,
  type text,
  date text,
  status text,
  "createdAt" timestamptz default now()
);

create table if not exists public."owner-trucks" (
  id text primary key,
  reg text,
  type text,
  capacity text,
  year text,
  status text,
  base text,
  "assignedDriver" text,
  documents text,
  "createdAt" timestamptz default now()
);

create table if not exists public."seeking-drivers" (
  id text primary key,
  name text,
  rating numeric,
  location text,
  truck text,
  "createdAt" timestamptz default now()
);

create table if not exists public."dispatcher-shipments" (
  id text primary key,
  status text,
  origin text,
  destination text,
  driver text,
  truck text,
  eta text,
  "createdAt" timestamptz default now()
);

create table if not exists public."dispatcher-disputes" (
  id text primary key,
  title text,
  status text,
  priority text,
  "createdAt" timestamptz default now()
);

create table if not exists public."platform-users" (
  id text primary key,
  name text,
  role text,
  status text,
  email text,
  phone text,
  "createdAt" timestamptz default now()
);

create table if not exists public."operation-drivers" (
  id text primary key,
  name text,
  status text,
  location text,
  rating numeric,
  "createdAt" timestamptz default now()
);

create table if not exists public."operation-shipments" (
  id text primary key,
  status text,
  origin text,
  destination text,
  customer text,
  driver text,
  "createdAt" timestamptz default now()
);

alter table public."active-trips" enable row level security;
alter table public."customer-shipments" enable row level security;
alter table public."wallet-transactions" enable row level security;
alter table public."owner-trucks" enable row level security;
alter table public."seeking-drivers" enable row level security;
alter table public."dispatcher-shipments" enable row level security;
alter table public."dispatcher-disputes" enable row level security;
alter table public."platform-users" enable row level security;
alter table public."operation-drivers" enable row level security;
alter table public."operation-shipments" enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'active-trips',
    'customer-shipments',
    'wallet-transactions',
    'owner-trucks',
    'seeking-drivers',
    'dispatcher-shipments',
    'dispatcher-disputes',
    'platform-users',
    'operation-drivers',
    'operation-shipments'
  ]
  loop
    execute format('drop policy if exists "preview_select_%s" on public.%I', replace(table_name, '-', '_'), table_name);
    execute format('create policy "preview_select_%s" on public.%I for select using (true)', replace(table_name, '-', '_'), table_name);
  end loop;
end $$;
