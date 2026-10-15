-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
-- Adds a place to store the guest's special requests (airport pickup, early check-in, notes...).
-- Safe to run more than once.
alter table public.bookings add column if not exists special_requests text;
