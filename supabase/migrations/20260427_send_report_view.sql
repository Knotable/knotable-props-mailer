-- Migration: email send-report view
--
-- email_send_report gives a per-email_id summary of queue outcomes
-- and SES delivery events, so you can answer "who got it, who didn't,
-- and why" without writing a manual join every time.
--
-- Queue-side columns (from mail_queue):
--   total_queued   — every row ever inserted for this email
--   succeeded      — sent to SES and accepted
--   dead           — permanently failed (retries exhausted or permanent SMTP error)
--   pending        — waiting to be sent
--   processing     — currently being attempted
--   canceled       — soft-deleted by a cancel or edit action
--
-- Event-side columns (from provider_events joined via ses_message_id):
--   delivered      — SES confirmed delivery to the recipient's mail server
--   bounced        — hard or soft bounce received
--   complained     — spam complaint received
--   opened         — open pixel fired
--   clicked        — link click recorded
--
-- Usage:
--   SELECT * FROM email_send_report WHERE email_id = '<uuid>';
--
-- To find who was NOT sent to after a partial cancel:
--   SELECT (payload->>'to') AS recipient
--   FROM mail_queue
--   WHERE email_id = '<uuid>' AND status = 'canceled';

create or replace view public.email_send_report as
select
  mq.email_id,

  -- Queue outcome counts
  count(*)                                              as total_queued,
  count(*) filter (where mq.status = 'succeeded')      as succeeded,
  count(*) filter (where mq.status = 'dead')           as dead,
  count(*) filter (where mq.status = 'pending')        as pending,
  count(*) filter (where mq.status = 'processing')     as processing,
  count(*) filter (where mq.status = 'canceled')       as canceled,

  -- SES delivery event counts (joined via ses_message_id)
  count(distinct pe_del.id)                            as delivered,
  count(distinct pe_bnc.id)                            as bounced,
  count(distinct pe_cmp.id)                            as complained,
  count(distinct pe_opn.id)                            as opened,
  count(distinct pe_clk.id)                            as clicked,

  -- Permanent SMTP failure count (attempts=999 sentinel set by queueWorker)
  count(*) filter (where mq.status = 'dead' and mq.attempts = 999) as permanent_failures,

  min(mq.created_at)  as first_queued_at,
  max(mq.updated_at)  as last_updated_at,
  min(mq.send_date)   as first_send_date,
  max(mq.send_date)   as last_send_date

from public.mail_queue mq

-- Delivery events
left join public.provider_events pe_del
  on pe_del.message_id = mq.ses_message_id
  and pe_del.event_type = 'delivered'

-- Bounce events
left join public.provider_events pe_bnc
  on pe_bnc.message_id = mq.ses_message_id
  and pe_bnc.event_type = 'bounced'

-- Complaint events
left join public.provider_events pe_cmp
  on pe_cmp.message_id = mq.ses_message_id
  and pe_cmp.event_type = 'complained'

-- Open events
left join public.provider_events pe_opn
  on pe_opn.message_id = mq.ses_message_id
  and pe_opn.event_type = 'opened'

-- Click events
left join public.provider_events pe_clk
  on pe_clk.message_id = mq.ses_message_id
  and pe_clk.event_type = 'clicked'

where mq.email_id is not null

group by mq.email_id;
