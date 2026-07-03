-- Exact recent campaign analytics for mobile-first reporting.
--
-- Analytics used to sample provider_events and succeeded queue rows in the
-- Next.js page to avoid large table scans. That kept the page responsive but
-- made high-volume campaign rows incomplete. This RPC pages from the small
-- emails table first, then runs narrow indexed counts for only the visible
-- campaigns.

create index if not exists emails_analytics_created_idx
  on public.emails (created_at desc)
  where status <> 'draft';

create index if not exists provider_events_email_event_recipient_idx
  on public.provider_events (email_id, event_type, lower(recipient))
  where email_id is not null;

create index if not exists provider_events_email_received_idx
  on public.provider_events (email_id, received_at desc)
  where email_id is not null;

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

notify pgrst, 'reload schema';
