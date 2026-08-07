-- Reduce API and database pressure for large resumable campaigns.
--
-- 1. Queue pages consume grouped counts instead of downloading every row.
-- 2. Workers persist one SMTP window of successes in a single RPC.

create or replace function public.get_queue_campaign_summaries(
  p_email_ids uuid[],
  p_now timestamptz default now()
)
returns table (
  email_id uuid,
  list_id uuid,
  pending_due bigint,
  pending_held bigint,
  processing bigint,
  succeeded bigint,
  failed bigint,
  dead bigint,
  canceled bigint,
  total bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    mq.email_id,
    mq.list_id,
    count(*) filter (
      where mq.status = 'pending' and mq.available_at <= p_now
    ) as pending_due,
    count(*) filter (
      where mq.status = 'pending' and mq.available_at > p_now
    ) as pending_held,
    count(*) filter (where mq.status = 'processing') as processing,
    count(*) filter (where mq.status = 'succeeded') as succeeded,
    count(*) filter (where mq.status = 'failed') as failed,
    count(*) filter (where mq.status = 'dead') as dead,
    count(*) filter (where mq.status = 'canceled') as canceled,
    count(*) as total
  from public.mail_queue mq
  where mq.email_id = any(coalesce(p_email_ids, array[]::uuid[]))
  group by mq.email_id, mq.list_id;
$$;

create or replace function public.mark_mail_queue_succeeded_batch(
  p_results jsonb,
  p_send_date date,
  p_updated_at timestamptz default now()
)
returns integer
language sql
security definer
set search_path = public
as $$
  with result_rows as (
    select result.id, result.ses_message_id
    from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
      as result(id uuid, ses_message_id text)
    where result.id is not null
      and nullif(result.ses_message_id, '') is not null
  ),
  updated as (
    update public.mail_queue mq
    set
      status = 'succeeded',
      send_date = p_send_date,
      ses_message_id = result_rows.ses_message_id,
      locked_at = null,
      updated_at = p_updated_at
    from result_rows
    where mq.id = result_rows.id
      and mq.status = 'processing'
    returning mq.id
  )
  select count(*)::integer from updated;
$$;

grant execute on function public.get_queue_campaign_summaries(uuid[], timestamptz)
  to anon, authenticated, service_role;

grant execute on function public.mark_mail_queue_succeeded_batch(jsonb, date, timestamptz)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
