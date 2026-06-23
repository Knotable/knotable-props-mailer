create table if not exists public.unsubscribe_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  source_email_id uuid references public.emails on delete set null,
  list_id uuid references public.lists on delete set null,
  request_type text not null default 'reply' check (request_type in ('reply','mailto','manual','complaint','bounce')),
  status text not null default 'open' check (status in ('open','handled','ignored')),
  raw_message_ref text,
  notes text,
  requested_at timestamptz default now(),
  handled_at timestamptz,
  handled_by uuid references auth.users on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists unsubscribe_requests_email_status_idx
  on public.unsubscribe_requests (lower(email), status, requested_at desc);
create index if not exists unsubscribe_requests_source_email_idx
  on public.unsubscribe_requests (source_email_id)
  where source_email_id is not null;
create index if not exists unsubscribe_requests_list_idx
  on public.unsubscribe_requests (list_id)
  where list_id is not null;

alter table public.unsubscribe_requests enable row level security;

drop policy if exists "unsubscribe_requests: authenticated full access" on public.unsubscribe_requests;
create policy "unsubscribe_requests: authenticated full access"
  on public.unsubscribe_requests
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
