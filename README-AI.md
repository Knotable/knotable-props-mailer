# README-AI.md — Agent Context for knotable-props-mailer

> **For AI agents**: Read this file at the start of every task on this project. It is the authoritative, human-maintained snapshot of what this codebase is, how it's structured, and the conventions you must follow. It supersedes re-deriving structure from scratch. Update it when you learn something new or make a significant structural change.

---

## OPERATOR STATUS - READ THIS FIRST

**As of 2026-06-15, production health is green and reports `0` due pending, `0` processing, and `0` held pending queue rows. The AWS SES daily sending quota is 65,400 emails per 24-hour period, with a maximum send rate of 15 emails per second. `public.app_settings` now exists live with `daily_send_limit = 65,400`. Do not open or auto-run the monitor casually; verify the exact email id first.**

**Hard sending rule, 2026-06-16:** Never use Gmail or the Gmail connector to send project, campaign, newsletter, list, test, or resend emails for this repo. Gmail may be used only for read-only mailbox lookup when explicitly relevant. All outbound mail must go through Props Mailer / SES using the app's queue, test-send, or monitor flows.

**Paris override update, 2026-05-31:** a separate `AmolsParis` campaign (`0949ffd6-044c-42e9-97ba-585a72281c6a`) was explicitly sent after the app cap was already full. SES accepted `414` recipients, then returned `454 Throttling failure: Daily message quota exceeded.` The remaining `103` Paris recipients are held at year 2999. Do not retry them until SES headroom is confirmed. The LifeX campaign remained isolated with `0` due and `0` processing rows when checked at `2026-05-31T22:03:54Z`.

Any AI agent entering this repo should first tell the operator:

> Hey, here is what's up right now: production health is green with no due, processing, or held queue rows. The LifeX campaign under email id `532a06ae-c296-4f93-8483-e250d803f08d` has no pending/processing rows left, but its parent `emails.status` still reads `queued`, so it may need a status cleanup to `sent` if the UI still shows it as active. The current SES account limit is 65,400 emails per 24-hour period and 15 emails per second. The old large campaign was canceled on 2026-05-12 after sending 63,553 recipients.

Current live-send details:

- Released LifeX campaign email id: `532a06ae-c296-4f93-8483-e250d803f08d`
- Subject: `LifeX is getting loud: exits, London, and useful little machines`
- Source editable draft: `ec97551d-0bea-463f-8630-58ac2d246b81` (revision 3 snapshot written before AI-native edits)
- List: `Amols202604` (`dbd52a08-9a38-4573-bf06-09e401015ae9`), 185,907 active members at preparation time
- Current SES quota: `65,400` recipients per 24-hour period; maximum send rate: `15` emails per second. Live `app_settings.daily_send_limit` is `65,400`.
- Previous LifeX slice result: `53,998` accepted by SES, `1` dead malformed recipient, plus `2` earlier test sends counted toward that day's global quota.
- Additional run on 2026-05-31: `9,001` extra LifeX recipients released from the next slice and accepted by SES with `0` failures.
- Live check on 2026-06-15 showed LifeX has `0` pending and `0` processing rows. Its parent email still has status `queued`, likely because final status reconciliation timed out on the large success count.
- Invalid recipient marked terminal: `barbaraceñestealvarez@hotmail.com` (`501 Invalid RCPT TO address provided`)
- New-campaign screenshot asset: `https://yxmnqlxdxrtfnpcvvoww.supabase.co/storage/v1/object/public/email-assets/lifex/lifex-whatsapp-london-2026-05-30.jpg`
- Pre-release global queue state checked on 2026-05-31: `0` due pending rows, `0` processing rows, `192,018` held pending rows
- Old canceled campaign email id: `696a333a-4909-41e8-ad3e-81c2e11b39db`
- Old canceled campaign subject: `NY: birthday + LifeX Fund 2`
- Final old-campaign queue state after cancellation: `63,553` succeeded, `122,592` canceled, `1` dead, `0` pending, `0` processing
- Held follow-up email `aacdd257-4604-4f0c-b13d-54add0aff534`: `4,898` held pending, `102` canceled
- Held follow-up email `7b57066b-6400-4216-8ef0-12faa967cbee`: `1,213` held pending, `5` canceled
- Production health was green on 2026-06-15 with `0` critical failures and `0` warnings, `0` due pending, `0` processing, and `0` held pending rows. SES/SNS events are fresh.
- Live-schema drift note: `public.app_settings` has been repaired live and returns `daily_send_limit = 65,400`. Verify `mail_queue.dedupe_hash` uniqueness before relying on the generic conflict-safe queue upsert path.
- Release gotcha: `release_mail_queue_campaign` timed out when updating all 185,907 rows in one statement. The release schedule was applied in bounded chunks instead.
- Drain gotcha: the initial unpaced worker loop hit transient SES `454 Maximum sending rate exceeded` responses. Those addresses succeeded on retry. Run local scoped worker calls with a 5-second pause between batches.
- Continuation gotcha: the local `CRON_SECRET` does not authenticate the deployed worker endpoint, and this desktop session could not register a thread heartbeat. Resume through a local Next dev server and the local scoped `/api/email/send-monitor` endpoint.

