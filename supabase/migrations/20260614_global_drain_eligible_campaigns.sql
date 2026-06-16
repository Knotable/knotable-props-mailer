-- Allow global queue drains, but only for campaigns that were intentionally
-- queued/sending/sent. Draft, canceled, failed, and anonymous queue rows are
-- never claimed by an unscoped worker call.

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
      and mq.available_at <= p_now
      and e.status in ('queued', 'sending', 'sent')
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

grant execute on function public.claim_mail_queue_batch(integer, uuid, timestamptz)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
