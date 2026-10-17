-- Guest registration details collected on the booking form.
alter table public.bookings add column if not exists gender text;
alter table public.bookings add column if not exists nin text;
alter table public.bookings add column if not exists home_address text;
alter table public.bookings add column if not exists children text;
