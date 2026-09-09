-- Keep the Past Sends page accurate after terminal queue history is compacted.
--
-- email_history_rollups contains rows archived through archived_through. Any
-- live rows newer than that boundary are added back so a campaign can be
-- compacted incrementally without double-counting or hiding active work.

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
  with selected_emails as materialized (
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
  ), live_queue as materialized (
    select
      mq.email_id,
      count(*) filter (where mq.status = 'succeeded') as sent,
      count(*) filter (where mq.status in ('failed', 'dead')) as failed,
      count(*) filter (where mq.status in ('pending', 'processing')) as pending,
      count(*) filter (where mq.status = 'canceled') as canceled,
      array_agg(distinct mq.list_id) filter (where mq.list_id is not null) as list_ids,
      min(mq.send_date) filter (where mq.status = 'succeeded') as first_sent,
      max(mq.created_at) as last_queued_at
    from public.mail_queue mq
    join selected_emails e on e.id = mq.email_id
    left join public.email_history_rollups h on h.email_id = mq.email_id
    where h.email_id is null or mq.updated_at >= h.archived_through
    group by mq.email_id
  )
  select
    e.id as email_id,
    e.subject,
    e.from_address,
    e.status,
    e.created_at,
    case
      when cardinality(coalesce(h.list_ids, '{}'::uuid[])) > 0 then h.list_ids
      else coalesce(q.list_ids, '{}'::uuid[])
    end as list_ids,
    coalesce(h.succeeded, 0) + coalesce(q.sent, 0) as sent,
    coalesce(h.failed, 0) + coalesce(h.dead, 0) + coalesce(q.failed, 0) as failed,
    coalesce(q.pending, 0) as pending,
    coalesce(h.canceled, 0) + coalesce(q.canceled, 0) as canceled,
    coalesce(h.first_send_date, q.first_sent) as first_sent,
    coalesce(
      greatest(h.last_updated_at, q.last_queued_at),
      h.last_updated_at,
      q.last_queued_at,
      e.created_at
    ) as last_queued_at,
    e.total_count
  from selected_emails e
  left join public.email_history_rollups h on h.email_id = e.id
  left join live_queue q on q.email_id = e.id
  order by e.created_at desc;
$$;

grant execute on function public.get_recent_email_send_stats(integer, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';