Next-send checklist:

- No LifeX slice needs to be resumed based on the 2026-06-15 live check.
- Clean up stale parent email statuses if the UI still shows completed sends as queued. Known examples: LifeX `532a06ae...` and Paris `0949ffd6...` both have `0` pending and `0` processing rows but still show `emails.status = queued`.
- Verify `mail_queue.dedupe_hash` uniqueness before relying on generic UI queue upserts.
- Older unrelated queue rows no longer appear held in production health as of 2026-06-15.
- Before opening `/email/monitor`, verify the target email id and queue counts so no unrelated campaign drains.

### Running Repair / Readiness Checklist

Update this section as work progresses so future agents do not re-derive the state.

| Item | Status | Notes / Checks |
|---|---|---|
| Resolve monitor UI conflict markers | Done 2026-05-20 | Kept the API-route implementation that calls `/api/email/send-monitor` with `CRON_SECRET`; removed stale server-action conflict branch. Verified no conflict markers remain in the monitor client. |
| Disable accidental global queue drains | Done 2026-05-21 | `/api/email/send-monitor` POST, `/api/email/queue` POST, and `triggerQueueAction` now require a valid `emailId`; the schedule page no longer shows the broad "Process Queue Now" control; `/email/monitor` without `emailId` is read-only. |
| Require explicit per-email release confirmation | Done 2026-05-21 | `Send Now` now requires a campaign-specific `release:<emailId>` confirmation token; the server action preflights email status plus due/held/processing counts before calling `release_mail_queue_campaign`. Direct action calls without the token fail before mutating queue rows. |
| Centralize strict email id parsing | Done 2026-05-21 | Worker/report endpoints now share `parseUuid`; malformed 36-character strings no longer pass the report endpoint's looser UUID check, and invalid monitor `emailId` query strings return 400 instead of behaving like a valid campaign filter. |
| Harden worker core against global mutation | Done 2026-05-21 | `runQueueWorker` now requires a valid `emailId` and throws without one; stale `processing` row recovery is scoped to that campaign instead of mutating all processing rows globally. |
| Bound schedule page queue lookups | Done 2026-05-21 | `/email/schedule` no longer fetches every `mail_queue` row for visible emails just to render list badges; it samples at most 25 queue rows per email so a 186k queued campaign does not make the page pull a 186k-row result set. |
| Surface queue due snapshot in health | Done 2026-05-31 | `/api/health` includes a warning check with global due pending, processing, and held pending queue counts so readiness reviews see accidental due work without opening the monitor. The deployed 2026-05-31 safety fix makes count-query errors surface instead of rendering timed-out counts as zero. |
| Commit/persist this operator status | Pending | `README-AI.md` is modified locally until committed. |
| Decide fate of held follow-up queues | Done 2026-06-15 live check | Production health reports `0` held pending rows. `aacdd257...` has no email row/queue rows in the live check; `7b57066...` is `sent` with `1,206` succeeded, `1` dead, and `11` canceled. |
| Prepare AI-native LifeX full-list campaign | Done 2026-05-31 | Fresh email `532a06ae...` has a hosted screenshot asset and the updated AI-native copy. |
| Send first LifeX UTC-day slice | Done 2026-05-31 | Released exact email `532a06ae...`; 53,998 LifeX recipients were accepted by SES, 1 malformed address was marked dead, and 2 earlier tests counted toward that day's global quota. The current checked-in cap is now 65,400. |
| Continue future LifeX slices | Done 2026-06-15 live check | `532a06ae...` has `0` pending and `0` processing rows. Its parent email status still reads `queued`, so clean that status if it confuses the UI. |
| Repair live-schema queue/settings drift | Partially done 2026-06-15 | `public.app_settings` is live with `daily_send_limit = 65,400`. Verify the `mail_queue.dedupe_hash` uniqueness repair before relying on generic UI queue upserts. |
| Apply Supabase security/IO repair | Needs Supabase Advisor verification | `app_settings` and `unsubscribe_requests` now exist live, and `/api/health` is green. Supabase Advisor RLS/Disk IO status is not visible through the app API; verify in the Supabase Dashboard. |
| Verify SES/SNS event freshness | Done 2026-05-31 | Production health is green and fresh provider events were observed on 2026-05-30. |
| Verify large-send RPCs in prod | Done 2026-05-21 | `/api/health` critical checks are green, including `claim_mail_queue_batch` and `release_mail_queue_campaign`. Re-check immediately before release. |
| Confirm queue is not accidentally due | Done 2026-06-15 live check | Production health reports `0` due pending, `0` processing, and `0` held pending. Re-check immediately before monitor use and only run the intended `emailId`; the global monitor is read-only. |
| Prepare next two LifeX newsletters | Drafted 2026-06-11 | Local HTML files in `/Users/MrAnonymous/Documents/01 LifeX/Newsletter work/` were updated to use Supabase-hosted images and reply-based unsubscribe footer. Supabase draft ids: `08df2ed7-a8a2-4ec4-9542-990d3a43c0e6` for June 11 Part 1 and `00440fb7-59a6-4730-8bfe-605f5442f1ee` for the June 25 / July Part 2 draft. Both are still `draft`; live check showed `0` queue rows. |
| Add reply-to unsubscribe logging | Table live 2026-06-15 | App code stores/sends `reply_to` and sets a mailto `List-Unsubscribe` header when reply-to is present. Live check confirms `unsubscribe_requests` exists. |
| Run local checks after hardening | Partially done 2026-05-21 | `git diff --check` passed; conflict-marker scan is clean; code stale-reference scan no longer finds the old broad-drain UI/API paths; TypeScript `transpileModule` checks passed for touched TS/TSX files; direct `vitest run` passed 7 tests. Full `tsc --noEmit` runs but fails on the known stale Supabase generated types (`never` table rows across existing files), so regenerate `src/supabase/types.ts` before treating full typecheck as a release gate. `npm` is still not on PATH in this desktop shell; re-run `npm run lint`, `npm test`, and `npm run build` in a normal Node/npm shell before deploy. |

