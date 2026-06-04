create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}',
  description text,
  updated_at timestamptz default now()
);

insert into public.app_settings (key, value, description)
values (
  'daily_send_limit',
  '{"value": 65400}'::jsonb,
  'Manual daily send cap used by the queue worker. Keep below the active SES sending quota.'
)
on conflict (key) do update
set value = excluded.value,
    description = excluded.description,
    updated_at = now();
