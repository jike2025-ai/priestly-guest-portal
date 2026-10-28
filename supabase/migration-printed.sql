-- Tracks which bookings have had their registration card printed (hard copy filed).
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
alter table public.bookings add column if not exists printed_at timestamptz;
alter table public.bookings add column if not exists printed_by text;
