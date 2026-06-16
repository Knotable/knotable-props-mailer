-- Repair Supabase Advisor security findings and reduce high-volume query IO.
--
-- Apply this in the Supabase SQL editor if the project still reports
-- rls_disabled_in_public or Disk IO budget pressure. It is intentionally
-- idempotent so it can be re-run safely after partial migration drift.

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

alter table public.emails enable row level security;
alter table public.email_recipients enable row level security;
alter table public.draft_snapshots enable row level security;
alter table public.lists enable row level security;
alter table public.list_members enable row level security;
alter table public.profiles enable row level security;
alter table public.feature_flags enable row level security;
alter table public.mail_queue enable row level security;
alter table public.queue_metrics enable row level security;
alter table public.provider_events enable row level security;
alter table public.audit_logs enable row level security;
alter table public.error_logs enable row level security;
alter table public.admin_audit enable row level security;
alter table public.files enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists "emails: owner full access" on public.emails;
create policy "emails: owner full access"
  on public.emails
  for all
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

drop policy if exists "email_recipients: owner full access" on public.email_recipients;
create policy "email_recipients: owner full access"
  on public.email_recipients
  for all
  using (
    exists (
      select 1
      from public.emails
      where emails.id = email_recipients.email_id
        and emails.author_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.emails
      where emails.id = email_recipients.email_id
        and emails.author_id = auth.uid()
    )
  );

drop policy if exists "draft_snapshots: owner full access" on public.draft_snapshots;
create policy "draft_snapshots: owner full access"
  on public.draft_snapshots
  for all
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

drop policy if exists "lists: owner full access" on public.lists;
create policy "lists: owner full access"
  on public.lists
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "list_members: owner full access" on public.list_members;
create policy "list_members: owner full access"
  on public.list_members
  for all
  using (
    exists (
      select 1
      from public.lists
      where lists.id = list_members.list_id
        and lists.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.lists
      where lists.id = list_members.list_id
        and lists.owner_id = auth.uid()
    )
  );

drop policy if exists "profiles: own row" on public.profiles;
create policy "profiles: own row"
  on public.profiles
  for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "feature_flags: authenticated read" on public.feature_flags;
create policy "feature_flags: authenticated read"
  on public.feature_flags
  for select
  using (auth.role() = 'authenticated');

alter view if exists public.campaign_stats set (security_invoker = true);
alter view if exists public.email_send_stats set (security_invoker = true);
alter view if exists public.email_send_report set (security_invoker = true);

revoke all on table public.campaign_stats from anon;
revoke all on table public.email_send_stats from anon;
revoke all on table public.email_send_report from anon;

-- Queue monitor, health, release, report, and fallback dashboard paths.
create index if not exists mail_queue_email_status_available_idx
  on public.mail_queue (email_id, status, available_at)
  where email_id is not null;

create index if not exists mail_queue_email_updated_idx
  on public.mail_queue (email_id, updated_at desc)
  where email_id is not null;

create index if not exists mail_queue_email_created_idx
  on public.mail_queue (email_id, created_at desc)
  where email_id is not null;

create index if not exists mail_queue_email_status_send_date_idx
  on public.mail_queue (email_id, status, send_date)
  where email_id is not null;

create index if not exists mail_queue_status_updated_idx
  on public.mail_queue (status, updated_at desc);

-- SES event ingest and analytics paths.
create index if not exists provider_events_message_event_idx
  on public.provider_events (message_id, event_type)
  where message_id is not null;

create index if not exists provider_events_event_received_idx
  on public.provider_events (event_type, received_at desc);

create index if not exists provider_events_email_event_received_idx
  on public.provider_events (email_id, event_type, received_at desc)
  where email_id is not null;

create index if not exists provider_events_received_at_idx
  on public.provider_events (received_at desc);

create index if not exists list_members_email_status_idx
  on public.list_members (email, status);

create index if not exists error_logs_source_created_idx
  on public.error_logs (source, created_at desc);

notify pgrst, 'reload schema';
