create table if not exists public.bot_store (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