Suggested verification commands once Node/npm are available:

```bash
npm run lint
npm test
npm run build
curl -fsS https://knotable-props-mailer.vercel.app/api/health | jq '{ok, critical, warnings, failed: [.checks[] | select(.ok==false)]}'
```

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
        queue/route.ts      # POST: run queue worker batch for a specific emailId; GET: quota + queue depth. Both require Bearer $CRON_SECRET.
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
3. **Send Monitor** (`/email/monitor?emailId=<uuid>`): Browser page that fires `POST /api/email/send-monitor` every 31 seconds while open for a specific email. 31s is intentional — just over Vercel's 30s hobby-tier timeout so each worker call finishes before the next fires. `/email/monitor` without an `emailId` is read-only and must not run the worker.
4. **Queue Worker** (`src/lib/queueWorker.ts`):
   - Reclaims stuck `processing` rows older than 15 min
   - Checks daily quota via `dailyQuota.ts`
   - Fetches up to 200 `pending` items (`WORKER_BATCH_SIZE`)
   - Sends in parallel windows of 5 (`WORKER_CONCURRENCY`) via `Promise.allSettled`, matching nodemailer's `maxConnections: 5` — sustains ~14 msg/sec (SES SMTP rate limit)
   - Permanent failures (SMTP 5xx) → `dead` immediately; transient → exponential backoff up to `max_attempts`
   - Calls `reconcileEmailStatuses()` to roll up `emails.status` after each batch
   - `dedupe_hash` (SHA-256 of `emailId:recipientEmail`) stamped on every queue row at insert; unique DB index makes queue creation retry-safe
   - Claims due rows through `claim_mail_queue_batch()` so concurrent monitors cannot select the same pending rows
5. **SES Webhooks** (`/api/webhooks/ses`): SNS signature-verified; ingests delivery/bounce events into `provider_events`; auto-suppresses hard bounces and complaints in `list_members`.

**Daily send limit** is defined in `dailyQuota.ts` — check that file for the current cap constant.

---

## Auth Flow

- Passwordless magic-link via Supabase Auth (email OTP)
- Login page at `(auth)/login/`; token handler at `/loginWithToken`
- Signup page at `(auth)/signup/`; new accounts get a `profiles` row with `role = user` and `can_send = false`
- Server components use `supabaseServer.ts` (cookie-based SSR client)
- Edge middleware uses `authAccessEdge.ts`
- `a@sarva.co` is the owner admin and is forced to `role = admin`, `can_send = true`
- Mail and list records are shared across authenticated users for drafting/review; server actions enforce `can_send` before queueing, test sends, release, requeue, or worker runs

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

