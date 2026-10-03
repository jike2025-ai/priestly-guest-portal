-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run
create extension if not exists btree_gist;

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  reference text unique not null,
  room text not null,
  check_in date not null,
  check_out date not null,
  nights int not null,
  guests int not null default 1,
  guest_name text not null,
  guest_phone text not null,
  guest_email text not null,
  rate int not null,
  caution int not null,
  total int not null,
  status text not null default 'pending'
    check (status in ('pending','confirmed','expired','failed','paid_conflict','amount_mismatch','cancelled')),
  hold_expires_at timestamptz,
  paid_at timestamptz,
  paystack_id bigint,
  channel text,
  -- caution fee refund (requested by the guest after check-out, decided by the owners after inspection)
  refund_status text not null default 'none'
    check (refund_status in ('none','requested','processing','refunded','declined')),
  refund_requested_at timestamptz,
  refund_note text,
  refund_bank text,
  refund_amount int,
  refund_method text,
  refund_decided_at timestamptz,
  refund_admin_note text,
  created_at timestamptz not null default now(),
  check (check_out > check_in),
  -- The database itself refuses overlapping stays for the same apartment.
  -- A check-out day and the next check-in day may be the same day.
  constraint no_double_booking exclude using gist (
    room with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (status in ('pending','confirmed'))
);

-- Only the server (service-role key) may touch this table. No public policies.
alter table public.bookings enable row level security;
