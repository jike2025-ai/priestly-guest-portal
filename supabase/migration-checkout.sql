-- Late and early check-outs: lets reception override the automatic 12:00 noon check-out.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
alter table public.bookings add column if not exists checked_out_at timestamptz;
alter table public.bookings add column if not exists checked_out_by text;
alter table public.bookings add column if not exists late_stay boolean not null default false;
