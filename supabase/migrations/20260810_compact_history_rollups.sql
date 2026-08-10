-- Compact terminal queue and raw provider history into one row per campaign.
-- The archive/purge script calls refresh_email_history_rollups() only after a
-- complete local NDJSON archive has passed count and SHA-256 verification.

create table if not exists public.email_history_rollups (
  email_id uuid primary key references public.emails(id) on delete cascade,
  total_queued bigint not null default 0,
  succeeded bigint not null default 0,
  failed bigint not null default 0,
  dead bigint not null default 0,
  canceled bigint not null default 0,
  permanent_failures bigint not null default 0,
  with_ses_message_id bigint not null default 0,
  list_ids uuid[] not null default '{}',
  first_queued_at timestamptz,
  last_updated_at timestamptz,
  first_send_date date,
  last_send_date date,
  delivered_unique bigint not null default 0,
  bounced_unique bigint not null default 0,
  complained_unique bigint not null default 0,
  opened_unique bigint not null default 0,
  clicked_unique bigint not null default 0,
  delivery_events bigint not null default 0,
  bounce_events bigint not null default 0,
  complaint_events bigint not null default 0,
  open_events bigint not null default 0,
  click_events bigint not null default 0,
  first_event_at timestamptz,
  latest_event_at timestamptz,
  archived_through timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.email_history_rollups enable row level security;
drop policy if exists "email_history_rollups: authenticated read" on public.email_history_rollups;
create policy "email_history_rollups: authenticated read"
  on public.email_history_rollups for select to authenticated using (true);
grant select on public.email_history_rollups to authenticated, service_role;

create or replace function public.refresh_email_history_rollups(p_cutoff timestamptz)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  affected bigint;
begin
  insert into public.email_history_rollups (
    email_id, total_queued, succeeded, failed, dead, canceled,
    permanent_failures, with_ses_message_id, list_ids,
    first_queued_at, last_updated_at, first_send_date, last_send_date,
    delivered_unique, bounced_unique, complained_unique, opened_unique, clicked_unique,
    delivery_events, bounce_events, complaint_events, open_events, click_events,
    first_event_at, latest_event_at, archived_through, updated_at
  )
  with queue_agg as (
    select
      mq.email_id,
      count(*) as total_queued,
      count(*) filter (where mq.status = 'succeeded') as succeeded,
      count(*) filter (where mq.status = 'failed') as failed,
      count(*) filter (where mq.status = 'dead') as dead,
      count(*) filter (where mq.status = 'canceled') as canceled,
      count(*) filter (where mq.status = 'dead' and mq.attempts = 999) as permanent_failures,
      count(*) filter (where mq.ses_message_id is not null) as with_ses_message_id,
      coalesce(array_agg(distinct mq.list_id) filter (where mq.list_id is not null), '{}') as list_ids,
      min(mq.created_at) as first_queued_at,
      max(mq.updated_at) as last_updated_at,
      min(mq.send_date) as first_send_date,
      max(mq.send_date) as last_send_date
    from public.mail_queue mq
    where mq.email_id is not null
      and mq.updated_at < p_cutoff
      and mq.status in ('succeeded','failed','dead','canceled')
    group by mq.email_id
  ), event_agg as (
    select
      pe.email_id,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'delivered' and pe.recipient is not null) as delivered_unique,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'bounced' and pe.recipient is not null) as bounced_unique,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'complained' and pe.recipient is not null) as complained_unique,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'opened' and pe.recipient is not null) as opened_unique,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'clicked' and pe.recipient is not null) as clicked_unique,
      count(*) filter (where pe.event_type = 'delivered') as delivery_events,
      count(*) filter (where pe.event_type = 'bounced') as bounce_events,
      count(*) filter (where pe.event_type = 'complained') as complaint_events,
      count(*) filter (where pe.event_type = 'opened') as open_events,
      count(*) filter (where pe.event_type = 'clicked') as click_events,
      min(pe.received_at) as first_event_at,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    where pe.email_id is not null and pe.received_at < p_cutoff
    group by pe.email_id
  ), ids as (
    select email_id from queue_agg union select email_id from event_agg
  )
  select
    ids.email_id,
    coalesce(q.total_queued, 0), coalesce(q.succeeded, 0), coalesce(q.failed, 0),
    coalesce(q.dead, 0), coalesce(q.canceled, 0), coalesce(q.permanent_failures, 0),
    coalesce(q.with_ses_message_id, 0), coalesce(q.list_ids, '{}'),
    q.first_queued_at, q.last_updated_at, q.first_send_date, q.last_send_date,
    coalesce(e.delivered_unique, 0), coalesce(e.bounced_unique, 0),
    coalesce(e.complained_unique, 0), coalesce(e.opened_unique, 0), coalesce(e.clicked_unique, 0),
    coalesce(e.delivery_events, 0), coalesce(e.bounce_events, 0),
    coalesce(e.complaint_events, 0), coalesce(e.open_events, 0), coalesce(e.click_events, 0),
    e.first_event_at, e.latest_event_at, p_cutoff, now()
  from ids
  left join queue_agg q using (email_id)
  left join event_agg e using (email_id)
  on conflict (email_id) do update set
    total_queued = excluded.total_queued,
    succeeded = excluded.succeeded,
    failed = excluded.failed,
    dead = excluded.dead,
    canceled = excluded.canceled,
    permanent_failures = excluded.permanent_failures,
    with_ses_message_id = excluded.with_ses_message_id,
    list_ids = excluded.list_ids,
    first_queued_at = excluded.first_queued_at,
    last_updated_at = excluded.last_updated_at,
    first_send_date = excluded.first_send_date,
    last_send_date = excluded.last_send_date,
    delivered_unique = excluded.delivered_unique,
    bounced_unique = excluded.bounced_unique,
    complained_unique = excluded.complained_unique,
    opened_unique = excluded.opened_unique,
    clicked_unique = excluded.clicked_unique,
    delivery_events = excluded.delivery_events,
    bounce_events = excluded.bounce_events,
    complaint_events = excluded.complaint_events,
    open_events = excluded.open_events,
    click_events = excluded.click_events,
    first_event_at = excluded.first_event_at,
    latest_event_at = excluded.latest_event_at,
    archived_through = excluded.archived_through,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end
