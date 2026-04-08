# VERSION 2 Refactor Plan

## Vision
Rebuild the props mailer as a modern Next.js + Supabase + Mailgun stack deployed on Vercel, keeping the existing UI/UX while replacing the server infrastructure and expanding list-management capabilities.

## Target Architecture
- **Frontend**: Next.js 15 App Router on Vercel (React Server Components + Tailwind/shadcn). Pages mirror current composer, scheduler, analytics, plus a new List Management tab.
- **Backend/API**: Next.js Route Handlers + Edge Functions. Server actions talk to Supabase Postgres through the official client and wrap Mailgun/other ESPs via a provider interface.
- **Database**: Supabase Postgres replaces MongoDB. Tables: `emails`, `recipients`, `lists`, `list_members`, `campaigns`, `email_events`, `provider_events`, etc., with RLS for org/user scoping.
- **Mail Service**: Mailgun (via `mailgun.js`) initially; abstraction layer allows swapping to Resend/Postmark later. Webhooks feed delivery/bounce events back into Supabase.
- **Background Work**: Vercel Cron jobs and/or Supabase Edge Functions handle scheduled sends, nightly reports, and list syncs.
- **File Storage**: Supabase Storage (or minimal S3 bucket if necessary) for inline assets referenced by emails.

## Reference Templates & Inspiration
1. NextAdmin Next.js Admin Dashboard – ready UI shell for our dashboard pages.
2. Newsletter Management App (Next.js + Resend + Prisma) – campaign & subscriber flows to adapt.
3. Express.js Vercel Starter – fallback for simple REST endpoints if needed.
4. Official mailgun.js SDK – examples for multi-domain + analytics.

## Milestones
1. **Requirements & Data Modeling (Week 0-1)**
   - Catalogue current Meteor collections/routes.
   - Design Supabase schema + ERD, plan RLS policies.
   - Choose UI kit and Mail provider abstraction.
2. **Foundation Setup (Week 2-3)**
   - Bootstrap Next.js repo inside this project (new folder).
   - Configure Supabase + Vercel projects and env secrets.
   - Build base layout, auth, navigation, placeholder pages for composer, schedule, analytics, lists.
3. **Email Pipeline (Week 4)**
   - Implement composer storage, queueing, test-send.
   - Add Vercel cron + API endpoints for scheduled sends.
   - Implement Mailgun wrapper + webhook ingestion into Supabase.
4. **List Management & Analytics (Week 5)**
   - CRUD UI for lists/members (Supabase-backed) + push/pull sync with Mailgun lists.
   - Dashboard for opens/clicks/bounces using ingested events.
5. **Migration & Cutover (Week 6)**
   - Export Mongo + Mailgun data; import into Supabase.
   - Mirror nightly cron jobs on Vercel.
   - QA, load test, DNS cutover, retire AWS.

## Working Agreement
- Keep the original Meteor app untouched; all Version 2 artifacts live side-by-side (e.g., `/webapp-v2` or `/v2/`).
- Use this plan as the source of truth; update it if scope shifts.
- At each milestone, verify prerequisites, gather missing info, and guide required actions.

