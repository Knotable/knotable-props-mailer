-- Replace the recent-campaign analytics RPC's per-campaign lateral scans with
-- one grouped pass over the selected campaigns. Production returned 57014
-- statement timeouts even though the function and provider events existed.

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
  with selected as materialized (
    select
      e.id,
      e.subject,
      e.from_address,
      e.status,
      e.created_at,
      count(*) over () as result_total
    from public.emails e
    where e.status <> 'draft'
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 100))
    offset greatest(0, coalesce(p_offset, 0))
  ), live_queue as materialized (
    select
      mq.email_id,
      count(*) filter (where mq.status = 'succeeded') as succeeded,
      count(*) filter (where mq.status in ('failed', 'dead')) as failed,
      count(*) filter (where mq.status in ('pending', 'processing')) as pending,
      count(*) filter (where mq.status = 'canceled') as canceled,
      coalesce(array_agg(distinct mq.list_id) filter (where mq.list_id is not null), '{}'::uuid[]) as list_ids,
      min(mq.send_date) filter (where mq.status = 'succeeded') as first_sent,
      max(mq.created_at) as last_queued_at
    from public.mail_queue mq
    join selected s on s.id = mq.email_id
    left join public.email_history_rollups h on h.email_id = mq.email_id
    where h.email_id is null or mq.updated_at >= h.archived_through
    group by mq.email_id
  ), live_events as materialized (
    select
      pe.email_id,
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
    join selected s on s.id = pe.email_id
    left join public.email_history_rollups h on h.email_id = pe.email_id
    where (h.email_id is null or pe.received_at >= h.archived_through)
      and pe.event_type in ('delivered', 'bounced', 'complained', 'opened', 'clicked')
    group by pe.email_id
  )
  select
    s.id,
    s.subject,
    s.from_address,
    s.status,
    s.created_at,
    case
      when cardinality(coalesce(h.list_ids, '{}'::uuid[])) > 0 then h.list_ids
      else coalesce(q.list_ids, '{}'::uuid[])
    end,
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
    coalesce(greatest(h.last_updated_at, q.last_queued_at), h.last_updated_at, q.last_queued_at, s.created_at),
    coalesce(greatest(h.latest_event_at, ev.latest_event_at), h.latest_event_at, ev.latest_event_at),
    s.result_total
  from selected s
  left join public.email_history_rollups h on h.email_id = s.id
  left join live_queue q on q.email_id = s.id
  left join live_events ev on ev.email_id = s.id
  order by s.created_at desc;
$$;

grant execute on function public.get_recent_email_analytics_stats(integer, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';
