-- Fast recent-send history and analytics helpers.
--
-- The older email_send_stats and campaign_stats views aggregate the full
-- mail_queue table before applying LIMIT/OFFSET. On high-volume campaigns that
-- can hit Supabase statement timeouts and hide recent sends from the UI.
-- These functions page from the small emails table first, then aggregate only
-- queue rows for the visible campaigns.

create index if not exists emails_status_created_idx
  on public.emails (status, created_at desc);

create index if not exists mail_queue_email_status_created_idx
  on public.mail_queue (email_id, status, created_at desc)
  where email_id is not null;

create index if not exists mail_queue_email_status_send_date_idx
  on public.mail_queue (email_id, status, send_date)
  where email_id is not null;

create index if not exists mail_queue_email_list_idx
  on public.mail_queue (email_id, list_id)
  where email_id is not null and list_id is not null;

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
    coalesce(q.list_ids, array[]::uuid[]) as list_ids,
    coalesce(q.sent, 0) as sent,
    coalesce(q.failed, 0) as failed,
    coalesce(q.pending, 0) as pending,
    q.first_sent,
    coalesce(q.last_queued_at, e.created_at) as last_queued_at,
    e.total_count
  from selected_emails e
  left join lateral (
    select
      array_agg(distinct mq.list_id) filter (where mq.list_id is not null) as list_ids,
      count(*) filter (where mq.status = 'succeeded') as sent,
      count(*) filter (where mq.status in ('failed', 'dead')) as failed,
      count(*) filter (where mq.status in ('pending', 'processing')) as pending,
      min(mq.send_date) filter (where mq.status = 'succeeded') as first_sent,
      max(mq.created_at) as last_queued_at
    from public.mail_queue mq
    where mq.email_id = e.id
  ) q on true
  order by e.created_at desc;
$$;

grant execute on function public.get_recent_email_send_stats(integer, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';
