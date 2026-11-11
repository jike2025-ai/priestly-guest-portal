-- Which Smart Life "arrival" scene runs for each apartment (set from alexa-setup.html).
create table if not exists public.room_scenes (
  room text primary key,
  scene_id text not null,
  updated_at timestamptz not null default now()
);
alter table public.room_scenes enable row level security;
