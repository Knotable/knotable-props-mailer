-- Fix Past Sends showing "0 sent" for archived campaigns.
--
-- get_recent_email_send_stats (used by /email/sends) only ever aggregated
-- live public.mail_queue rows. The 20260810 archive/purge process moves
-- terminal mail_queue rows for older campaigns into public.email_history_rollups
-- and deletes them from mail_queue, but this RPC was never updated to read
-- the rollup table, so any purged campaign now reports sent/failed/canceled
-- as 0 even though email_history_rollups (and email_send_report, and the
-- newer get_recent_email_analytics_stats RPC) still have the real totals.
-- This brings get_recent_email_send_stats in line with those.

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
      coalesce(array_agg(distinct mq.list_id) filter (where mq.list_id is not null), '{}'::uuid[]) as list_ids,
      min(mq.send_date) filter (where mq.status = 'succeeded') as first_sent,
      max(mq.created_at) as last_queued_at
    from public.mail_queue mq
    join selected_emails s on s.id = mq.email_id
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
    coalesce(greatest(h.last_updated_at, q.last_queued_at), h.last_updated_at, q.last_queued_at, e.created_at) as last_queued_at,
    e.total_count
  from selected_emails e
  left join public.email_history_rollups h on h.email_id = e.id
  left join live_queue q on q.email_id = e.id
  order by e.created_at desc;
$$;

grant execute on function public.get_recent_email_send_stats(integer, integer)
  to authenticated, service_role;

-- email_send_report (used by /api/email/sends/fresh-stats) folded
-- email_history_rollups.dead into its "dead" column but never read back
-- rollups.failed, so a campaign whose queue rows were archived while
-- terminal-failed (not yet dead) silently lost that count too.
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
  coalesce(r.dead, 0) + coalesce(r.failed, 0) + coalesce(q.dead, 0) as dead,
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

notify pgrst, 'reload schema';
