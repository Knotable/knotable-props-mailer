# README-AI.md — Agent Context for knotable-props-mailer

> **For AI agents**: Read this file at the start of every task on this project. It is the authoritative, human-maintained snapshot of what this codebase is, how it's structured, and the conventions you must follow. It supersedes re-deriving structure from scratch. Update it when you learn something new or make a significant structural change.

---

## What This Project Is

A Next.js 16 + Supabase email marketing console ("Props Mailer V2"), deployed on Vercel. It replaced a legacy Meteor codebase. The app lets admins compose HTML emails, queue them, send via Amazon SES (SMTP), manage mailing lists, and track analytics. There is no Cron automation — sends are initiated manually, then drained by keeping `/email/monitor` open in a browser tab.

**Owner:** Amol (a@sarva.co)  
**Repo:** GitHub → Vercel auto-deploy  
**Deployed at:** https://knotable-props-mailer.vercel.app (confirmed live; `props.knote.com` still points at the old Meteor app)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.2, App Router, React 19 |
| Styling | Tailwind CSS v4, `tailwind-merge`, `class-variance-authority` |
| Database / Auth | Supabase (Postgres + Auth + Storage) |
| Mail sending | Amazon SES via SMTP using `nodemailer` |
| Validation | Zod v4 |
| Icons | lucide-react |
| Testing | Vitest |
| Deployment | Vercel (no Cron jobs; queue drained via monitor page) |

**Important:** This is **Next.js 16** — not the Next.js 14/15 you may know from training data. APIs and conventions may differ. Always read `node_modules/next/dist/docs/` before writing new Next.js-specific code (per `AGENTS.md`).

---

## Directory Map

```
src/
  app/
    (auth)/login/           # Passwordless magic-link login
    (auth)/login/actions.ts # Server actions for Supabase auth
    (dashboard)/            # All authenticated pages
      layout.tsx            # Dashboard shell + nav
      email/
        actions.ts          # Server actions: save draft, queue, cancel, send test
        composer/           # Compose email (page.tsx + composer-form.tsx client component)
        schedule/           # Queue review: list queued emails, trigger send
        sends/              # Sent email history + per-recipient status
        analytics/          # Opens/clicks/bounces dashboard
        monitor/            # Real-time queue worker monitor (monitor-client.tsx polls)
      lists/                # Mailing list CRUD
        [listId]/           # List detail + member management
        actions.ts          # Server actions for list ops
      users/                # Admin-only user management
    api/
      email/
        queue/route.ts      # POST: run queue worker batch; GET: quota + queue depth. Both require Bearer $CRON_SECRET.
        preview/[id]/route.ts # GET: render email HTML for preview iframe
        report/route.ts     # GET ?emailId=<uuid>: per-email send report (queue outcome counts + SES event counts + first 100 unsent recipients). Requires Bearer $CRON_SECRET.
      health/route.ts       # GET: unauthenticated; checks env vars + DB tables/columns. Good smoke test after deploy.
      log/client/route.ts   # POST: receive client-side error logs
      webhooks/ses/route.ts # POST: ingest SES SNS delivery/bounce events
    loginWithToken/         # Magic-link token handler
    page.tsx                # Root → redirects to /email/composer
    layout.tsx              # Root layout
  lib/
    emailProvider.ts        # nodemailer SMTP singleton (pooled, 5 connections)
    queueWorker.ts          # Core send logic: batches 200 items, 5 concurrent, ~14 msg/sec
    dailyQuota.ts           # Daily send cap enforcement (reads/writes mail_queue.send_date)
    featureFlags.ts         # Feature flag lookup from Supabase `feature_flags` table
    supabaseAdmin.ts        # Supabase service-role client (server-only)
    supabaseClient.ts       # Supabase anon client (browser)
    supabaseServer.ts       # Supabase server client (SSR, cookie-based)
    authAccess.ts           # Auth helpers for server components
    authAccessEdge.ts       # Auth helpers for Edge middleware
    rateLimit.ts            # Rate limiting: checkRateLimit() async/DB-backed (cross-instance); checkRateLimitSync() in-memory fallback
    logger.ts               # loglevel-based logger
    env.ts                  # Typed env var access
    nav.ts                  # Navigation config (tabs)
    client/                 # Client-safe utilities
  components/
    health-banner.tsx       # Shows health status at top of dashboard
    layout/                 # Shared layout components
  supabase/
    types.ts                # Generated Supabase TypeScript types
  proxy.ts                  # (Edge proxy helper, if used)

supabase/
  schema.sql                # Canonical Postgres schema (source of truth)
  migrations/               # Incremental SQL migrations (apply in date order)

scripts/
  update-schema-hash.mjs    # Hash the schema for drift detection
  verify-schema.mjs         # Verify schema matches hash

docs/
  requirements.md           # V2 data model and functional scope (historical)
  version2-plan.md          # Migration plan from Meteor (historical)
  legacy-readme.md          # Original Meteor app README
  ses-smtp-setup.md         # SES SMTP configuration notes

check-queue-logs.mjs        # Utility: query queue metrics from CLI
import_contacts.py          # One-off script: import contacts to Supabase
import_list.mjs             # One-off script: import mailing list
```

