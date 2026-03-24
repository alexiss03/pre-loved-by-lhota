create table if not exists public.app_state (
  id bigint primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state disable row level security;
grant usage on schema public to anon, authenticated;
grant select, insert, update on table public.app_state to anon, authenticated;

insert into public.app_state (id, state)
values (
  1,
  '{}'::jsonb
)
on conflict (id) do nothing;