$$;

grant execute on function public.refresh_email_history_rollups(timestamptz) to service_role;

-- Campaign-level reporting sums the compact archive and any rows created after
-- the archive cutoff. Recipient-level detail intentionally remains offline.
create or replace view public.email_send_report as
with live_queue as (
  select
    email_id,
    count(*) as total_queued,
    count(*) filter (where status = 'succeeded') as succeeded,
    count(*) filter (where status = 'dead') as dead,
    count(*) filter (where status = 'pending') as pending,
    count(*) filter (where status = 'processing') as processing,
    count(*) filter (where status = 'canceled') as canceled,
    count(*) filter (where status = 'dead' and attempts = 999) as permanent_failures,
    min(created_at) as first_queued_at,
    max(updated_at) as last_updated_at,
    min(send_date) as first_send_date,
    max(send_date) as last_send_date
  from public.mail_queue where email_id is not null group by email_id
), live_events as (
  select
    email_id,
    count(distinct lower(recipient)) filter (where event_type = 'delivered' and recipient is not null) as delivered,
    count(distinct lower(recipient)) filter (where event_type = 'bounced' and recipient is not null) as bounced,
    count(distinct lower(recipient)) filter (where event_type = 'complained' and recipient is not null) as complained,
    count(distinct lower(recipient)) filter (where event_type = 'opened' and recipient is not null) as opened,
    count(distinct lower(recipient)) filter (where event_type = 'clicked' and recipient is not null) as clicked
  from public.provider_events where email_id is not null group by email_id
), ids as (
  select email_id from public.email_history_rollups
  union select email_id from live_queue
  union select email_id from live_events
)
select
  ids.email_id,
  coalesce(r.total_queued, 0) + coalesce(q.total_queued, 0) as total_queued,
  coalesce(r.succeeded, 0) + coalesce(q.succeeded, 0) as succeeded,
  coalesce(r.dead, 0) + coalesce(q.dead, 0) as dead,
  coalesce(q.pending, 0) as pending,
  coalesce(q.processing, 0) as processing,
  coalesce(r.canceled, 0) + coalesce(q.canceled, 0) as canceled,
  greatest(coalesce(r.delivered_unique, 0), coalesce(ev.delivered, 0)) as delivered,
  greatest(coalesce(r.bounced_unique, 0), coalesce(ev.bounced, 0)) as bounced,
  greatest(coalesce(r.complained_unique, 0), coalesce(ev.complained, 0)) as complained,
  greatest(coalesce(r.opened_unique, 0), coalesce(ev.opened, 0)) as opened,
  greatest(coalesce(r.clicked_unique, 0), coalesce(ev.clicked, 0)) as clicked,
  coalesce(r.permanent_failures, 0) + coalesce(q.permanent_failures, 0) as permanent_failures,
  least(r.first_queued_at, q.first_queued_at) as first_queued_at,
  greatest(r.last_updated_at, q.last_updated_at) as last_updated_at,
  least(r.first_send_date, q.first_send_date) as first_send_date,
  greatest(r.last_send_date, q.last_send_date) as last_send_date
