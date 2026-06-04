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
  list_id uuid references public.lists on delete set null,
  ses_message_id text,
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
create index if not exists mail_queue_list_id_idx on public.mail_queue(list_id);
create index if not exists mail_queue_ses_message_id_idx on public.mail_queue(ses_message_id);
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

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}',
  description text,
  updated_at timestamptz default now()
);

-- Provider events from Mailgun webhooks
create table if not exists public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'mailgun',
  event_type text not null,
  message_id text,
  recipient text,
  email_id uuid references public.emails on delete set null,
  payload jsonb not null,
  received_at timestamptz default now()
);

create or replace function public.claim_mail_queue_batch(
  p_limit integer,
  p_email_id uuid default null,
  p_now timestamptz default now()
)
returns table (
  id uuid,
  email_id uuid,
  payload jsonb,
  list_id uuid
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select mq.id
    from public.mail_queue mq
    where mq.status = 'pending'
      and mq.available_at <= p_now
      and (p_email_id is null or mq.email_id = p_email_id)
    order by mq.available_at asc, mq.created_at asc, mq.id asc
    for update skip locked
    limit greatest(p_limit, 0)
  ),
  claimed as (
    update public.mail_queue mq
    set
      status = 'processing',
      locked_at = p_now,
      updated_at = p_now
    from candidates
    where mq.id = candidates.id
    returning mq.id, mq.email_id, mq.payload, mq.list_id
  )
  select claimed.id, claimed.email_id, claimed.payload, claimed.list_id
  from claimed;
$$;

create or replace function public.release_mail_queue_campaign(
  p_email_id uuid,
  p_now timestamptz,
  p_daily_limit integer,
  p_sent_today integer
)
returns table (
  released integer,
  due_now integer,
  scheduled_future integer
)
language sql
security definer
set search_path = public
as $$
  with settings as (
    select
      greatest(p_daily_limit, 1) as daily_limit,
      greatest(p_daily_limit - p_sent_today, 0) as remaining_today
  ),
  held as (
    select
      mq.id,
      row_number() over (order by mq.created_at asc, mq.id asc) as rn
    from public.mail_queue mq
    where mq.email_id = p_email_id
      and mq.status = 'pending'
      and mq.available_at > p_now
  ),
  planned as (
    select
      held.id,
      case
        when held.rn <= settings.remaining_today then p_now
        else (
          (
            (p_now at time zone 'UTC')::date
            + (
              ((held.rn - settings.remaining_today - 1) / settings.daily_limit)::integer
              + 1
            )
          )::text || 'T00:00:00Z'
        )::timestamptz
      end as next_available_at,
      held.rn <= settings.remaining_today as is_due_now
    from held
    cross join settings
  ),
  updated as (
    update public.mail_queue mq
    set
      available_at = planned.next_available_at,
      updated_at = p_now
    from planned
    where mq.id = planned.id
    returning planned.is_due_now
  )
  select
    count(*)::integer as released,
    count(*) filter (where is_due_now)::integer as due_now,
    count(*) filter (where not is_due_now)::integer as scheduled_future
  from updated;
$$;

-- Simple profile table for role tracking
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade,
  email text not null,
  role text not null default 'admin',
  created_at timestamptz default now(),
  primary key (id)
);

-- Row-Level Security placeholders (enable manually in Supabase)
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
