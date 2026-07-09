insert into public.app_settings (key, value, description, updated_at)
values
  (
    'ses_max_send_rate_per_second',
    '{"value":15}'::jsonb,
    'Amazon SES maximum send rate in recipients per second for the active region.',
    now()
  )
on conflict (key) do update
set
  value = excluded.value,
  description = excluded.description,
  updated_at = now();
