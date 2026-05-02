-- Emails & recipients
create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  from_address text not null,
  reply_to text,
  subject text not null,
  html text not null,
  text text,
  status text not null check (status in ('draft','queued','sending','sent','failed','canceled')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  is_test boolean default false,
  campaigns text[] default '{}',
  tags text[] default '{}',
  revision integer not null default 1,
  last_snapshot_id uuid,
  last_autosaved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists emails_author_idx on public.emails(author_id);

create table if not exists public.email_recipients (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references public.emails on delete cascade,
  recipient_address text not null,
  status text not null default 'pending',
  last_event text,
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists email_recipients_email_idx on public.email_recipients(email_id);

-- Draft snapshots for autosave + history
create table if not exists public.draft_snapshots (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references public.emails on delete cascade,
  author_id uuid not null,
  revision integer not null,
  payload jsonb not null,
  diff_summary text,
  created_at timestamptz default now()
);

create index if not exists draft_snapshots_email_idx on public.draft_snapshots(email_id);

-- Error + audit logging
create table if not exists public.error_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  source text not null,
  message text not null,
  stack text,
  payload jsonb,
  correlation_id text,
  created_at timestamptz default now()
);

create index if not exists error_logs_correlation_idx on public.error_logs(correlation_id);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  action text not null,
  entity text,
  entity_id uuid,
  payload jsonb,
  created_at timestamptz default now()
);

-- Queue for outbound mail reliability
create table if not exists public.mail_queue (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references public.emails on delete cascade,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','succeeded','failed','dead','canceled')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  dedupe_hash text,
  rate_limit_bucket text,
  available_at timestamptz default now(),
  locked_at timestamptz,
  last_error text,
  correlation_id text,
  last_heartbeat timestamptz,
  -- daily quota tracking
  send_date date,           -- set to the calendar day the item was sent (UTC)
  campaign_label text,      -- links multi-day batches of the same campaign
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists mail_queue_status_idx on public.mail_queue(status, available_at);
create index if not exists mail_queue_send_date_status_idx on public.mail_queue(send_date, status);
create index if not exists mail_queue_campaign_label_idx on public.mail_queue(campaign_label);
create unique index if not exists mail_queue_dedupe_hash_unique_idx on public.mail_queue(dedupe_hash);

create table if not exists public.queue_metrics (
  id uuid primary key default gen_random_uuid(),
  queue_depth integer not null,
  processed_count integer not null,
  failed_count integer not null,
  last_run_at timestamptz default now()
);

-- Feature flags for safe rollouts
create table if not exists public.feature_flags (
  key text primary key,
  description text,
  enabled boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Admin action audit trail
create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  action text not null,
  target text,
  metadata jsonb,
  created_at timestamptz default now()
);

-- Files stored in Supabase Storage (optional metadata table)
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  creator_id uuid,
  created_at timestamptz default now()
);

-- Mailing lists
create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  address text not null,
  description text,
  mailgun_list_id text,
  access_level text default 'readonly',
  synced_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists lists_address_idx on public.lists(address);

create table if not exists public.list_members (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references public.lists on delete cascade,
  email text not null,
  status text default 'active',
  source text default 'manual',
  subscribed_at timestamptz default now(),
  unsubscribed_at timestamptz,
  metadata jsonb default '{}'
);

create index if not exists list_members_list_idx on public.list_members(list_id);
create unique index if not exists list_members_list_email_idx on public.list_members(list_id, email);

-- RLS policies placeholders
-- alter table public.emails enable row level security;
-- create policy "user owns draft" on public.emails for select using (auth.uid() = author_id);

-- Provider events from Mailgun webhooks
create table if not exists public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'mailgun',
  event_type text not null,
  message_id text,
  recipient text,
  payload jsonb not null,
  received_at timestamptz default now()
);

-- Simple profile table for role tracking
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade,
  email text not null,
  role text not null default 'admin',
  created_at timestamptz default now(),
  primary key (id)
);

-- Row-Level Security placeholders (enable manually in Supabase)
-- alter table public.emails enable row level security;
-- create policy "Admins can do anything" on public.emails for all using (auth.uid() = author_id);
