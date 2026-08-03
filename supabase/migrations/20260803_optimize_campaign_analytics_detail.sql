-- Make campaign analytics detail scale to six-figure recipient queues.
--
-- The original detail function scanned mail_queue three times. The recipient
-- function also aggregated provider events for the full campaign before
-- applying LIMIT/OFFSET and matched events by recipient, which could attribute
-- one person's events to multiple repeated test rows. Aggregate queue stats in
-- one pass, page queue rows before event aggregation, and correlate events by
-- the SES message ID (with queue ID as the Props-pixel fallback).

create or replace function public.get_email_analytics_detail(p_email_id uuid)
returns table (
  email_id uuid,
  queued bigint,
  ses_accepted bigint,
  with_ses_message_id bigint,
  delivered_unique bigint,
  bounced_unique bigint,
  complained_unique bigint,
  opened_unique bigint,
  props_opened_unique bigint,
  ses_opened_unique bigint,
  clicked_unique bigint,
  delivery_events bigint,
  open_events bigint,
  props_open_events bigint,
  ses_open_events bigint,
  click_events bigint,
  first_event_at timestamptz,
  latest_event_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with queue_stats as (
    select
      count(*) as queued,
      count(*) filter (where mq.status = 'succeeded') as ses_accepted,
      count(*) filter (where mq.ses_message_id is not null) as with_ses_message_id
    from public.mail_queue mq
    where mq.email_id = p_email_id
  ), event_stats as (
    select
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'delivered' and pe.recipient is not null
      ) as delivered_unique,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'bounced' and pe.recipient is not null
      ) as bounced_unique,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'complained' and pe.recipient is not null
      ) as complained_unique,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'opened' and pe.recipient is not null
      ) as opened_unique,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'opened' and pe.provider = 'props' and pe.recipient is not null
      ) as props_opened_unique,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'opened' and pe.provider = 'ses' and pe.recipient is not null
      ) as ses_opened_unique,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'clicked' and pe.recipient is not null
      ) as clicked_unique,
      count(*) filter (where pe.event_type = 'delivered') as delivery_events,
      count(*) filter (where pe.event_type = 'opened') as open_events,
      count(*) filter (where pe.event_type = 'opened' and pe.provider = 'props') as props_open_events,
      count(*) filter (where pe.event_type = 'opened' and pe.provider = 'ses') as ses_open_events,
      count(*) filter (where pe.event_type = 'clicked') as click_events,
      min(pe.received_at) as first_event_at,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    where pe.email_id = p_email_id
  )
  select
    p_email_id,
    coalesce(q.queued, 0),
    coalesce(q.ses_accepted, 0),
    coalesce(q.with_ses_message_id, 0),
    coalesce(e.delivered_unique, 0),
    coalesce(e.bounced_unique, 0),
    coalesce(e.complained_unique, 0),
    coalesce(e.opened_unique, 0),
    coalesce(e.props_opened_unique, 0),
    coalesce(e.ses_opened_unique, 0),
    coalesce(e.clicked_unique, 0),
    coalesce(e.delivery_events, 0),
    coalesce(e.open_events, 0),
    coalesce(e.props_open_events, 0),
    coalesce(e.ses_open_events, 0),
    coalesce(e.click_events, 0),
    e.first_event_at,
    e.latest_event_at
  from queue_stats q
  cross join event_stats e;
$$;

create or replace function public.get_email_recipient_activity(
  p_email_id uuid,
  p_limit integer default 100,
  p_offset integer default 0,
  p_status text default null,
  p_event_type text default null,
  p_search text default null
)
returns table (
  queue_id uuid,
  recipient text,
  recipient_name text,
  list_id uuid,
  queue_status text,
  send_date date,
  queued_at timestamptz,
  queue_updated_at timestamptz,
  ses_message_id text,
  last_error text,
  delivered_events bigint,
  props_open_events bigint,
  ses_open_events bigint,
  click_events bigint,
  bounce_events bigint,
  complaint_events bigint,
  first_open_at timestamptz,
  last_open_at timestamptz,
  first_click_at timestamptz,
  last_click_at timestamptz,
  latest_event_at timestamptz,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with filtered_queue as materialized (
    select mq.id, coalesce(mq.updated_at, mq.created_at) as sort_at
    from public.mail_queue mq
    where mq.email_id = p_email_id
      and (p_status is null or mq.status = p_status)
      and (
        p_search is null
        or p_search = ''
        or lower(mq.payload->>'to') like '%' || lower(p_search) || '%'
      )
      and (
        p_event_type is null
        or exists (
          select 1
          from public.provider_events pe_filter
          where pe_filter.email_id = mq.email_id
            and pe_filter.event_type = p_event_type
            and (
              (mq.ses_message_id is not null and pe_filter.message_id = mq.ses_message_id)
              or pe_filter.message_id = mq.id::text
            )
        )
      )
  ), page_rows as (
    select fq.*
    from filtered_queue fq
    order by fq.sort_at desc, fq.id
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    offset greatest(0, coalesce(p_offset, 0))
  ), filtered_count as (
    select count(*) as total_count from filtered_queue
  )
  select
    pr.id as queue_id,
    nullif(lower(pr.payload->>'to'), '') as recipient,
    nullif(pr.payload->>'toName', '') as recipient_name,
    pr.list_id,
    pr.status as queue_status,
    pr.send_date,
    pr.created_at as queued_at,
    pr.updated_at as queue_updated_at,
    pr.ses_message_id,
    pr.last_error,
    coalesce(ev.delivered_events, 0),
    coalesce(ev.props_open_events, 0),
    coalesce(ev.ses_open_events, 0),
    coalesce(ev.click_events, 0),
    coalesce(ev.bounce_events, 0),
    coalesce(ev.complaint_events, 0),
    ev.first_open_at,
    ev.last_open_at,
    ev.first_click_at,
    ev.last_click_at,
    ev.latest_event_at,
    fc.total_count
  from page_rows page
  join public.mail_queue pr on pr.id = page.id
  cross join filtered_count fc
  left join lateral (
    select
      count(*) filter (where pe.event_type = 'delivered') as delivered_events,
      count(*) filter (where pe.event_type = 'opened' and pe.provider = 'props') as props_open_events,
      count(*) filter (where pe.event_type = 'opened' and pe.provider = 'ses') as ses_open_events,
      count(*) filter (where pe.event_type = 'clicked') as click_events,
      count(*) filter (where pe.event_type = 'bounced') as bounce_events,
      count(*) filter (where pe.event_type = 'complained') as complaint_events,
      min(pe.received_at) filter (where pe.event_type = 'opened') as first_open_at,
      max(pe.received_at) filter (where pe.event_type = 'opened') as last_open_at,
      min(pe.received_at) filter (where pe.event_type = 'clicked') as first_click_at,
      max(pe.received_at) filter (where pe.event_type = 'clicked') as last_click_at,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    where pe.email_id = pr.email_id
      and (
        (pr.ses_message_id is not null and pe.message_id = pr.ses_message_id)
        or pe.message_id = pr.id::text
      )
  ) ev on true
  order by coalesce(ev.latest_event_at, pr.updated_at, pr.created_at) desc, pr.id;
$$;

grant execute on function public.get_email_analytics_detail(uuid)
  to authenticated, service_role;
grant execute on function public.get_email_recipient_activity(uuid, integer, integer, text, text, text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
