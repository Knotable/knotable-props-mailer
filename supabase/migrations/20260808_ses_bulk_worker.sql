-- Small, durable database operations for the long-running SES v2 bulk worker.
--
-- The worker runs outside Vercel. It claims at most one SES request worth of
-- recipients and checkpoints the whole result set in one database call.

create or replace function public.claim_ses_bulk_queue_batch(
  p_email_id uuid,
  p_worker_id text,
  p_limit integer,
  p_now timestamptz default now()
)
returns table (
  id uuid,
  payload jsonb,
  list_id uuid,
  attempts integer,
  max_attempts integer
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select mq.id
    from public.mail_queue mq
    join public.emails e on e.id = mq.email_id
    where mq.email_id = p_email_id
      and mq.status = 'pending'
      and e.status = 'sending'
      and (
        mq.available_at <= p_now
        or mq.available_at >= timestamptz '2999-12-31 23:59:59+00'
      )
    order by
      case when mq.available_at <= p_now then 0 else 1 end,
      mq.available_at asc,
      mq.created_at asc,
      mq.id asc
    for update of mq skip locked
    limit least(greatest(p_limit, 0), 50)
  ),
  claimed as (
    update public.mail_queue mq
    set
      status = 'processing',
      locked_at = p_now,
      last_heartbeat = p_now,
      correlation_id = p_worker_id,
      updated_at = p_now
    from candidates
    where mq.id = candidates.id
      and mq.status = 'pending'
    returning mq.id, mq.payload, mq.list_id, mq.attempts, mq.max_attempts
  )
  select claimed.id, claimed.payload, claimed.list_id, claimed.attempts, claimed.max_attempts
  from claimed;
$$;

create or replace function public.finalize_ses_bulk_queue_batch(
  p_email_id uuid,
  p_worker_id text,
  p_results jsonb,
  p_now timestamptz default now()
)
returns integer
language sql
security definer
set search_path = public
as $$
  with result_rows as (
    select result.id, result.outcome, result.ses_message_id, result.last_error
    from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
      as result(id uuid, outcome text, ses_message_id text, last_error text)
    where result.id is not null
      and result.outcome in ('succeeded', 'retry', 'dead', 'canceled')
  ),
  updated as (
    update public.mail_queue mq
    set
      status = case result_rows.outcome
        when 'succeeded' then 'succeeded'
        when 'retry' then 'pending'
        when 'dead' then 'dead'
        when 'canceled' then 'canceled'
      end,
      attempts = case
        when result_rows.outcome in ('retry', 'dead') then mq.attempts + 1
        else mq.attempts
      end,
      send_date = case
        when result_rows.outcome = 'succeeded' then (p_now at time zone 'UTC')::date
        else mq.send_date
      end,
      ses_message_id = case
        when result_rows.outcome = 'succeeded' then result_rows.ses_message_id
        else mq.ses_message_id
      end,
      available_at = case
        when result_rows.outcome = 'retry'
          then p_now + make_interval(mins => greatest(1, mq.attempts + 1) * 10)
        else mq.available_at
      end,
      locked_at = null,
      last_heartbeat = p_now,
      last_error = nullif(result_rows.last_error, ''),
      updated_at = p_now
    from result_rows
    where mq.id = result_rows.id
      and mq.email_id = p_email_id
      and mq.status = 'processing'
      and mq.correlation_id = p_worker_id
    returning mq.id
  ),
  already_applied as (
    select mq.id
    from public.mail_queue mq
    join result_rows on result_rows.id = mq.id
    where mq.email_id = p_email_id
      and mq.correlation_id = p_worker_id
      and result_rows.outcome = 'succeeded'
      and mq.status = 'succeeded'
      and mq.ses_message_id = result_rows.ses_message_id
  )
  select count(distinct id)::integer
  from (
    select id from updated
    union all
    select id from already_applied
  ) applied;
$$;

grant execute on function public.claim_ses_bulk_queue_batch(uuid, text, integer, timestamptz)
  to service_role;
grant execute on function public.finalize_ses_bulk_queue_batch(uuid, text, jsonb, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
