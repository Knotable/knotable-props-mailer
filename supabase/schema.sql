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
create index if not exists error_logs_source_created_idx on public.error_logs(source, created_at desc);

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
create index if not exists list_members_email_status_idx on public.list_members(email, status);

create table if not exists public.unsubscribe_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  source_email_id uuid references public.emails on delete set null,
  list_id uuid references public.lists on delete set null,
  request_type text not null default 'reply' check (request_type in ('reply','mailto','manual','complaint','bounce')),
  status text not null default 'open' check (status in ('open','handled','ignored')),
  raw_message_ref text,
  notes text,
  requested_at timestamptz default now(),
  handled_at timestamptz,
  handled_by uuid references auth.users on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists unsubscribe_requests_email_status_idx
  on public.unsubscribe_requests (lower(email), status, requested_at desc);
create index if not exists unsubscribe_requests_source_email_idx
  on public.unsubscribe_requests (source_email_id)
  where source_email_id is not null;
create index if not exists unsubscribe_requests_list_idx
  on public.unsubscribe_requests (list_id)
  where list_id is not null;

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

create index if not exists provider_events_message_event_idx
  on public.provider_events (message_id, event_type)
  where message_id is not null;
create index if not exists provider_events_event_received_idx
  on public.provider_events (event_type, received_at desc);
create index if not exists provider_events_email_event_received_idx
  on public.provider_events (email_id, event_type, received_at desc)
  where email_id is not null;
create index if not exists provider_events_email_event_recipient_idx
  on public.provider_events (email_id, event_type, lower(recipient))
  where email_id is not null;
create index if not exists provider_events_received_at_idx
  on public.provider_events (received_at desc);
create index if not exists provider_events_email_received_idx
  on public.provider_events (email_id, received_at desc)
  where email_id is not null;

create index if not exists emails_analytics_created_idx
  on public.emails (created_at desc)
  where status <> 'draft';

create or replace function public.get_recent_email_analytics_stats(
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  email_id uuid,
  subject text,
  from_address text,
  status text,
  created_at timestamptz,
  list_ids uuid[],
  sent bigint,
  failed bigint,
  pending bigint,
  canceled bigint,
  delivered bigint,
  bounced bigint,
  complained bigint,
  opened bigint,
  clicked bigint,
  first_sent date,
  last_queued_at timestamptz,
  latest_event_at timestamptz,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with selected_emails as (
    select
      e.id,
      e.subject,
      e.from_address,
      e.status,
      e.created_at,
      count(*) over () as total_count
    from public.emails e
    where e.status <> 'draft'
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 100))
    offset greatest(0, coalesce(p_offset, 0))
  )
  select
    e.id as email_id,
    e.subject,
    e.from_address,
    e.status,
    e.created_at,
    coalesce(lists.list_ids, array[]::uuid[]) as list_ids,
    coalesce(succeeded.sent, 0) as sent,
    coalesce(failures.failed, 0) as failed,
    coalesce(active.pending, 0) as pending,
    coalesce(canceled_rows.canceled, 0) as canceled,
    coalesce(events.delivered, 0) as delivered,
    coalesce(events.bounced, 0) as bounced,
    coalesce(events.complained, 0) as complained,
    coalesce(events.opened, 0) as opened,
    coalesce(events.clicked, 0) as clicked,
    succeeded.first_sent,
    coalesce(last_queue.last_queued_at, e.created_at) as last_queued_at,
    events.latest_event_at,
    e.total_count
  from selected_emails e
  left join lateral (
    select
      count(*) as sent,
      min(mq.send_date) as first_sent
    from public.mail_queue mq
    where mq.email_id = e.id
      and mq.status = 'succeeded'
  ) succeeded on true
  left join lateral (
    select count(*) as failed
    from public.mail_queue mq
    where mq.email_id = e.id
      and mq.status in ('failed', 'dead')
  ) failures on true
  left join lateral (
    select count(*) as pending
    from public.mail_queue mq
    where mq.email_id = e.id
      and mq.status in ('pending', 'processing')
  ) active on true
  left join lateral (
    select count(*) as canceled
    from public.mail_queue mq
    where mq.email_id = e.id
      and mq.status = 'canceled'
  ) canceled_rows on true
  left join lateral (
    select mq.created_at as last_queued_at
    from public.mail_queue mq
    where mq.email_id = e.id
    order by mq.created_at desc
    limit 1
  ) last_queue on true
  left join lateral (
    select array_agg(list_id order by list_id) as list_ids
    from (
      select distinct mq.list_id
      from public.mail_queue mq
      where mq.email_id = e.id
        and mq.list_id is not null
      limit 1000
    ) distinct_lists
  ) lists on true
  left join lateral (
    select
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'delivered' and pe.recipient is not null
      ) as delivered,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'bounced' and pe.recipient is not null
      ) as bounced,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'complained' and pe.recipient is not null
      ) as complained,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'opened' and pe.recipient is not null
      ) as opened,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'clicked' and pe.recipient is not null
      ) as clicked,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    where pe.email_id = e.id
      and pe.event_type in ('delivered', 'bounced', 'complained', 'opened', 'clicked')
  ) events on true
  order by e.created_at desc;
$$;

grant execute on function public.get_recent_email_analytics_stats(integer, integer)
  to authenticated, service_role;

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
    join public.emails e on e.id = mq.email_id
    where mq.status = 'pending'
      and mq.available_at <= p_now
      and e.status in ('queued', 'sending', 'sent')
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
  role text not null default 'user' check (role in ('admin', 'user')),
  can_send boolean not null default false,
  created_at timestamptz default now(),
  primary key (id)
);

update public.profiles
set role = 'admin',
    can_send = true
where lower(email) = 'a@sarva.co';

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
alter table public.unsubscribe_requests enable row level security;

drop policy if exists "emails: owner full access" on public.emails;
drop policy if exists "emails: authenticated shared access" on public.emails;
create policy "emails: authenticated shared access"
  on public.emails
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "email_recipients: owner full access" on public.email_recipients;
drop policy if exists "email_recipients: authenticated shared access" on public.email_recipients;
create policy "email_recipients: authenticated shared access"
  on public.email_recipients
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "draft_snapshots: owner full access" on public.draft_snapshots;
drop policy if exists "draft_snapshots: authenticated shared access" on public.draft_snapshots;
create policy "draft_snapshots: authenticated shared access"
  on public.draft_snapshots
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "lists: owner full access" on public.lists;
drop policy if exists "lists: authenticated shared access" on public.lists;
create policy "lists: authenticated shared access"
  on public.lists
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "list_members: owner full access" on public.list_members;
drop policy if exists "list_members: authenticated shared access" on public.list_members;
create policy "list_members: authenticated shared access"
  on public.list_members
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

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

drop policy if exists "unsubscribe_requests: authenticated full access" on public.unsubscribe_requests;
create policy "unsubscribe_requests: authenticated full access"
  on public.unsubscribe_requests
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
