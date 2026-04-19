-- Add list_id to mail_queue so we can trace which list a campaign was sent to
alter table public.mail_queue
  add column if not exists list_id uuid references public.lists on delete set null;

create index if not exists mail_queue_list_id_idx on public.mail_queue(list_id);

-- Add ses_message_id to mail_queue to correlate SES events back to individual sends
alter table public.mail_queue
  add column if not exists ses_message_id text;

create index if not exists mail_queue_ses_message_id_idx on public.mail_queue(ses_message_id);

-- Add ses_message_id to provider_events so we can join them to mail_queue rows
alter table public.provider_events
  add column if not exists email_id uuid references public.emails on delete set null;

-- Update provider default from mailgun to ses for new rows
-- (existing rows keep their provider value unchanged)
