-- Enforce Row Level Security on every public app table.
--
-- Supabase Advisor reported `rls_disabled_in_public` for this project on
-- 2026-06-04. The older RLS migration was not applied to the live database,
-- and app_settings was added later. This migration is intentionally
-- idempotent so it can be pasted into the Supabase SQL editor as a repair.

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

-- Internal/system tables intentionally have no anon/authenticated policies.
-- The app's server-side service-role client bypasses RLS and remains able to
-- read/write these tables. Public anon and user-session clients get no rows.

alter view if exists public.campaign_stats set (security_invoker = true);
alter view if exists public.email_send_stats set (security_invoker = true);
alter view if exists public.email_send_report set (security_invoker = true);

revoke all on table public.campaign_stats from anon;
revoke all on table public.email_send_stats from anon;
revoke all on table public.email_send_report from anon;