---

## Database Schema (Key Tables)

All tables are in the `public` schema. Full DDL in `supabase/schema.sql`.

| Table | Purpose |
|---|---|
| `emails` | Email drafts + sent history. Statuses: `draft`, `queued`, `sending`, `sent`, `failed`, `canceled` |
| `email_recipients` | Per-recipient delivery rows (linked to `emails`) |
| `draft_snapshots` | Autosave history for composer drafts |
| `mail_queue` | Outbound send queue. Statuses: `pending`, `processing`, `succeeded`, `failed`, `dead`, `canceled` |
| `queue_metrics` | Per-run metrics from queue worker |
| `lists` | Mailing lists |
| `list_members` | List membership (unique on `list_id + email`) |
| `provider_events` | SES/Mailgun webhook events (delivery, bounce, etc.) |
| `profiles` | User profile + role (`admin` only for now) |
| `feature_flags` | DB-backed feature flags; defaults to `true` if key missing |
| `error_logs` | Client + server error logs. Also used as the backing store for the DB-backed rate limiter (sentinel rows with `source = 'rate_limit:<key>'`) |
| `audit_logs` / `admin_audit` | Action audit trails |
| `files` | Supabase Storage metadata |

**Migrations** live in `supabase/migrations/` and are named `YYYYMMDD_*.sql`. Apply them in order on top of `schema.sql`.

**Supabase TypeScript types** (`src/supabase/types.ts`) are out of sync with the live schema — several tables (e.g. `mail_queue`, `error_logs`, `email_recipients`) resolve to `never` in the type system. This is a pre-existing drift issue; the code builds and runs correctly at runtime. Do not treat these TS errors as regressions. Regenerate types with `supabase gen types typescript` when doing a schema migration pass.

---

## How Email Sending Works

1. **Composer** (`/email/composer`): User drafts an email. Server action in `email/actions.ts` saves to `emails` table as `draft`.
2. **Queue**: Queueing action creates rows in `mail_queue` (one per recipient), sets `emails.status = 'queued'`.
3. **Send Monitor** (`/email/monitor`): Browser page that fires `POST /api/email/send-monitor` every 31 seconds while open. 31s is intentional — just over Vercel's 30s hobby-tier timeout so each worker call finishes before the next fires.
4. **Queue Worker** (`src/lib/queueWorker.ts`):
   - Reclaims stuck `processing` rows older than 15 min
   - Checks daily quota via `dailyQuota.ts`
   - Fetches up to 200 `pending` items (`WORKER_BATCH_SIZE`)
   - Sends in parallel windows of 5 (`WORKER_CONCURRENCY`) via `Promise.allSettled`, matching nodemailer's `maxConnections: 5` — sustains ~14 msg/sec (SES SMTP rate limit)
   - Permanent failures (SMTP 5xx) → `dead` immediately; transient → exponential backoff up to `max_attempts`
   - Calls `reconcileEmailStatuses()` to roll up `emails.status` after each batch
   - `dedupe_hash` (SHA-256 of `emailId:recipientEmail`) stamped on every queue row at insert; unique DB constraint not yet enforced (see TODOs)
5. **SES Webhooks** (`/api/webhooks/ses`): SNS signature-verified; ingests delivery/bounce events into `provider_events`; auto-suppresses hard bounces and complaints in `list_members`.

**Daily send limit** is defined in `dailyQuota.ts` — check that file for the current cap constant.

---

## Auth Flow

