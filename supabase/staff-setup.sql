-- Staff accounts, shift tracking, housekeeping and walk-in guest details.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run

-- 1) Receptionist accounts (PIN-only login). The PIN is stored as a keyed hash, never in plain text.
create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  full_name text not null,
  phone text,
  email text,
  role text not null default 'receptionist',
  shift text not null default 'any' check (shift in ('morning','night','any')),
  pin_hash text unique not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2) Who worked when: one row per login session
create table if not exists public.staff_shifts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references public.staff(id) on delete set null,
  staff_name text not null,
  role text not null,
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists staff_shifts_started on public.staff_shifts (started_at desc);

-- 3) Activity log (bookings made, cancellations, door codes, room status changes, NIN views)
create table if not exists public.staff_log (
  id bigserial primary key,
  staff_name text not null,
  role text not null,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists staff_log_created on public.staff_log (created_at desc);

-- 4) Housekeeping / maintenance status per apartment
create table if not exists public.room_status (
  room text primary key,
  status text not null default 'clean' check (status in ('clean','dirty','maintenance')),
  note text,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- 5) Failed PIN attempts (slows down guessing)
create table if not exists public.auth_fail (
  id bigserial primary key,
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_fail_ip on public.auth_fail (ip, created_at desc);

-- 6) Extra guest details collected at reception (same form as the paper "Customer's Information")
alter table public.bookings add column if not exists birth_date date;
alter table public.bookings add column if not exists city text;
alter table public.bookings add column if not exists state text;
alter table public.bookings add column if not exists payment_method text;
alter table public.bookings add column if not exists recorded_by text;

-- Lock every new table: only the server (service key) can read or write
alter table public.staff enable row level security;
alter table public.staff_shifts enable row level security;
alter table public.staff_log enable row level security;
alter table public.room_status enable row level security;
alter table public.auth_fail enable row level security;