from ids
left join public.email_history_rollups r using (email_id)
left join live_queue q using (email_id)
left join live_events ev using (email_id);

alter view public.email_send_report set (security_invoker = true);
revoke all on table public.email_send_report from anon;
grant select on table public.email_send_report to authenticated, service_role;

create or replace function public.get_recent_email_analytics_stats(
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  email_id uuid, subject text, from_address text, status text, created_at timestamptz,
  list_ids uuid[], sent bigint, failed bigint, pending bigint, canceled bigint,
  delivered bigint, bounced bigint, complained bigint, opened bigint, clicked bigint,
  first_sent date, last_queued_at timestamptz, latest_event_at timestamptz, total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with selected as (
    select e.*, count(*) over () as result_total
    from public.emails e
    where e.status <> 'draft'
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 100))
    offset greatest(0, coalesce(p_offset, 0))
  )
  select
    e.id, e.subject, e.from_address, e.status, e.created_at,
    case when cardinality(coalesce(h.list_ids, '{}')) > 0 then h.list_ids else coalesce(q.list_ids, '{}') end,
    coalesce(h.succeeded, 0) + coalesce(q.succeeded, 0),
    coalesce(h.failed, 0) + coalesce(h.dead, 0) + coalesce(q.failed, 0),
    coalesce(q.pending, 0),
    coalesce(h.canceled, 0) + coalesce(q.canceled, 0),
    coalesce(h.delivered_unique, 0) + coalesce(ev.delivered, 0),
    coalesce(h.bounced_unique, 0) + coalesce(ev.bounced, 0),
    coalesce(h.complained_unique, 0) + coalesce(ev.complained, 0),
    coalesce(h.opened_unique, 0) + coalesce(ev.opened, 0),
    coalesce(h.clicked_unique, 0) + coalesce(ev.clicked, 0),
    coalesce(h.first_send_date, q.first_sent),
    coalesce(greatest(h.last_updated_at, q.last_queued_at), h.last_updated_at, q.last_queued_at, e.created_at),
    coalesce(greatest(h.latest_event_at, ev.latest_event_at), h.latest_event_at, ev.latest_event_at),
    e.result_total
  from selected e
  left join public.email_history_rollups h on h.email_id = e.id
  left join lateral (
    select
      count(*) filter (where mq.status = 'succeeded') as succeeded,
      count(*) filter (where mq.status in ('failed','dead')) as failed,
      count(*) filter (where mq.status in ('pending','processing')) as pending,
      count(*) filter (where mq.status = 'canceled') as canceled,
      coalesce(array_agg(distinct mq.list_id) filter (where mq.list_id is not null), '{}') as list_ids,
      min(mq.send_date) as first_sent,
      max(mq.created_at) as last_queued_at
    from public.mail_queue mq
    where mq.email_id = e.id
      and (h.email_id is null or mq.updated_at >= h.archived_through)
  ) q on true
  left join lateral (
    select
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'delivered' and pe.recipient is not null) as delivered,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'bounced' and pe.recipient is not null) as bounced,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'complained' and pe.recipient is not null) as complained,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'opened' and pe.recipient is not null) as opened,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'clicked' and pe.recipient is not null) as clicked,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    where pe.email_id = e.id
      and (h.email_id is null or pe.received_at >= h.archived_through)
  ) ev on true
  order by e.created_at desc;