- Passwordless magic-link via Supabase Auth (email OTP)
- Login page at `(auth)/login/`; token handler at `/loginWithToken`
- Server components use `supabaseServer.ts` (cookie-based SSR client)
- Edge middleware uses `authAccessEdge.ts`
- All users are effectively admins (single role for now)

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_JWT_SECRET
AWS_SES_SMTP_USERNAME
AWS_SES_SMTP_PASSWORD
AWS_SES_SMTP_ENDPOINT
AWS_SES_SMTP_PORT          # default 587
APP_BASE_URL               # e.g. https://props-v2.vercel.app
```

See `.env.example` for full list.

---

## Deployment

- **Git push → GitHub → Vercel** (auto-deploy, no manual step)
- No Vercel Cron jobs configured — queue draining is done via the monitor page
- `vercel.json` is currently empty `{}` — do not add Cron entries; the monitor-page approach is intentional
- No Docker in production; `.dockerignore` exists for local dev use

---

## Known TODOs / In-Progress Work

- `ses_message_id` column missing from `mail_queue` — migration needed before SES webhook events can be linked back to queue rows (see TODO comment in `queueWorker.ts` for exact SQL)
- `dedupe_hash` unique constraint missing from `mail_queue` — add `UNIQUE (dedupe_hash)` constraint via migration to get DB-level insert protection
- Supabase TypeScript types (`src/supabase/types.ts`) are stale — regenerate with `supabase gen types typescript` after any schema migration; many tables currently resolve to `never` (pre-existing, not a regression)
- RLS policies in `schema.sql` are commented out — need to be enabled manually in Supabase
- `provider_events` bounce/complaint data is stored but not yet surfaced in analytics UI
- Route protection via middleware is partially implemented

---

## Conventions & Gotchas

- **Supabase clients**: Use `supabaseAdmin` (service role) for server actions and queue worker. Use `supabaseServer` for SSR components that need user context. Never import `supabaseAdmin` in client components.
- **Server actions** live in `actions.ts` co-located with their page directory.
- **Zod** is used for all API input validation.
- **No Cron**: Do not add Vercel Cron entries — queue draining is handled by the monitor page (`/email/monitor`), which fires the worker every 31s while open. `vercel.json` intentionally stays `{}`.
- **Rate limiting**: Use `checkRateLimit(key, max, windowMs)` (async, DB-backed via `error_logs` sentinel rows) for any endpoint that needs cross-instance protection. Use `checkRateLimitSync` only where async is impossible (currently: login server action). The DB version writes rows with `source = 'rate_limit:<key>'` and `message = 'hit'` — don't mistake these for real errors when reading `error_logs`.
- **Monitor page auth**: `/api/email/send-monitor` uses the same `CRON_SECRET` bearer token as `/api/email/queue`. The server component at `/email/monitor/page.tsx` passes `process.env.CRON_SECRET` to the client component so the browser can authenticate its polling calls. `CRON_SECRET` must be set in Vercel env vars or the monitor page will show a warning and refuse to fire.
- **Queue hold pattern**: When `queueCampaignAction` inserts queue rows, all rows get `available_at = '2999-12-31T23:59:59Z'` (the `QUEUE_HOLD_AT` constant). `sendQueuedEmailAction` then updates `available_at` to `now()` for the rows being released. This two-step pattern lets you inspect and cancel before anything goes out.
- **Feature flags**: Use `getFeatureFlag(key)` from `featureFlags.ts`; defaults to `true` if the key doesn't exist in the DB.
- **Schema changes**: Add a new file to `supabase/migrations/` with the format `YYYYMMDD_description.sql`. Update `schema.sql` to match. Then regenerate types: `supabase gen types typescript > src/supabase/types.ts`.
- **Next.js version**: Always check `node_modules/next/dist/docs/` before using Next.js APIs — this is v16, not v14/15.

---

## Composer UI Features

- **Preview button**: Opens a new `800×700` browser window and writes the raw HTML textarea content into it via `document.write`. Purely client-side — no save required. Added to `composer-form.tsx` alongside the other action buttons.
- **Send Test button**: Calls `sendTestAction` (in `email/actions.ts`) but overrides `recipients` in the FormData to `a@sarva.co` (owner address). Does not affect the To field or selected list. Test sends appear in Past Sends (`mail_queue` row with `status = 'succeeded'`). The action accepts any valid `recipients` value — the caller controls the destination.
