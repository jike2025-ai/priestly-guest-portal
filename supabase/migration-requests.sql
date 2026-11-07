-- Receptionists ask the admin to cancel or correct a walk-in booking; the admin decides.
create table if not exists public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  guest_name text,
  room text,
  check_in date,
  check_out date,
  reason text not null,
  requested_by text not null,
  created_at timestamptz not null default now(),
  status text not null default 'pending',
  resolved_by text,
  resolved_at timestamptz,
  note text
);
alter table public.booking_requests enable row level security;
create index if not exists booking_requests_status on public.booking_requests (status, created_at desc);
