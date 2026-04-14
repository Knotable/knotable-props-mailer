# Version 2 Requirements & Data Model

## 1. Functional Scope
- **Auth**: Users log in (SSO TBD) and access composer, schedule, analytics, mailing lists, and admin-only user management.
- **Composer**: Create/update HTML emails with campaigns, tags, attachments, and schedule or send immediately. Support test sends to self.
- **Scheduler**: Queue emails for future delivery; show per-recipient status once sent.
- **Mailing Lists**: View, create, edit, and sync lists; update descriptions; import from Knotable/MailChimp equivalents; manage members.
- **Analytics**: Surface opens, clicks, bounces per campaign/tag, along with aggregate daily stats.
- **Users/Admin**: Admins can manage platform users.
- **Reports/Cron**: Nightly stats emails continue to run (implemented via Vercel cron or Supabase functions).

## 2. Meteor Collections → Supabase Tables
| Meteor Collection | Purpose | Proposed Supabase Table & Key Columns |
| --- | --- | --- |
| `email_events` | Drafts, queued mails, sent history | `emails` (`id`, `author_id`, `from`, `subject`, `html`, `text`, `status`, `scheduled_at`, `sent_at`), `email_recipients` (`email_id`, `address`, `status`, `delivery_info`), `email_tags`, `email_campaigns`, `email_files` |
| `files` | Stored inline assets & attachments | `files` (`id`, `storage_path`, `mime_type`, `size`, `creator_id`, `source_url`) managed via Supabase Storage |
| `mailing_list` | Cached Mailgun lists | `lists` (`id`, `name`, `address`, `description`, `mailgun_list_id`, `access_level`, `synced_at`), `list_members` (`list_id`, `email`, `status`, `source`) |
| Meteor users (`Meteor.users`) | Auth + profile | Supabase Auth users + `profiles` (`id`, `email`, `role`, `name`, `invited_at`) |
| Not in Meteor: provider events | Delivery/bounce logs | `provider_events` (`id`, `provider`, `event_type`, `message_id`, `recipient`, `payload`, `received_at`) |

## 3. Core API Routes / Pages to Rebuild
- `/login`, `/complete-profile`, `/loginWithToken` → Supabase Auth + magic-link flow.
- `/email` (main tabs) → Next.js dashboard with nested routes (`/email/composer`, `/email/schedule`, `/email/analytics`).
- `/list` → New List Management tab with Supabase-backed CRUD and Mailgun sync actions.
- `/users` → Admin-only page for managing accounts.

## 4. Initial Schema Concepts
```sql
-- Emails
create table emails (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references auth.users not null,
  from_address text not null,
  subject text not null,
  html text not null,
  text text,
  status text not null check (status in ('draft','queued','sending','sent','failed')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  is_test boolean default false,
  campaigns text[],
  tags text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table email_recipients (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references emails on delete cascade,
  recipient_address text not null,
  status text not null default 'pending',
  last_event text,
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users,
  name text not null,
  address text not null,
  description text,
  mailgun_list_id text,
  access_level text default 'readonly',
  synced_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table list_members (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references lists on delete cascade,
  email text not null,
  status text default 'active',
  source text default 'manual',
  subscribed_at timestamptz default now(),
  unsubscribed_at timestamptz,
  metadata jsonb default '{}'
);

create table provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  message_id text,
  event_type text not null,
  recipient text,
  payload jsonb not null,
  received_at timestamptz default now()
);
```

_RLS_: owner/team scoping using Supabase Auth `user_id`; admins granted org-wide access.

## 5. Tech Choices for V2
- **UI Kit**: Tailwind CSS + shadcn/ui (headless components) layered with Next.js App Router. Matches dashboard use case, themable, works well on Vercel.
- **State/Data Layer**: Supabase client (server actions + RLS) + React Query for client-side caches.
- **Mail Provider Abstraction**: `EmailProvider` interface with methods `send`, `sendTest`, `createList`, `updateList`, `syncMembers`, `ingestEvent`. Implement `MailgunProvider` first; future `ResendProvider` etc. selected via config.
- **Cron / Background**: Vercel Cron hitting API routes for scheduled sends + Supabase triggers for event ingestion. Long-running tasks broken into queue items processed via Edge Functions or background workers (Planetscale?).

## 6. Key Decisions (confirmed)
1. **Auth strategy**: Passwordless magic-link emails, but the email must show the full URL so users can copy/paste between browsers/devices.
2. **User roles**: Single admin class with superpowers; no extra role granularity for now.
3. **Legacy analytics**: Start fresh in V2; no historical backfill required beyond what Mailgun already stores.
4. **Attachment hosting**: Host inline assets directly in-app (Supabase Storage) to make uploads easy in the web UI.
5. **List imports**: Drop MailChimp/Knotable syncs; provide CSV upload or large copy/paste input that upserts members into lists.
6. **Branding/UI**: Keep the existing look/feel even if built with Tailwind/shadcn components.

These decisions unblock the final schema + auth model.
