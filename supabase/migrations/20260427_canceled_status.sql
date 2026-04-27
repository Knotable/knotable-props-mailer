-- Migration: add 'canceled' to mail_queue status constraint
-- Soft-deletes pending rows on cancel so the unsent cohort remains queryable.
--
-- Before: status in ('pending','processing','succeeded','failed','dead')
-- After:  status in ('pending','processing','succeeded','failed','dead','canceled')

alter table public.mail_queue
  drop constraint if exists mail_queue_status_check;

alter table public.mail_queue
  add constraint mail_queue_status_check
  check (status in ('pending','processing','succeeded','failed','dead','canceled'));

-- Index to make "who was canceled for this email?" fast
create index if not exists mail_queue_email_canceled_idx
  on public.mail_queue(email_id, status)
  where status = 'canceled';
