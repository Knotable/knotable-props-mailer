-- Emails & recipients
create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  from_address text not null,
  reply_to text,
  subject text not null,
  html text not null,
  text text,
  status text not null check (status in ('draft','queued','sending','sent','failed','canceled')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  is_test boolean default false,
  campaigns text[] default '{}',
  tags text[] default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists emails_author_idx on public.emails(author_id);

create table if not exists public.email_recipients (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references public.emails on delete cascade,
  recipient_address text not null,
  status text not null default 'pending',
  last_event text,
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists email_recipients_email_idx on public.email_recipients(email_id);

-- Files stored in Supabase Storage (optional metadata table)
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  creator_id uuid,
  created_at timestamptz default now()
);

-- Mailing lists
create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  address text not null,
  description text,
  mailgun_list_id text,
  access_level text default 'readonly',
  synced_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists lists_address_idx on public.lists(address);

create table if not exists public.list_members (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references public.lists on delete cascade,
  email text not null,
  status text default 'active',
  source text default 'manual',
  subscribed_at timestamptz default now(),
  unsubscribed_at timestamptz,
  metadata jsonb default '{}'
);

create index if not exists list_members_list_idx on public.list_members(list_id);

-- Provider events from Mailgun webhooks
create table if not exists public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'mailgun',
  event_type text not null,
  message_id text,
  recipient text,
  payload jsonb not null,
  received_at timestamptz default now()
);

-- Simple profile table for role tracking
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade,
  email text not null,
  role text not null default 'admin',
  created_at timestamptz default now(),
  primary key (id)
);

-- Row-Level Security placeholders (enable manually in Supabase)
-- alter table public.emails enable row level security;
-- create policy "Admins can do anything" on public.emails for all using (auth.uid() = author_id);
