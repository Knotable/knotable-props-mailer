# Knotable Props Mailer – V2

Next.js 15 + Supabase implementation of the Props email console. This folder can deploy independently on Vercel while the legacy Meteor app keeps running.

## Stack
- Next.js App Router + Tailwind for the dashboard UI
- Supabase Postgres/Auth/Storage for drafts, lists, and attachments
- Amazon SES (SMTP) for outbound mail; future SNS webhooks will feed stats back into Supabase

## Local development
1. Copy `.env.example` to `.env.local` and fill in Supabase + SES values.
2. Run the dev server:
   ```bash
   npm install
   npm run dev
   ```
3. Open http://localhost:3000 – root redirects to `/email/composer`.

## Required environment variables
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` – Supabase project settings › API
- `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` – used by Supabase migrations / server actions
- `AWS_SES_SMTP_USERNAME`, `AWS_SES_SMTP_PASSWORD`, `AWS_SES_SMTP_ENDPOINT`, `AWS_SES_SMTP_PORT` – SMTP credentials for SES
- `APP_BASE_URL` – e.g. `https://props-v2.vercel.app` for magic-link redirects

## Database
SQL schema lives in `../supabase/schema.sql`. Apply it to your Supabase instance, enable Row Level Security, and create policies restricting tables to the single admin role.

## Deploying to Vercel
1. Create a new Vercel project pointing at `version2/app`.
2. Add the env vars above in the Vercel dashboard.
3. Configure a Vercel Cron job (e.g. hourly) hitting `/api/email/queue` (endpoint to be added when scheduling worker is implemented) for sending queued mails.
4. (Optional) Wire SES → SNS → Supabase to capture engagement metrics.

## Directory map
- `src/app/(auth)` – passwordless login screen + magic-link handler
- `src/app/(dashboard)` – Composer, Schedule, Analytics, Lists, Users tabs
- `src/lib` – env helper, Supabase factories, SES SMTP client
- `supabase/schema.sql` (one level up) – Postgres schema

## Outstanding work
- Wire Supabase auth session into layouts/middleware for route protection
- Implement scheduled send worker + queue page actions
- Capture SES SNS notifications and insert them into `provider_events`
- Style tweaks to perfectly match legacy Props UI

Everything else in this repo (Meteor app) remains untouched.
