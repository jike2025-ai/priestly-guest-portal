-- Calendar sync with Airbnb, Booking.com and Lodgers (one calendar link per apartment per website)
create table if not exists public.ical_feeds (
  id uuid primary key default gen_random_uuid(),
  room text not null,
  channel text not null check (channel in ('airbnb','booking','lodgers')),
  url text not null,
  last_sync timestamptz,
  last_status text,
  last_count int,
  created_at timestamptz not null default now(),
  unique (room, channel)
);
alter table public.ical_feeds enable row level security;
