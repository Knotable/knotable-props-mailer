-- Big-send queue safety helpers.
--
-- 1. claim_mail_queue_batch atomically claims due rows with FOR UPDATE SKIP LOCKED
--    so concurrent monitor tabs cannot send the same recipient twice.
-- 2. release_mail_queue_campaign releases one campaign across UTC send days,
--    using today's remaining quota first and scheduling future rows for
--    midnight UTC on subsequent send days.

create or replace function public.claim_mail_queue_batch(
  p_limit integer,
  p_email_id uuid default null,
  p_now timestamptz default now()
)
returns table (
  id uuid,
  email_id uuid,
  payload jsonb,
  list_id uuid
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select mq.id
    from public.mail_queue mq
    where mq.status = 'pending'
      and mq.available_at <= p_now
      and (p_email_id is null or mq.email_id = p_email_id)
    order by mq.available_at asc, mq.created_at asc, mq.id asc
    for update skip locked
    limit greatest(p_limit, 0)
  ),
  claimed as (
    update public.mail_queue mq
    set
      status = 'processing',
      locked_at = p_now,
      updated_at = p_now
    from candidates
    where mq.id = candidates.id
    returning mq.id, mq.email_id, mq.payload, mq.list_id
  )
  select claimed.id, claimed.email_id, claimed.payload, claimed.list_id
  from claimed;
$$;

create or replace function public.release_mail_queue_campaign(
  p_email_id uuid,
  p_now timestamptz,
  p_daily_limit integer,
  p_sent_today integer
)
returns table (
  released integer,
  due_now integer,
  scheduled_future integer
)
language sql
security definer
set search_path = public
as $$
  with settings as (
    select
      greatest(p_daily_limit, 1) as daily_limit,
      greatest(p_daily_limit - p_sent_today, 0) as remaining_today
  ),
  held as (
    select
      mq.id,
      row_number() over (order by mq.created_at asc, mq.id asc) as rn
    from public.mail_queue mq
    where mq.email_id = p_email_id
      and mq.status = 'pending'
      and mq.available_at > p_now
  ),
  planned as (
    select
      held.id,
      case
        when held.rn <= settings.remaining_today then p_now
        else (
          (
            (p_now at time zone 'UTC')::date
            + (
              ((held.rn - settings.remaining_today - 1) / settings.daily_limit)::integer
              + 1
            )
          )::text || 'T00:00:00Z'
        )::timestamptz
      end as next_available_at,
      held.rn <= settings.remaining_today as is_due_now
    from held
    cross join settings
  ),
  updated as (
    update public.mail_queue mq
    set
      available_at = planned.next_available_at,
      updated_at = p_now
    from planned
    where mq.id = planned.id
    returning planned.is_due_now
  )
  select
    count(*)::integer as released,
    count(*) filter (where is_due_now)::integer as due_now,
    count(*) filter (where not is_due_now)::integer as scheduled_future
  from updated;
$$;