- **Operational status lives at the top of this file.** Check `OPERATOR STATUS - READ THIS FIRST` before queueing or releasing any large send.
- Verify SES/SNS tracking freshness before the next 186k send; production health was otherwise green but provider events were stale as of 2026-05-21.
- Verify `supabase/migrations/20260505_big_send_queue_rpcs.sql` is applied before large sends; it provides atomic queue claims and multi-day release scheduling.
- Supabase TypeScript types (`src/supabase/types.ts`) are stale — regenerate with `supabase gen types typescript` after any schema migration; many tables currently resolve to `never` (pre-existing, not a regression)
- RLS policies in `schema.sql` are commented out — need to be enabled manually in Supabase
- `provider_events` bounce/complaint data is stored and partially surfaced in analytics; detailed deliverability reporting still needs more operator UI.
- Route protection via middleware is partially implemented

---

## Conventions & Gotchas

- **Supabase clients**: Use `supabaseAdmin` (service role) for server actions and queue worker. Use `supabaseServer` for SSR components that need user context. Never import `supabaseAdmin` in client components.
- **Server actions** live in `actions.ts` co-located with their page directory.
- **Zod** is used for all API input validation.
- **Never send through Gmail**: Do not use Gmail, Gmail drafts, or the Gmail connector for any outbound project/campaign/list/newsletter/test/resend email. Use Props Mailer / SES flows only.
- **No Cron**: Do not add Vercel Cron entries — queue draining is handled by the monitor page (`/email/monitor`), which fires the worker every 31s while open. `vercel.json` intentionally stays `{}`.
- **Rate limiting**: Use `checkRateLimit(key, max, windowMs)` (async, DB-backed via `error_logs` sentinel rows) for any endpoint that needs cross-instance protection. Use `checkRateLimitSync` only where async is impossible (currently: login server action). The DB version writes rows with `source = 'rate_limit:<key>'` and `message = 'hit'` — don't mistake these for real errors when reading `error_logs`.
- **Monitor page auth**: `/api/email/send-monitor` uses the same `CRON_SECRET` bearer token as `/api/email/queue`. The server component at `/email/monitor/page.tsx` passes `process.env.CRON_SECRET` to the client component so the browser can authenticate its polling calls. `CRON_SECRET` must be set in Vercel env vars or the monitor page will show a warning and refuse to fire.
- **No global queue drains**: Worker POST routes and `runQueueWorker` itself require a specific `emailId`; broad all-pending queue drains are disabled to prevent accidentally sending unrelated due rows. Use a row's **Send Now** action or `/email/monitor?emailId=<uuid>`.
- **Queue hold pattern**: When `queueCampaignAction` inserts queue rows, all rows get `available_at = '2999-12-31T23:59:59Z'` (the `QUEUE_HOLD_AT` constant). `sendQueuedEmailAction` requires a per-email release confirmation token, preflights counts, and then updates `available_at` to `now()` for the rows being released. This two-step pattern lets you inspect and cancel before anything goes out.
- **Feature flags**: Use `getFeatureFlag(key)` from `featureFlags.ts`; defaults to `true` if the key doesn't exist in the DB.
- **Email copy convention**: Never use the header phrase `From the phone of Amol` in drafts, templates, or sent email copy. Amol explicitly retired it on 2026-05-31.
- **Schema changes**: Add a new file to `supabase/migrations/` with the format `YYYYMMDD_description.sql`. Update `schema.sql` to match. Then regenerate types: `supabase gen types typescript > src/supabase/types.ts`.
- **Next.js version**: Always check `node_modules/next/dist/docs/` before using Next.js APIs — this is v16, not v14/15.

---

## Composer UI Features

- **WYSIWYG HTML editor**: The composer defaults to a visual `contentEditable` editor with paragraph, heading, emphasis, list, link, and clear-format controls. The **HTML source** tab remains available for exact markup edits. Both modes synchronize into the existing `html` form value so autosave, preview, test sends, and queueing keep the same server-action contract.
- **Preview button**: Opens a new `800×700` browser window and writes the current synchronized HTML content into it via `document.write`. Purely client-side — no save required. Added to `composer-form.tsx` alongside the other action buttons.
- **Send Test button**: Calls `sendTestAction` (in `email/actions.ts`) but overrides `recipients` in the FormData to `a@sarva.co` (owner address). Does not affect the To field or selected list. Test sends appear in Past Sends (`mail_queue` row with `status = 'succeeded'`). The action accepts any valid `recipients` value — the caller controls the destination.
