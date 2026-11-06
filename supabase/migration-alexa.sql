-- Alexa welcome greeting: which Echo is in which apartment, plus a "already greeted" marker per booking.
create table if not exists public.echo_devices (
  device_id text primary key,
  room text,
  label text,
  last_seen timestamptz not null default now()
);
alter table public.echo_devices enable row level security;
alter table public.bookings add column if not exists greeted_at timestamptz;
alter table public.bookings add column if not exists say_name text;
