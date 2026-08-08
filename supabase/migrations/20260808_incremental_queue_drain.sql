-- Keep large campaigns cheap enough for Supabase Nano.
--
-- Resuming a campaign is now a single parent-row state transition. Workers
-- claim small batches directly from the durable year-2999 hold instead of
-- rewriting every unsent row before the first message can be sent.

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
    join public.emails e on e.id = mq.email_id
    where mq.status = 'pending'
      and e.status = 'sending'
      and (p_email_id is null or mq.email_id = p_email_id)
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
    limit least(greatest(p_limit, 0), 200)
  ),
  claimed as (
    update public.mail_queue mq
    set
      status = 'processing',
      locked_at = p_now,
      updated_at = p_now
    from candidates
    where mq.id = candidates.id
      and mq.status = 'pending'
    returning mq.id, mq.email_id, mq.payload, mq.list_id
  )
  select claimed.id, claimed.email_id, claimed.payload, claimed.list_id
  from claimed;
$$;

create or replace function public.get_next_sending_campaign(
  p_now timestamptz default now()
)
returns table (
  id uuid,
  subject text
)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.subject
  from public.emails e
  where e.status = 'sending'
    and exists (
      select 1
      from public.mail_queue mq
      where mq.email_id = e.id
        and (
          mq.status = 'processing'
          or (
            mq.status = 'pending'
            and (
              mq.available_at <= p_now
              or mq.available_at >= timestamptz '2999-12-31 23:59:59+00'
            )
          )
        )
    )
  order by e.updated_at asc, e.id asc
  limit 1;
$$;

create or replace function public.get_mailer_runtime_limits(
  p_email_id uuid default null,
  p_now timestamptz default now()
)
returns table (
  daily_cap integer,
  ses_max_send_rate_per_second numeric,
  rolling_24h_sent bigint,
  accepted_today_utc bigint,
  sent_last_7_days bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with settings as (
    select
      coalesce(
        max((value ->> 'value')::integer) filter (where key = 'daily_send_limit'),
        65400
      ) as daily_cap,
      coalesce(
        max((value ->> 'value')::numeric) filter (where key = 'ses_max_send_rate_per_second'),
        15
      ) as ses_rate
    from public.app_settings
    where key in ('daily_send_limit', 'ses_max_send_rate_per_second')
  )
  select
    settings.daily_cap,
    settings.ses_rate,
    (
      select count(*)
      from public.mail_queue mq
      where mq.status = 'succeeded'
        and mq.updated_at >= p_now - interval '24 hours'
    ) as rolling_24h_sent,
    (
      select count(*)
      from public.mail_queue mq
      where mq.status = 'succeeded'
        and mq.send_date = (p_now at time zone 'UTC')::date
    ) as accepted_today_utc,
    (
      select count(*)
      from public.mail_queue mq
      where mq.status = 'succeeded'
        and mq.send_date >= (p_now at time zone 'UTC')::date - 6
        and (p_email_id is null or mq.email_id = p_email_id)
    ) as sent_last_7_days
  from settings;
$$;

create or replace function public.get_global_active_queue_summary(
  p_now timestamptz default now()
)
returns table (
  pending_due bigint,
  pending_held bigint,
  processing bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (
      where mq.status = 'pending' and mq.available_at <= p_now
    ) as pending_due,
    count(*) filter (
      where mq.status = 'pending' and mq.available_at > p_now
    ) as pending_held,
    count(*) filter (where mq.status = 'processing') as processing
  from public.mail_queue mq
  where mq.status in ('pending', 'processing');
$$;

create or replace function public.get_list_member_status_summaries(
  p_list_ids uuid[]
)
returns table (
  list_id uuid,
  status text,
  member_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select lm.list_id, lm.status, count(*) as member_count
  from public.list_members lm
  where lm.list_id = any(coalesce(p_list_ids, array[]::uuid[]))
  group by lm.list_id, lm.status;
$$;

grant execute on function public.claim_mail_queue_batch(integer, uuid, timestamptz)
  to anon, authenticated, service_role;
grant execute on function public.get_next_sending_campaign(timestamptz)
  to anon, authenticated, service_role;
grant execute on function public.get_mailer_runtime_limits(uuid, timestamptz)
  to anon, authenticated, service_role;
grant execute on function public.get_global_active_queue_summary(timestamptz)
  to anon, authenticated, service_role;
grant execute on function public.get_list_member_status_summaries(uuid[])
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