$$;

grant execute on function public.get_recent_email_analytics_stats(integer, integer)
  to authenticated, service_role;

create or replace function public.get_email_analytics_detail(p_email_id uuid)
returns table (
  email_id uuid, queued bigint, ses_accepted bigint, with_ses_message_id bigint,
  delivered_unique bigint, bounced_unique bigint, complained_unique bigint,
  opened_unique bigint, props_opened_unique bigint, ses_opened_unique bigint,
  clicked_unique bigint, delivery_events bigint, open_events bigint,
  props_open_events bigint, ses_open_events bigint, click_events bigint,
  first_event_at timestamptz, latest_event_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    p_email_id,
    coalesce(h.total_queued, 0) + coalesce(q.queued, 0),
    coalesce(h.succeeded, 0) + coalesce(q.ses_accepted, 0),
    coalesce(h.with_ses_message_id, 0) + coalesce(q.with_ses_message_id, 0),
    coalesce(h.delivered_unique, 0) + coalesce(ev.delivered_unique, 0),
    coalesce(h.bounced_unique, 0) + coalesce(ev.bounced_unique, 0),
    coalesce(h.complained_unique, 0) + coalesce(ev.complained_unique, 0),
    coalesce(h.opened_unique, 0) + coalesce(ev.opened_unique, 0),
    coalesce(ev.props_opened_unique, 0),
    coalesce(h.opened_unique, 0) + coalesce(ev.ses_opened_unique, 0),
    coalesce(h.clicked_unique, 0) + coalesce(ev.clicked_unique, 0),
    coalesce(h.delivery_events, 0) + coalesce(ev.delivery_events, 0),
    coalesce(h.open_events, 0) + coalesce(ev.open_events, 0),
    coalesce(ev.props_open_events, 0),
    coalesce(h.open_events, 0) + coalesce(ev.ses_open_events, 0),
    coalesce(h.click_events, 0) + coalesce(ev.click_events, 0),
    coalesce(h.first_event_at, ev.first_event_at),
    coalesce(greatest(h.latest_event_at, ev.latest_event_at), h.latest_event_at, ev.latest_event_at)
  from (select 1) seed
  left join public.email_history_rollups h on h.email_id = p_email_id
  left join lateral (
    select count(*) as queued,
      count(*) filter (where status = 'succeeded') as ses_accepted,
      count(*) filter (where ses_message_id is not null) as with_ses_message_id
    from public.mail_queue
    where email_id = p_email_id
      and (h.email_id is null or updated_at >= h.archived_through)
  ) q on true
  left join lateral (
    select
      count(distinct lower(recipient)) filter (where event_type = 'delivered' and recipient is not null) as delivered_unique,
      count(distinct lower(recipient)) filter (where event_type = 'bounced' and recipient is not null) as bounced_unique,
      count(distinct lower(recipient)) filter (where event_type = 'complained' and recipient is not null) as complained_unique,
      count(distinct lower(recipient)) filter (where event_type = 'opened' and recipient is not null) as opened_unique,
      count(distinct lower(recipient)) filter (where event_type = 'opened' and provider = 'props' and recipient is not null) as props_opened_unique,
      count(distinct lower(recipient)) filter (where event_type = 'opened' and provider = 'ses' and recipient is not null) as ses_opened_unique,
      count(distinct lower(recipient)) filter (where event_type = 'clicked' and recipient is not null) as clicked_unique,
      count(*) filter (where event_type = 'delivered') as delivery_events,
      count(*) filter (where event_type = 'opened') as open_events,
      count(*) filter (where event_type = 'opened' and provider = 'props') as props_open_events,
      count(*) filter (where event_type = 'opened' and provider = 'ses') as ses_open_events,
      count(*) filter (where event_type = 'clicked') as click_events,
      min(received_at) as first_event_at, max(received_at) as latest_event_at
    from public.provider_events
    where email_id = p_email_id
      and (h.email_id is null or received_at >= h.archived_through)
  ) ev on true;
$$;

grant execute on function public.get_email_analytics_detail(uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
