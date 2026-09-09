create table if not exists public.mail_worker_heartbeats (
  email_id uuid primary key references public.emails(id) on delete cascade,
  worker_id text not null,
  status text not null check (status in ('running', 'completed', 'stopped')),
  current_rate numeric not null default 0,
  target_rate numeric not null default 0,
  accepted_count bigint not null default 0,
  failed_count bigint not null default 0,
  request_count bigint not null default 0,
  last_progress_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists mail_worker_heartbeats_status_updated_idx
  on public.mail_worker_heartbeats(status, updated_at desc);

alter table public.mail_worker_heartbeats enable row level security;
grant select on public.mail_worker_heartbeats to authenticated;
grant select, insert, update on public.mail_worker_heartbeats to service_role;

drop policy if exists mail_worker_heartbeats_authenticated_select on public.mail_worker_heartbeats;
create policy mail_worker_heartbeats_authenticated_select
  on public.mail_worker_heartbeats for select to authenticated using (true);
