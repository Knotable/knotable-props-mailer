-- Exact campaign analytics, recipient activity, and clicked-link detail.
--
-- Separates unique people from raw event volume and separates the app's own
-- open pixel (`provider = props`) from SES engagement events. This prevents
-- repeated opens and two tracking sources from being presented as people.

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
  select
    p_email_id,
    (select count(*) from public.mail_queue mq where mq.email_id = p_email_id),
    (select count(*) from public.mail_queue mq where mq.email_id = p_email_id and mq.status = 'succeeded'),
    (select count(*) from public.mail_queue mq where mq.email_id = p_email_id and mq.ses_message_id is not null),
    count(distinct lower(pe.recipient)) filter (where pe.event_type = 'delivered' and pe.recipient is not null),
    count(distinct lower(pe.recipient)) filter (where pe.event_type = 'bounced' and pe.recipient is not null),
    count(distinct lower(pe.recipient)) filter (where pe.event_type = 'complained' and pe.recipient is not null),
    count(distinct lower(pe.recipient)) filter (where pe.event_type = 'opened' and pe.recipient is not null),
    count(distinct lower(pe.recipient)) filter (where pe.event_type = 'opened' and pe.provider = 'props' and pe.recipient is not null),
    count(distinct lower(pe.recipient)) filter (where pe.event_type = 'opened' and pe.provider = 'ses' and pe.recipient is not null),
    count(distinct lower(pe.recipient)) filter (where pe.event_type = 'clicked' and pe.recipient is not null),
    count(*) filter (where pe.event_type = 'delivered'),
    count(*) filter (where pe.event_type = 'opened'),
    count(*) filter (where pe.event_type = 'opened' and pe.provider = 'props'),
    count(*) filter (where pe.event_type = 'opened' and pe.provider = 'ses'),
    count(*) filter (where pe.event_type = 'clicked'),
    min(pe.received_at),
    max(pe.received_at)
  from public.provider_events pe
  where pe.email_id = p_email_id;
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
  with activity as (
    select
      mq.id as queue_id,
      nullif(lower(mq.payload->>'to'), '') as recipient,
      nullif(mq.payload->>'toName', '') as recipient_name,
      mq.list_id,
      mq.status as queue_status,
      mq.send_date,
      mq.created_at as queued_at,
      mq.updated_at as queue_updated_at,
      mq.ses_message_id,
      mq.last_error,
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
    from public.mail_queue mq
    left join public.provider_events pe
      on pe.email_id = mq.email_id
      and pe.recipient is not null
      and lower(pe.recipient) = lower(mq.payload->>'to')
    where mq.email_id = p_email_id
      and (p_status is null or mq.status = p_status)
      and (p_search is null or p_search = '' or lower(mq.payload->>'to') like '%' || lower(p_search) || '%')
    group by mq.id
  ), filtered as (
    select *
    from activity a
    where p_event_type is null
      or (p_event_type = 'delivered' and a.delivered_events > 0)
      or (p_event_type = 'opened' and a.props_open_events + a.ses_open_events > 0)
      or (p_event_type = 'clicked' and a.click_events > 0)
      or (p_event_type = 'bounced' and a.bounce_events > 0)
      or (p_event_type = 'complained' and a.complaint_events > 0)
  )
  select f.*, count(*) over () as total_count
  from filtered f
  order by coalesce(f.latest_event_at, f.queue_updated_at, f.queued_at) desc, f.queue_id
  limit greatest(1, least(coalesce(p_limit, 100), 500))
  offset greatest(0, coalesce(p_offset, 0));
$$;

create or replace function public.get_email_top_links(
  p_email_id uuid,
  p_limit integer default 20
)
returns table (
  url text,
  total_clicks bigint,
  unique_recipients bigint,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    pe.payload #>> '{click,link}' as url,
    count(*) as total_clicks,
    count(distinct lower(pe.recipient)) filter (where pe.recipient is not null) as unique_recipients,
    min(pe.received_at) as first_clicked_at,
    max(pe.received_at) as last_clicked_at
  from public.provider_events pe
  where pe.email_id = p_email_id
    and pe.event_type = 'clicked'
    and nullif(pe.payload #>> '{click,link}', '') is not null
  group by pe.payload #>> '{click,link}'
  order by unique_recipients desc, total_clicks desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

grant execute on function public.get_email_analytics_detail(uuid) to authenticated, service_role;
grant execute on function public.get_email_recipient_activity(uuid, integer, integer, text, text, text) to authenticated, service_role;
grant execute on function public.get_email_top_links(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
