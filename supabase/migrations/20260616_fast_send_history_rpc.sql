-- Repair send-history RPC performance on high-volume campaigns.
--
-- The first get_recent_email_send_stats implementation used one broad lateral
-- aggregate per visible email. On large campaigns Postgres could still scan too
-- much mail_queue data and hit Supabase statement timeouts, which pushed Past
-- Sends back to stale/partial fallback views. This version keeps each lookup on
-- narrow email_id/status indexes and includes canceled queue rows in totals.

create index if not exists emails_send_history_created_idx
  on public.emails (created_at desc)
  where status <> 'draft';

create index if not exists mail_queue_email_status_created_idx
  on public.mail_queue (email_id, status, created_at desc)
  where email_id is not null;

create index if not exists mail_queue_email_status_send_date_idx
  on public.mail_queue (email_id, status, send_date)
  where email_id is not null;

create index if not exists mail_queue_email_list_idx
  on public.mail_queue (email_id, list_id)
  where email_id is not null and list_id is not null;

drop function if exists public.get_recent_email_send_stats(integer, integer);

create or replace function public.get_recent_email_send_stats(
  p_limit integer default 20,
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
  first_sent date,
  last_queued_at timestamptz,
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
    limit greatest(1, least(coalesce(p_limit, 20), 100))
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
    succeeded.first_sent,
    coalesce(last_queue.last_queued_at, e.created_at) as last_queued_at,
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
  order by e.created_at desc;
$$;

grant execute on function public.get_recent_email_send_stats(integer, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';
