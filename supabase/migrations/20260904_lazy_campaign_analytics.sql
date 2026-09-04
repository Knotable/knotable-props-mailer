-- Small, campaign-scoped analytics functions for the lazy Analytics page.
-- The UI calls exactly one metric at a time and caches the result in the
-- browser, avoiding the all-campaign aggregate that exceeded statement_timeout.

create or replace function public.get_email_queue_analytics_metric(p_email_id uuid)
returns table (
  sent bigint,
  failed bigint,
  pending bigint,
  canceled bigint,
  list_ids uuid[],
  last_queued_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with history as (
    select * from public.email_history_rollups where email_id = p_email_id
  ), live as (
    select
      count(*) filter (where mq.status = 'succeeded') as sent,
      count(*) filter (where mq.status in ('failed', 'dead')) as failed,
      count(*) filter (where mq.status in ('pending', 'processing')) as pending,
      count(*) filter (where mq.status = 'canceled') as canceled,
      coalesce(array_agg(distinct mq.list_id) filter (where mq.list_id is not null), '{}'::uuid[]) as list_ids,
      max(mq.updated_at) as last_queued_at
    from public.mail_queue mq
    left join history h on true
    where mq.email_id = p_email_id
      and (h.email_id is null or mq.updated_at >= h.archived_through)
  )
  select
    coalesce(h.succeeded, 0) + coalesce(l.sent, 0),
    coalesce(h.failed, 0) + coalesce(h.dead, 0) + coalesce(l.failed, 0),
    coalesce(l.pending, 0),
    coalesce(h.canceled, 0) + coalesce(l.canceled, 0),
    case
      when cardinality(coalesce(h.list_ids, '{}'::uuid[])) > 0 then h.list_ids
      else coalesce(l.list_ids, '{}'::uuid[])
    end,
    coalesce(greatest(h.last_updated_at, l.last_queued_at), h.last_updated_at, l.last_queued_at)
  from live l
  left join history h on true;
$$;

create or replace function public.get_email_provider_analytics_metric(
  p_email_id uuid,
  p_event_type text
)
returns table (
  unique_recipients bigint,
  event_count bigint,
  latest_event_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_event_type not in ('delivered', 'opened', 'clicked', 'bounced', 'complained') then
    raise exception 'Unsupported provider event type';
  end if;

  return query
  with history as (
    select * from public.email_history_rollups where email_id = p_email_id
  ), live as (
    select
      count(distinct lower(pe.recipient)) filter (where pe.recipient is not null) as unique_recipients,
      count(*) as event_count,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    left join history h on true
    where pe.email_id = p_email_id
      and pe.event_type = p_event_type
      and (h.email_id is null or pe.received_at >= h.archived_through)
  )
  select
    case p_event_type
      when 'delivered' then coalesce(h.delivered_unique, 0)
      when 'opened' then coalesce(h.opened_unique, 0)
      when 'clicked' then coalesce(h.clicked_unique, 0)
      when 'bounced' then coalesce(h.bounced_unique, 0)
      when 'complained' then coalesce(h.complained_unique, 0)
    end + coalesce(l.unique_recipients, 0),
    case p_event_type
      when 'delivered' then coalesce(h.delivery_events, 0)
      when 'opened' then coalesce(h.open_events, 0)
      when 'clicked' then coalesce(h.click_events, 0)
      when 'bounced' then coalesce(h.bounce_events, 0)
      when 'complained' then coalesce(h.complaint_events, 0)
    end + coalesce(l.event_count, 0),
    coalesce(greatest(h.latest_event_at, l.latest_event_at), h.latest_event_at, l.latest_event_at)
  from live l
  left join history h on true;
end;
$$;

revoke all on function public.get_email_queue_analytics_metric(uuid)
  from public, anon, authenticated;
revoke all on function public.get_email_provider_analytics_metric(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_email_queue_analytics_metric(uuid)
  to service_role;
grant execute on function public.get_email_provider_analytics_metric(uuid, text)
  to service_role;

notify pgrst, 'reload schema';
