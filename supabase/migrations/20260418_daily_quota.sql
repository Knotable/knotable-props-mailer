-- Migration: daily quota tracking
-- Run this in the Supabase SQL editor (or via supabase db push).

-- 1. Add send_date to mail_queue so we can efficiently count daily sends.
alter table public.mail_queue
  add column if not exists send_date date;

-- Index for fast daily count queries.
create index if not exists mail_queue_send_date_status_idx
  on public.mail_queue(send_date, status);

-- 2. Add campaign_label so multi-day batches of the same campaign stay linked.
alter table public.mail_queue
  add column if not exists campaign_label text;

create index if not exists mail_queue_campaign_label_idx
  on public.mail_queue(campaign_label);
