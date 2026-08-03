# README-AI.md — Agent Context for knotable-props-mailer

> **For AI agents**: Read this file at the start of every task on this project. It is the authoritative, human-maintained snapshot of what this codebase is, how it's structured, and the conventions you must follow. It supersedes re-deriving structure from scratch. Update it when you learn something new or make a significant structural change.

> **Operator/UI tasks**: If the user is asking for live app help, Supabase/Vercel screen guidance, latest sends, analytics/history checks, queue/send operations, or any task that may not require code, also read `docs/ai-operator-runbook.md` before deciding what to do. Many requests in this repo are operator workflows first and coding tasks only if live investigation shows code is the problem.

> **Startup behavior**: If the user's opening request is broad, vague, or asks what you can do in this project, offer the AI Startup Menu below. If the user asks for a specific task, do that task instead of showing the menu.

> **Commit and push edits**: When an AI agent makes repo edits, commit the intentional changes and push the branch to GitHub so the live Vercel deployment can pick them up, unless the user explicitly says not to. Stage only the files changed for the task; never sweep unrelated local work into the commit.

---

## AI STARTUP MENU

When the user opens this project without a specific task, offer this concise menu:

> I can help with common Props Mailer operations:
>
> 1. Draft or revise an email campaign.
> 2. Clone or adapt an existing campaign.
> 3. Create or update a mailing list.
> 4. Add, unsubscribe, block, or audit recipients.
> 5. Check whether a campaign went out and how it performed.
> 6. Queue a campaign safely without sending.
> 7. Run a send-readiness check before release.
> 8. Release, monitor, or troubleshoot a send.
> 9. Resend only to unsent or failed recipients.
> 10. Reconcile stale queued/sent statuses.
> 11. Check analytics/event accuracy.
> 12. Investigate UI, queue, SES, Supabase, or deployment errors.
>
> For anything that sends, releases, queues, or mutates production data, I will inspect first and ask for exact approval before the side effect.

---

## OPERATOR STATUS - READ THIS FIRST

**As of 2026-08-03, production health is green with `0` due pending, `0` processing, and `0` held pending queue rows. SES/SNS is fresh with `654` provider events received in the previous 7 days. The AWS SES quota is 65,400 recipients per rolling 24-hour period, with a separate maximum send rate of 15 recipients per second. App settings include `daily_send_limit = 65,400`; app code defaults `ses_max_send_rate_per_second` to 15 and migration `20260709_ses_quota_settings.sql` persists it. Do not open or auto-run the monitor casually; verify the exact email id first.**

**Hard sending rule, 2026-06-16:** Never use Gmail or the Gmail connector to send project, campaign, newsletter, list, test, or resend emails for this repo. Gmail may be used only for read-only mailbox lookup when explicitly relevant. All outbound mail must go through Props Mailer / SES using the app's queue, test-send, or monitor flows.

**Paris override update, 2026-05-31:** a separate `AmolsParis` campaign (`0949ffd6-044c-42e9-97ba-585a72281c6a`) was explicitly sent after the app cap was already full. SES accepted `414` recipients, then returned `454 Throttling failure: Daily message quota exceeded.` The remaining `103` Paris recipients are held at year 2999. Do not retry them until SES headroom is confirmed. The LifeX campaign remained isolated with `0` due and `0` processing rows when checked at `2026-05-31T22:03:54Z`.

When a task is operational or safety-sensitive, summarize the current posture from the exact OPERATOR STATUS line above instead of reusing old hardcoded counts. Mention due pending, processing, held pending, SES daily cap, SES send rate, and whether you will avoid side effects until approval.

Suggested status wording:

> Current posture from `README-AI.md`: production health was last recorded green with `0` due pending, `0` processing, and `2,486` held pending queue rows. SES quota is `65,400` emails per 24-hour period at `15` emails per second. I will not queue, release, send, or mutate production data without confirming the exact email/list and recipient count first.

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
- Production health was green on 2026-06-21 with `0` critical failures and `0` warnings, `0` due pending, `0` processing, and `2,486` held pending rows. SES/SNS events are fresh.
- Live-schema drift note: `public.app_settings` returns `daily_send_limit = 65,400`. The live `mail_queue_dedupe_hash_unique_idx` repair was applied and verified on 2026-06-20, so the generic conflict-safe queue upsert path is available again.
- Release gotcha: `release_mail_queue_campaign` timed out when updating all 185,907 rows in one statement. The release schedule was applied in bounded chunks instead.
- Drain gotcha: the initial unpaced worker loop hit transient SES `454 Maximum sending rate exceeded` responses. Those addresses succeeded on retry. Run local scoped worker calls with a 5-second pause between batches.
- Continuation gotcha: the local `CRON_SECRET` does not authenticate the deployed worker endpoint, and this desktop session could not register a thread heartbeat. Resume through a local Next dev server and the local scoped `/api/email/send-monitor` endpoint.

Next-send checklist:

- No LifeX slice needs to be resumed based on the 2026-06-15 live check.
- Clean up stale parent email statuses if the UI still shows completed sends as queued. Known examples: LifeX `532a06ae...` and Paris `0949ffd6...` both have `0` pending and `0` processing rows but still show `emails.status = queued`.
- `mail_queue.dedupe_hash` uniqueness was repaired live on 2026-06-20 and the generic UI queue upsert conflict target was verified in a rolled-back transaction.
- Older unrelated queue rows no longer appear held in production health as of 2026-06-15.
- Before opening `/email/monitor`, verify the target email id and queue counts so no unrelated campaign drains.

### Running Repair / Readiness Checklist

Update this section as work progresses so future agents do not re-derive the state.

| Item | Status | Notes / Checks |
|---|---|---|
| Resolve monitor UI conflict markers | Done 2026-05-20 | Kept the API-route implementation that calls `/api/email/send-monitor` with `CRON_SECRET`; removed stale server-action conflict branch. Verified no conflict markers remain in the monitor client. |
| Disable accidental global queue drains | Superseded by guarded global drain | 2026-05-21 removed broad accidental drains. Later code allows `/api/email/send-monitor` and `/api/email/queue` to run a guarded global drain only for due rows whose parent email is `queued`, `sending`, or `sent`; ordinary sends should still use a scoped `emailId`. |
| Require explicit per-email release confirmation | Done 2026-05-21 | `Send Now` now requires a campaign-specific `release:<emailId>` confirmation token; the server action preflights email status plus due/held/processing counts before calling `release_mail_queue_campaign`. Direct action calls without the token fail before mutating queue rows. |
| Centralize strict email id parsing | Done 2026-05-21 | Worker/report endpoints now share `parseUuid`; malformed 36-character strings no longer pass the report endpoint's looser UUID check, and invalid monitor `emailId` query strings return 400 instead of behaving like a valid campaign filter. |
| Harden worker core against global mutation | Superseded by guarded global drain | `runQueueWorker` accepts a missing `emailId` for the guarded global repair/debug path. With a scoped `emailId`, stale `processing` row recovery is scoped to that campaign. |
| Bound schedule page queue lookups | Done 2026-05-21 | `/email/schedule` no longer fetches every `mail_queue` row for visible emails just to render list badges; it samples at most 25 queue rows per email so a 186k queued campaign does not make the page pull a 186k-row result set. |
| Surface queue due snapshot in health | Done 2026-05-31 | `/api/health` includes a warning check with global due pending, processing, and held pending queue counts so readiness reviews see accidental due work without opening the monitor. The deployed 2026-05-31 safety fix makes count-query errors surface instead of rendering timed-out counts as zero. |
| Rationalize Queue page counts | Pending feature | The Queue screen currently repeats the same row count as page-level active queue rows, campaign queued recipients, held rows, and pending rows. Redesign the row summary to show one primary state such as `12,947 held recipients - 0 ready - 0 sending`, with list/direct-recipient breakdown separate and raw DB statuses de-emphasized or moved to details. |
| Model SES rolling quota and send rate | Done 2026-07-09 | Worker quota checks now use `mail_queue.updated_at` for the rolling 24-hour accepted count, not only `send_date = today UTC`. The monitor labels quota as rolling 24h and shows the configured SES max send rate plus the worker's 90% sustained target. |
| Ingest SES provider opens/clicks | Done 2026-07-09 code-side | `/api/webhooks/ses` maps SES `Open` and `Click` events into `provider_events` and no longer collapses repeated open/click events as duplicates. AWS still must publish Send/Delivery/Bounce/Complaint/Open/Click events from the configured SES configuration set to the SNS HTTPS subscription. |
| Commit/persist this operator status | Pending | `README-AI.md` is modified locally until committed. |
| Decide fate of held follow-up queues | Done 2026-06-15 live check | Production health reports `0` held pending rows. `aacdd257...` has no email row/queue rows in the live check; `7b57066...` is `sent` with `1,206` succeeded, `1` dead, and `11` canceled. |
| Prepare AI-native LifeX full-list campaign | Done 2026-05-31 | Fresh email `532a06ae...` has a hosted screenshot asset and the updated AI-native copy. |
| Send first LifeX UTC-day slice | Done 2026-05-31 | Released exact email `532a06ae...`; 53,998 LifeX recipients were accepted by SES, 1 malformed address was marked dead, and 2 earlier tests counted toward that day's global quota. The current checked-in cap is now 65,400. |
| Continue future LifeX slices | Done 2026-06-15 live check | `532a06ae...` has `0` pending and `0` processing rows. Its parent email status still reads `queued`, so clean that status if it confuses the UI. |
| Repair live-schema queue/settings drift | Done 2026-06-20 | `public.app_settings` is live with `daily_send_limit = 65,400`. Applied `20260502_mail_queue_dedupe_unique.sql` to production; `mail_queue_dedupe_hash_unique_idx` is unique, ready, and valid, and the `ON CONFLICT (dedupe_hash)` path passed a rolled-back transaction test. |
| Apply Supabase security/IO repair | Needs Supabase Advisor verification | `app_settings` is live. `unsubscribe_requests` was missing despite the earlier status note; migration `20260611_unsubscribe_requests.sql` was applied live on 2026-06-21, API grants were verified, and PostgREST schema visibility was confirmed. Supabase Advisor RLS/Disk IO status is not visible through the app API; verify in the Supabase Dashboard. |
| Analytics reliability + iPhone mode | In progress 2026-07-02 | PRD added at `docs/analytics-mobile-prd.md`. Code now includes mobile bottom nav, mobile Analytics campaign cards, and `supabase/migrations/20260702_recent_analytics_rpc.sql` for exact recent campaign analytics. Apply the migration in production before treating per-campaign provider counts as exact there. |
| Send readiness + campaign analytics detail | Follow-up migration ready 2026-08-03 | Operator applied the base analytics SQL. Live verification: recent summary and clicked-link RPCs work, SES/SNS is fresh, and the six-recipient detail/timeline works. The original detail and timeline queries time out on the 186k LifeX campaign; apply `20260803_optimize_campaign_analytics_detail.sql` to aggregate queue totals once, paginate before event aggregation, and correlate events by SES message ID. No mail was queued, released, or sent by this verification. |
| Suppress reminder-service domains | Ready to apply | `*@followupthen.com` and `*@fut.io` are global block-list domains in app code. Imports mark them `blocked`, queue creation skips them, the worker cancels stale queued rows, and migration `20260617_block_followup_domains.sql` backfills existing active list members. The Lists page has an "Apply block list" action that creates/updates the visible `Block List`. |
| Verify SES/SNS event freshness | Done 2026-05-31 | Production health is green and fresh provider events were observed on 2026-05-30. |
| Verify large-send RPCs in prod | Done 2026-05-21 | `/api/health` critical checks are green, including `claim_mail_queue_batch` and `release_mail_queue_campaign`. Re-check immediately before release. |
| Confirm queue is not accidentally due | Done 2026-06-15 live check | Production health reported `0` due pending, `0` processing, and `0` held pending. Re-check immediately before monitor use and only run the intended `emailId`; avoid the guarded global monitor except for explicit repair/debug. |
| Prepare next two LifeX newsletters | Drafted 2026-06-11 | Local HTML files in `/Users/MrAnonymous/Documents/01 LifeX/Newsletter work/` were updated to use Supabase-hosted images and reply-based unsubscribe footer. Supabase draft ids: `08df2ed7-a8a2-4ec4-9542-990d3a43c0e6` for June 11 Part 1 and `00440fb7-59a6-4730-8bfe-605f5442f1ee` for the June 25 / July Part 2 draft. Both are still `draft`; live check showed `0` queue rows. |
| Add GitHub mailer cron trigger | Done 2026-07-09 | `.github/workflows/mailer-cron.yml` runs every 5 minutes and loops guarded calls to `/api/workers/send-queued`. The endpoint only drains emails already marked `sending`, using `MAILER_CRON_SECRET` in GitHub Actions mapped to Vercel `CRON_SECRET`; it does not deploy to Vercel and does not broadly drain queued/sent campaigns. |
| Add reply-to unsubscribe logging | Table repaired 2026-06-21 | App code stores/sends `reply_to` and sets a mailto `List-Unsubscribe` header when reply-to is present. Applied `20260611_unsubscribe_requests.sql` live, granted the API roles, reloaded PostgREST, and verified `unsubscribe_requests` through the service-role REST API. |
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

A Next.js 16 + Supabase email marketing console ("Props Mailer V2"), deployed on Vercel. It replaced a legacy Meteor codebase. The app lets admins compose HTML emails, queue them, send via Amazon SES (SMTP), manage mailing lists, and track analytics. Sends are initiated manually; active `sending` campaigns can drain through the monitor tab or the GitHub Actions mailer cron trigger.

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
| Deployment | Vercel + GitHub Actions scheduled mailer trigger |

**Important:** This is **Next.js 16** — not the Next.js 14/15 you may know from training data. APIs and conventions may differ. Always read `node_modules/next/dist/docs/` before writing new Next.js-specific code (per `AGENTS.md`).

---

## Directory Map

```
src/
  app/
    (auth)/login/           # Supabase password login; /login/code for OTP; /login/bypass for fallback access
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
      account/              # Logged-in account email/password management
      lists/                # Mailing list CRUD
        [listId]/           # List detail + member management
        actions.ts          # Server actions for list ops
      users/                # Admin-only user management
    api/
      email/
        queue/route.ts      # POST: run queue worker batch for a specific emailId; GET: quota + queue depth. Both require Bearer $CRON_SECRET.
        preview/[id]/route.ts # GET: render email HTML for preview iframe
        report/route.ts     # GET ?emailId=<uuid>: per-email send report (queue outcome counts + SES event counts + first 100 unsent recipients). Requires Bearer $CRON_SECRET.
      workers/send-queued/route.ts # POST: GitHub Actions cron trigger; drains one scoped batch for an email already marked sending. Requires Bearer $CRON_SECRET.
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
  ai-operator-runbook.md    # AI playbook for live-app, UI-adjacent, Supabase, analytics, send, and operator tasks
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
3. **Send Monitor** (`/email/monitor?emailId=<uuid>`): Browser page that fires `POST /api/email/send-monitor` every 31 seconds while open for a specific email. 31s is intentional — just over Vercel's 30s hobby-tier timeout so each worker call finishes before the next fires. `/email/monitor` without an `emailId` shows a global snapshot and can run a guarded global worker for due rows whose parent email is `queued`, `sending`, or `sent`; avoid that except for explicit repair/debug tasks.
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

## Common Operator Runbooks For AI Agents

Use this section before exploring the repo for routine operational tasks. Prefer the app UI and server actions when a browser flow exists. Use direct SQL only for bulk operations, repair, or when the operator explicitly asks for database-level work. Never use Gmail for any outbound project, campaign, list, newsletter, test, or resend email.

### Frequent task index

Use these as the default entry points for common requests:

- **Send readiness check**: health, exact queue counts, quota headroom, target list size, duplicate/recent-send risk.
- **Draft from existing campaign**: clone or update a prior email while preserving sender, reply-to, campaigns, tags, and list address.
- **Create a test send safely**: use Props Mailer/SES only, usually to `a@sarva.co`, and verify it in `mail_queue`.
- **Queue without sending**: create held `mail_queue` rows and report held/due/processing counts.
- **Release/send with confirmation**: require explicit approval naming the exact email, list, body, and recipient count.
- **Stop/cancel a send**: cancel only `pending`/`processing` rows; never delete `succeeded` history.
- **Resend to unsent only**: use `dead` and/or `canceled` recipients from the original `email_id`.
- **Bounce/complaint cleanup**: mark affected `list_members` rows suppressed and cancel unsent queue rows.
- **List health audit**: count active/unsubscribed/blocked/bounced/complained members and risky domains.
- **Image asset workflow**: store images in Supabase Storage or another stable public URL and verify email HTML renders them.
- **HTML/email QA**: check links, images, sender/reply-to, unsubscribe affordance, subject, retired phrases, and mobile-safe markup.
- **Status reconciliation**: fix stale `emails.status` only after `pending = 0`, `processing = 0`, and queue outcomes are confirmed.
- **Production incident triage**: start with health, exact queue counts, `error_logs`, queue `last_error`, and SES/SNS event freshness.
- **Analytics confidence check**: distinguish SES accepted, provider-delivered, opened, clicked, bounced, and complained.

### Fast ID lookups

Most tasks need an `email_id` and/or `list_id`. Use Supabase SQL Editor, a service-role client, or the authenticated UI.

```sql
-- Find lists by name/address.
select id, name, address, description, updated_at
from public.lists
where name ilike '%SEARCH_TEXT%'
   or address ilike '%SEARCH_TEXT%'
order by updated_at desc
limit 20;

-- Find recent emails by subject/status.
select id, subject, status, from_address, created_at, updated_at
from public.emails
where subject ilike '%SEARCH_TEXT%'
order by created_at desc
limit 20;
```

For API reads, set:

```bash
export APP_BASE_URL="${APP_BASE_URL:-https://knotable-props-mailer.vercel.app}"
# CRON_SECRET must be present in the shell or copied from the deployment env.
```

### Send readiness check

Run this before queueing or releasing any non-test campaign. This is read-only until the operator explicitly approves a queue/release/send action.

1. Confirm exact `email_id`, subject, from, reply-to, and body.
2. Confirm exact `list_id`, list name/address, and active recipient count.
3. Check global queue state: due pending, held pending, and processing.
4. Check daily cap headroom.
5. Check recent sends to the same list and exact duplicate sends for the same email/list.
6. Check `/api/health` and SES/SNS event freshness if analytics or deliverability is part of the task.

```bash
curl -fsS "$APP_BASE_URL/api/health" \
  | jq '{ok, critical, warnings, failed: [.checks[] | select(.ok==false)]}'

curl -fsS \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_BASE_URL/api/email/queue" | jq .
```

SQL checks:

```sql
-- Target email.
select id, subject, status, from_address, reply_to, campaigns, tags, created_at, updated_at
from public.emails
where id = 'EMAIL_ID_HERE'::uuid;

-- Target list active size.
select l.id, l.name, l.address, count(lm.id) filter (where lm.status = 'active') as active_members
from public.lists l
left join public.list_members lm on lm.list_id = l.id
where l.id = 'LIST_ID_HERE'::uuid
group by l.id, l.name, l.address;

-- Exact queue posture for this email.
select status,
       count(*) as rows,
       count(*) filter (where available_at <= now()) as due_now,
       count(*) filter (where available_at > now()) as held
from public.mail_queue
where email_id = 'EMAIL_ID_HERE'::uuid
group by status
order by status;

-- Recent sends to same list in the last 30 days.
select mq.email_id, e.subject, mq.send_date, count(*) as succeeded_rows
from public.mail_queue mq
join public.emails e on e.id = mq.email_id
where mq.list_id = 'LIST_ID_HERE'::uuid
  and mq.status = 'succeeded'
  and mq.send_date >= current_date - interval '30 days'
group by mq.email_id, e.subject, mq.send_date
order by mq.send_date desc, succeeded_rows desc
limit 20;
```

### Unsubscribe specific emails from a list

Best path for a small operator task: update `list_members`, log `unsubscribe_requests`, and cancel any unsent queue rows for the same list/email pair. Historical `succeeded` rows are audit history; do not delete them.

Replace `LIST_ID_HERE` and the `values` list, preview the selected rows, then commit.

```sql
begin;

create temp table ai_unsubscribe_input (
  email text primary key
) on commit drop;

insert into ai_unsubscribe_input(email)
values
  (lower('person1@example.com')),
  (lower('person2@example.com'));

-- Preview the exact list and current membership before mutating.
select l.id as list_id, l.name, l.address, lm.email, lm.status, lm.unsubscribed_at
from public.lists l
join public.list_members lm on lm.list_id = l.id
join ai_unsubscribe_input i on lower(lm.email) = i.email
where l.id = 'LIST_ID_HERE'::uuid
order by lm.email;

-- Mark members unsubscribed on this list.
with target_list as (
  select id from public.lists where id = 'LIST_ID_HERE'::uuid
)
update public.list_members lm
set status = 'unsubscribed',
    source = 'manual_unsubscribe',
    unsubscribed_at = now(),
    metadata = coalesce(lm.metadata, '{}'::jsonb)
      || jsonb_build_object('manual_unsubscribe_at', now(), 'manual_unsubscribe_source', 'ai_runbook')
from target_list tl
join ai_unsubscribe_input i on true
where lm.list_id = tl.id
  and lower(lm.email) = i.email
returning lm.list_id, lm.email, lm.status, lm.unsubscribed_at;

-- Cancel pending/processing queue rows that were already materialized.
-- The worker sends from mail_queue.payload; it does not re-check list_members status.
with target_list as (
  select id from public.lists where id = 'LIST_ID_HERE'::uuid
)
update public.mail_queue mq
set status = 'canceled',
    locked_at = null,
    last_error = 'Canceled after manual list unsubscribe.',
    updated_at = now()
from target_list tl
join ai_unsubscribe_input i on true
where mq.list_id = tl.id
  and mq.status in ('pending', 'processing')
  and lower(mq.payload->>'to') = i.email
returning mq.email_id, mq.list_id, mq.payload->>'to' as recipient, mq.status;

-- Keep an operator-readable unsubscribe log.
with target_list as (
  select id from public.lists where id = 'LIST_ID_HERE'::uuid
)
insert into public.unsubscribe_requests (
  email, list_id, request_type, status, notes, requested_at, handled_at
)
select i.email,
       tl.id,
       'manual',
       'handled',
       'Manual unsubscribe applied by AI/operator runbook.',
       now(),
       now()
from ai_unsubscribe_input i
cross join target_list tl;

commit;
```

If the operator asks for a global unsubscribe across all lists, remove the `target_list` filter from the `list_members` update and cancel all `pending`/`processing` `mail_queue` rows whose `payload->>'to'` matches the input emails.

### Create a list or add people to a list

Best UI path: `/lists`.

- Use **Create or update list** for list metadata. `address` is unique.
- Use the import form on the list card for pasted CSV/TSV or uploaded rows.
- The server action chunks imports at 500 rows, lowercases email addresses, skips invalid/duplicate rows, automatically includes `a@sarva.co`, and marks configured reminder-service domains as `blocked`.
- The domain block list source of truth is `src/lib/blockList.ts`.

Direct SQL path for bulk additions:

```sql
begin;

-- Create/update the list. Prefer the owner profile for a@sarva.co.
with owner_profile as (
  select id
  from public.profiles
  where lower(email) = 'a@sarva.co'
  order by created_at asc
  limit 1
)
insert into public.lists (owner_id, name, address, description, updated_at)
select owner_profile.id,
       'LIST_NAME_HERE',
       lower('list-address@example.com'),
       'Optional description',
       now()
from owner_profile
on conflict (address) do update
set name = excluded.name,
    description = excluded.description,
    updated_at = now()
returning id, name, address;

create temp table ai_import_members (
  email text primary key,
  display_name text
) on commit drop;

insert into ai_import_members(email, display_name)
values
  (lower('person1@example.com'), 'Person One'),
  (lower('person2@example.com'), null);

-- Direct SQL imports must manually preserve the owner auto-include behavior.
insert into ai_import_members(email, display_name)
values (lower('a@sarva.co'), 'Amol Sarva')
on conflict (email) do nothing;

with target_list as (
  select id from public.lists where address = lower('list-address@example.com')
),
normalized as (
  select lower(email) as email, nullif(trim(display_name), '') as display_name
  from ai_import_members
)
insert into public.list_members as lm (
  list_id, email, status, source, unsubscribed_at, metadata
)
select target_list.id,
       normalized.email,
       case
         when normalized.email like '%@followupthen.com'
           or normalized.email like '%@fut.io'
         then 'blocked'
         else 'active'
       end,
       case
         when normalized.email like '%@followupthen.com'
           or normalized.email like '%@fut.io'
         then 'block_list'
         else 'manual'
       end,
       case
         when normalized.email like '%@followupthen.com'
           or normalized.email like '%@fut.io'
         then now()
         else null
       end,
       case
         when normalized.display_name is null then '{}'::jsonb
         else jsonb_build_object('name', normalized.display_name, 'display_name', normalized.display_name)
       end
from target_list
cross join normalized
on conflict (list_id, email) do update
set status = excluded.status,
    source = excluded.source,
    unsubscribed_at = excluded.unsubscribed_at,
    metadata = coalesce(lm.metadata, '{}'::jsonb) || excluded.metadata
returning email, status, source;

commit;
```

### Bounce, complaint, and suppression cleanup

SES webhook ingestion already auto-suppresses hard bounces and complaints in `list_members` when the event is tied to a recipient. Use this runbook when the operator asks for a manual cleanup, a backfill, or a confidence check.

Read-only audit:

```sql
select
  pe.event_type,
  count(*) as events,
  count(distinct lower(pe.recipient)) as unique_recipients,
  max(pe.received_at) as newest_event
from public.provider_events pe
where pe.event_type in ('bounced', 'complained')
group by pe.event_type
order by pe.event_type;

select lm.status, count(*) as members
from public.list_members lm
where lm.list_id = 'LIST_ID_HERE'::uuid
group by lm.status
order by lm.status;
```

Manual suppression for a reviewed email set:

```sql
begin;

create temp table ai_suppress_input (
  email text primary key,
  reason text not null
) on commit drop;

insert into ai_suppress_input(email, reason)
values
  (lower('bad@example.com'), 'manual_bounce_cleanup'),
  (lower('complaint@example.com'), 'manual_complaint_cleanup');

update public.list_members lm
set status = case
      when i.reason ilike '%complaint%' then 'complained'
      else 'bounced'
    end,
    source = i.reason,
    unsubscribed_at = coalesce(lm.unsubscribed_at, now()),
    metadata = coalesce(lm.metadata, '{}'::jsonb)
      || jsonb_build_object('suppressed_at', now(), 'suppression_reason', i.reason)
from ai_suppress_input i
where lower(lm.email) = i.email
returning lm.list_id, lm.email, lm.status, lm.source;

update public.mail_queue mq
set status = 'canceled',
    locked_at = null,
    last_error = 'Canceled after manual suppression cleanup.',
    updated_at = now()
from ai_suppress_input i
where lower(mq.payload->>'to') = i.email
  and mq.status in ('pending', 'processing')
returning mq.email_id, mq.payload->>'to' as recipient, mq.status;

commit;
```

### List health audit

Use this before sending to a large or old list, or when the user asks whether a list is clean.

```sql
-- Status distribution.
select status, count(*) as members
from public.list_members
where list_id = 'LIST_ID_HERE'::uuid
group by status
order by members desc;

-- Reminder-service and likely automation domains.
select split_part(lower(email), '@', 2) as domain, status, count(*) as members
from public.list_members
where list_id = 'LIST_ID_HERE'::uuid
group by domain, status
having split_part(lower(email), '@', 2) in ('followupthen.com', 'fut.io')
order by members desc;

-- Duplicate emails across lists.
select lower(email) as email,
       count(distinct list_id) as list_count,
       array_agg(distinct status order by status) as statuses
from public.list_members
group by lower(email)
having count(distinct list_id) > 1
order by list_count desc, email
limit 100;

-- Recent bounce/complaint recipients that are still active.
select lm.list_id, lm.email, lm.status, pe.event_type, max(pe.received_at) as last_event
from public.provider_events pe
join public.list_members lm on lower(lm.email) = lower(pe.recipient)
where pe.event_type in ('bounced', 'complained')
  and lm.status = 'active'
  and pe.received_at >= now() - interval '90 days'
group by lm.list_id, lm.email, lm.status, pe.event_type
order by last_event desc
limit 100;
```

### Craft a new email and store it

Best UI path: `/email/composer`.

- Use **Save Draft** to store the email without sending.
- Use **Preview** for local visual review.
- Use **Send Test** only when the operator wants a real SES test send. Test sends go through SES, create `mail_queue` success rows, and may mark the draft `sent`.
- Never use the retired copy phrase `From the phone of Amol`.

Direct SQL path for creating a stored draft:

```sql
with author_profile as (
  select id
  from public.profiles
  where lower(email) = 'a@sarva.co'
  order by created_at asc
  limit 1
),
created_email as (
  insert into public.emails (
    author_id,
    from_address,
    reply_to,
    subject,
    html,
    text,
    status,
    campaigns,
    tags
  )
  select author_profile.id,
         'Kmail <noreply@knotable.com>',
         'a@sarva.co',
         'SUBJECT_HERE',
         '<p>HTML_BODY_HERE</p>',
         'Plain text fallback here',
         'draft',
         array['campaign-slug'],
         array['tag-slug']
  from author_profile
  returning id
)
insert into public.email_recipients (email_id, recipient_address)
select created_email.id, 'list-or-test-recipient@example.com'
from created_email
returning email_id;
```

For an existing draft, update `emails.html`, `emails.text`, `emails.subject`, `emails.reply_to`, `emails.campaigns`, and `emails.tags`; then replace `email_recipients` if the displayed "To" recipient should change. Prefer the composer for this because `saveDraftAction` preserves recipient rollback semantics.

### Clone or adapt an existing campaign

Use this when the operator wants a follow-up, "same list", "same format", or "make a new version of that email."

1. Identify the source `email_id`.
2. Read the source `from_address`, `reply_to`, `subject`, `html`, `text`, `campaigns`, `tags`, and selected list address from `email_recipients` or `mail_queue.list_id`.
3. Create a new `emails` row with `status = 'draft'`; do not reuse the old `email_id`.
4. Add one `email_recipients` row for the intended list address so the Composer can reopen it.
5. Verify the new draft has `0` `mail_queue` rows unless the operator explicitly asked to queue.

```sql
with source_email as (
  select *
  from public.emails
  where id = 'SOURCE_EMAIL_ID_HERE'::uuid
),
source_list as (
  select l.address as list_address
  from public.mail_queue mq
  join public.lists l on l.id = mq.list_id
  where mq.email_id = 'SOURCE_EMAIL_ID_HERE'::uuid
    and mq.list_id is not null
  order by mq.created_at asc
  limit 1
),
cloned as (
  insert into public.emails (
    author_id, from_address, reply_to, subject, html, text,
    status, scheduled_at, campaigns, tags
  )
  select author_id,
         from_address,
         reply_to,
         'NEW_SUBJECT_HERE',
         '<p>NEW_HTML_HERE</p>',
         'NEW_TEXT_HERE',
         'draft',
         null,
         coalesce(campaigns, '{}'),
         coalesce(tags, '{}')
  from source_email
  returning id
)
insert into public.email_recipients (email_id, recipient_address)
select cloned.id, coalesce(source_list.list_address, 'list-address@example.com')
from cloned
left join source_list on true
returning email_id;
```

### Create a test send safely

Use `/email/composer` **Send Test** when possible. It sends through SES, defaults the UI button to `a@sarva.co`, logs successful sends to `mail_queue`, and may set the draft `emails.status = 'sent'`.

Before a test send:

- Confirm this is a real SES send and counts against quota.
- Confirm the exact recipient, usually `a@sarva.co`.
- Confirm no list queue rows will be released.

After a test send:

```sql
select id, email_id, status, send_date, ses_message_id, payload, updated_at
from public.mail_queue
where email_id = 'EMAIL_ID_HERE'::uuid
  and campaign_label like 'test:%'
order by updated_at desc
limit 20;
```

### Image asset workflow

Use stable public image URLs in email HTML. Do not embed large base64 images in `emails.html`; it bloats queue payloads and hurts deliverability.

Recommended path:

1. Store the image in Supabase Storage or another stable public CDN.
2. Use the public URL directly in the email HTML.
3. Verify the URL opens without authentication.
4. Confirm the HTML uses meaningful `alt` text and fixed/responsive image dimensions.
5. Send a test before queueing the campaign.

Useful checks:

```bash
curl -I "PUBLIC_IMAGE_URL_HERE"
```

```sql
select id, subject
from public.emails
where id = 'EMAIL_ID_HERE'::uuid
  and html ilike '%PUBLIC_IMAGE_URL_FRAGMENT%';
```

### HTML and email QA

Run this before test sends, queueing, and final release.

- Sender and reply-to are correct.
- Subject is final and not a placeholder.
- The retired phrase `From the phone of Amol` is absent.
- HTML has no local file paths, localhost URLs, or private image URLs.
- Links are intentional and open without auth unless intentionally private.
- Images have stable public URLs and useful alt text.
- The copy includes a clear reply/unsubscribe affordance when appropriate.
- Body works as minimal HTML; avoid scripts, forms, external CSS dependencies, and fragile layout.
- `text` fallback roughly matches the HTML.
- For reply-looking follow-ups, remember true mailbox threading needs `In-Reply-To`/`References`, which this app does not currently carry through the queue.

Quick SQL checks:

```sql
select id, subject
from public.emails
where id = 'EMAIL_ID_HERE'::uuid
  and (
    html ilike '%From the phone of Amol%'
    or html ilike '%localhost:%'
    or html ilike '%file://%'
    or html ilike '%TODO%'
    or subject ilike '%TODO%'
  );
```

### Queue, release, and monitor a campaign

Queueing and releasing are separate operations.

- Queue from `/email/composer` after saving a draft and selecting a list.
- `queueCampaignAction` creates `mail_queue` rows with `status = 'pending'` and `available_at = '2999-12-31T23:59:59Z'`. Those rows are held and will not send yet.
- Duplicate/recent-send warnings are intentional. Do not bypass them unless the operator explicitly confirms the audience should be contacted.
- Release from `/email/schedule` with the row's **Send Now** action. The UI adds the required confirmation token, calls `sendQueuedEmailAction`, releases rows according to the daily cap, runs one scoped worker batch, then opens `/email/monitor?emailId=<id>&auto=1`.
- Keep the scoped monitor open until `pending = 0` and `processing = 0`.

Manual/debug worker call for rows that are already due:

```bash
curl -fsS \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"emailId":"EMAIL_ID_HERE"}' \
  "$APP_BASE_URL/api/email/send-monitor" | jq .
```

The code currently supports a global worker run when `emailId` is omitted; it drains due rows whose parent email is `queued`, `sending`, or `sent`. Treat that as a repair/debug path only. For ordinary sends, always scope by `emailId`.

### Queue without sending

Use this when the operator wants to prepare a campaign but not send it yet.

Best UI path:

1. Save the draft in `/email/composer`.
2. Select the target list.
3. Use the queue action, handle duplicate/recent-send warnings only with explicit operator confirmation.
4. Stop there. Do not click **Send Now** and do not open `/email/monitor?auto=1`.

Expected result: `mail_queue` has `pending` rows held at year 2999, `pendingDue = 0`, and `processing = 0`.

```sql
select
  count(*) as total_rows,
  count(*) filter (where status = 'pending' and available_at > now()) as held_pending,
  count(*) filter (where status = 'pending' and available_at <= now()) as due_pending,
  count(*) filter (where status = 'processing') as processing
from public.mail_queue
where email_id = 'EMAIL_ID_HERE'::uuid;
```

### Release/send approval wording

Before any release or send, get explicit approval that names the side effect:

> Please confirm: release and start sending email `EMAIL_ID_HERE` / `SUBJECT_HERE` from `FROM_ADDRESS` to list `LIST_NAME` (`LIST_ID_HERE`), about `N` active recipients. This will send through Props Mailer / SES and count against quota.

Do not accept vague approvals like "go ahead" if the exact email/list/recipient count has not been stated in the same context.

### Stop or cancel a send

Use this when the operator asks to stop a queued or in-progress campaign. This preserves audit history.

- Cancel only `pending` and `processing` rows.
- Leave `succeeded`, `dead`, `failed`, and existing `canceled` rows intact.
- Set the parent email back to `draft` only if the operator wants it editable again, matching `cancelEmailAction`.

```sql
begin;

select status, count(*) as rows
from public.mail_queue
where email_id = 'EMAIL_ID_HERE'::uuid
group by status
order by status;

update public.mail_queue
set status = 'canceled',
    locked_at = null,
    last_error = 'Canceled by operator stop request.',
    updated_at = now()
where email_id = 'EMAIL_ID_HERE'::uuid
  and status in ('pending', 'processing')
returning id, payload->>'to' as recipient, status;

update public.emails
set status = 'draft',
    scheduled_at = null,
    updated_at = now()
where id = 'EMAIL_ID_HERE'::uuid
  and status in ('queued', 'sending')
returning id, subject, status;

commit;
```

After canceling, verify:

```sql
select status, count(*) as rows
from public.mail_queue
where email_id = 'EMAIL_ID_HERE'::uuid
group by status
order by status;
```

### Resend only to unsent recipients

Use this when a campaign partially sent and the operator wants a targeted resend. "Unsent" usually means original queue rows with `status in ('canceled', 'dead')`; confirm whether to include `dead` addresses, because permanent SMTP failures often should not be retried.

Create a reviewed resend list:

```sql
begin;

with owner_profile as (
  select id
  from public.profiles
  where lower(email) = 'a@sarva.co'
  order by created_at asc
  limit 1
),
created_list as (
  insert into public.lists (owner_id, name, address, description, updated_at)
  select owner_profile.id,
         'Resend unsent for EMAIL_ID_HERE',
         lower('resend-unsent-EMAIL_ID_HERE@props.local'),
         'Recipients from canceled/dead queue rows for EMAIL_ID_HERE.',
         now()
  from owner_profile
  on conflict (address) do update
  set name = excluded.name,
      description = excluded.description,
      updated_at = now()
  returning id
),
unsent as (
  select distinct lower(mq.payload->>'to') as email
  from public.mail_queue mq
  where mq.email_id = 'EMAIL_ID_HERE'::uuid
    and mq.status in ('canceled', 'dead')
    and mq.payload->>'to' is not null
)
insert into public.list_members as lm (list_id, email, status, source, metadata)
select created_list.id,
       unsent.email,
       'active',
       'resend_unsent',
       jsonb_build_object('source_email_id', 'EMAIL_ID_HERE')
from created_list
cross join unsent
on conflict (list_id, email) do update
set status = 'active',
    source = 'resend_unsent',
    metadata = coalesce(lm.metadata, '{}'::jsonb)
      || excluded.metadata
returning list_id, email, status;

commit;
```

Then clone or draft the resend email, queue it to the new list, and get explicit approval before release.

### Check queue status, mail status, and whether an email went out

Best single readout:

```bash
curl -fsS \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_BASE_URL/api/email/report?emailId=EMAIL_ID_HERE" | jq .
```

Interpretation:

- `succeeded` means SES accepted the message from the worker.
- `delivered`, `bounced`, `complained`, `opened`, and `clicked` come from `provider_events` via SES/SNS webhooks.
- `pending` plus `processing` greater than zero means the campaign is not drained.
- `dead` means permanent SMTP failure or retry exhaustion.
- `canceled` means the row was intentionally not sent, often because a queued draft was edited/canceled or a manual unsubscribe canceled unsent rows.
- `unsentRecipients` returns the first 100 `dead` or `canceled` recipients for targeted repair.

Live monitor snapshot:

```bash
curl -fsS \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_BASE_URL/api/email/send-monitor?emailId=EMAIL_ID_HERE" | jq .
```

Global queue/quota snapshot:

```bash
curl -fsS \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_BASE_URL/api/email/queue" | jq .
```

SQL fallback:

```sql
select *
from public.email_send_report
where email_id = 'EMAIL_ID_HERE'::uuid;

select status, count(*) as rows
from public.mail_queue
where email_id = 'EMAIL_ID_HERE'::uuid
group by status
order by status;

select id, subject, status, created_at, updated_at
from public.emails
where id = 'EMAIL_ID_HERE'::uuid;
```

If `mail_queue` has `pending = 0`, `processing = 0`, and `succeeded > 0` but `emails.status` is still `queued` or `sending`, the status reconciliation likely timed out. Confirm the report first, then clean the parent row:

```sql
update public.emails e
set status = 'sent',
    updated_at = now()
where e.id = 'EMAIL_ID_HERE'::uuid
  and exists (
    select 1 from public.mail_queue mq
    where mq.email_id = e.id and mq.status = 'succeeded'
  )
  and not exists (
    select 1 from public.mail_queue mq
    where mq.email_id = e.id and mq.status in ('pending', 'processing')
  )
returning id, subject, status;
```

### Check analytics performance and accuracy

Best UI path: `/email/analytics` for global summary, `/email/sends` for recent campaign history, and `/api/email/report?emailId=<uuid>` for one campaign.

Accuracy rules:

- "Sent" in the app is queue-side: `mail_queue.status = 'succeeded'`, meaning SES accepted the send.
- Provider performance is event-side: `provider_events` joined by `ses_message_id`.
- Opens/clicks are only as complete as SES event publishing and recipient tracking allow. Pixel blocking means "not opened" is not proof that a person did not read.
- Bounce/complaint/delivery freshness depends on SES -> SNS -> `/api/webhooks/ses`. Check `/api/health` before trusting event-side analytics after a deploy or AWS config change.
- The Analytics page intentionally limits per-campaign event samples to avoid high-volume table scans. Use `email_send_report` for exact per-email counts.

Useful validation SQL:

```sql
-- Event freshness by type.
select event_type, count(*) as events, max(received_at) as newest_event
from public.provider_events
group by event_type
order by newest_event desc nulls last;

-- One campaign: queue acceptance vs provider events.
select *
from public.email_send_report
where email_id = 'EMAIL_ID_HERE'::uuid;

-- Check whether succeeded queue rows can be joined to SES events.
select
  count(*) filter (where status = 'succeeded') as succeeded_rows,
  count(*) filter (where status = 'succeeded' and ses_message_id is not null) as succeeded_with_message_id,
  count(*) filter (where status = 'succeeded' and ses_message_id is null) as succeeded_missing_message_id
from public.mail_queue
where email_id = 'EMAIL_ID_HERE'::uuid;
```

Legacy/debug helper: `node check-queue-logs.mjs` reads `env.keys` and prints recent queue activity, queue metrics, error logs, and a quota summary. Its quota printout has been stale before, so prefer `getDailySendLimit()`/`app_settings` or `/api/email/queue` for the real daily cap.

### Production incident triage

Use this when the user says something is broken, hung, not sending, missing from analytics, or showing an internal error. Start read-only.

1. Identify the user action: Save Draft, Send Test, Queue, Send Now, Monitor, Analytics, Past Sends, Lists, or Login.
2. Capture the exact page URL, visible error, subject, list, and approximate timestamp.
3. Check `/api/health`.
4. Check exact queue counts for the target `email_id` and global due/processing counts.
5. Check `error_logs` around the timestamp, excluding `source like 'rate_limit:%'` unless rate limiting is the suspected issue.
6. Check `mail_queue.last_error` and stuck `processing` rows.
7. Check SES/SNS event freshness if analytics or delivery confirmation is the issue.
8. If editing Next.js code, read the relevant `node_modules/next/dist/docs/` guide first.

Useful SQL:

```sql
-- Recent real app errors.
select created_at, source, message, payload
from public.error_logs
where created_at >= now() - interval '6 hours'
  and source not like 'rate_limit:%'
order by created_at desc
limit 50;

-- Queue failures and stuck rows for one email.
select id,
       payload->>'to' as recipient,
       status,
       attempts,
       max_attempts,
       available_at,
       locked_at,
       last_error,
       updated_at
from public.mail_queue
where email_id = 'EMAIL_ID_HERE'::uuid
  and (
    status in ('failed', 'dead', 'processing')
    or last_error is not null
  )
order by updated_at desc
limit 100;

-- Provider event freshness.
select event_type, max(received_at) as newest_event, count(*) as events
from public.provider_events
where received_at >= now() - interval '7 days'
group by event_type
order by newest_event desc nulls last;
```

Common interpretations:

- Composer queue error with no `mail_queue` rows: likely validation, duplicate/recent-send confirmation, list lookup, or server-action error.
- Queue rows held at year 2999: queued but not released; this is expected after queue-only preparation.
- Due pending rows but monitor not draining: verify scoped `emailId`, `CRON_SECRET`, daily cap headroom, and `last_error`.
- `454 Maximum sending rate exceeded`: transient SES throttling; use scoped worker calls and allow backoff, do not switch to Gmail.
- `succeeded` rows with no provider events: SES accepted the mail, but SNS/event publishing may be missing or delayed.

---

## Auth Flow

- Supabase Auth supports both email/password and one-time email codes (OTP)
- Login page at `(auth)/login/` is the conventional username/password form; `/login/code` handles one-time codes; `/login/bypass` handles the emergency bypass password; token handler at `/loginWithToken`
- Authenticated users manage their sign-in email and password at `(dashboard)/account/`; bypass sessions can view access status there but cannot mutate Supabase account credentials
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
- Analytics reliability + iPhone mode PRD lives at `docs/analytics-mobile-prd.md`; next production step is to apply `supabase/migrations/20260702_recent_analytics_rpc.sql` and verify a known large campaign.
- Campaign detail and readiness UI require `supabase/migrations/20260714_campaign_analytics_detail.sql`, followed by `supabase/migrations/20260803_optimize_campaign_analytics_detail.sql` for six-figure campaigns. AWS/Vercel tracking setup and metric definitions are documented in `docs/analytics-tracking-setup.md`.
- Route protection via middleware is partially implemented
- One-time mail-merge audiences intentionally avoid Supabase schema changes for now: CSV imports are stored as `lists.access_level = 'one_time_csv'`, synthetic `one-time-...@props.sarva.co` list addresses, and per-row merge fields in `list_members.metadata.merge`; queued rows copy those fields into `mail_queue.payload.merge`. Future tax: add first-class `audiences` / `audience_members` tables, audience type enums, original CSV storage, cleanup/archive semantics, and migration of these shoehorned list records.

---

## Conventions & Gotchas

- **Supabase clients**: Use `supabaseAdmin` (service role) for server actions and queue worker. Use `supabaseServer` for SSR components that need user context. Never import `supabaseAdmin` in client components.
- **Server actions** live in `actions.ts` co-located with their page directory.
- **Zod** is used for all API input validation.
- **Never send through Gmail**: Do not use Gmail, Gmail drafts, or the Gmail connector for any outbound project/campaign/list/newsletter/test/resend email. Use Props Mailer / SES flows only.
- **No Cron**: Do not add Vercel Cron entries — queue draining is handled by the monitor page (`/email/monitor`), which fires the worker every 31s while open. `vercel.json` intentionally stays `{}`.
- **Rate limiting**: Use `checkRateLimit(key, max, windowMs)` (async, DB-backed via `error_logs` sentinel rows) for any endpoint that needs cross-instance protection. Use `checkRateLimitSync` only where async is impossible (currently: login server action). The DB version writes rows with `source = 'rate_limit:<key>'` and `message = 'hit'` — don't mistake these for real errors when reading `error_logs`.
- **Monitor page auth**: `/api/email/send-monitor` uses the same `CRON_SECRET` bearer token as `/api/email/queue`. The server component at `/email/monitor/page.tsx` passes `process.env.CRON_SECRET` to the client component so the browser can authenticate its polling calls. `CRON_SECRET` must be set in Vercel env vars or the monitor page will show a warning and refuse to fire.
- **Scoped queue drains by default**: Worker POST routes and `runQueueWorker` accept a missing `emailId` for a guarded global drain of due rows whose parent email is `queued`, `sending`, or `sent`. Treat that as repair/debug only. Ordinary campaign sends should use a row's **Send Now** action or `/email/monitor?emailId=<uuid>` so the worker is scoped to one email.
- **Queue hold pattern**: When `queueCampaignAction` inserts queue rows, all rows get `available_at = '2999-12-31T23:59:59Z'` (the `QUEUE_HOLD_AT` constant). `sendQueuedEmailAction` requires a per-email release confirmation token, preflights counts, and then updates `available_at` to `now()` for the rows being released. This two-step pattern lets you inspect and cancel before anything goes out.
- **Feature flags**: Use `getFeatureFlag(key)` from `featureFlags.ts`; defaults to `true` if the key doesn't exist in the DB.
- **Email copy convention**: Never use the header phrase `From the phone of Amol` in drafts, templates, or sent email copy. Amol explicitly retired it on 2026-05-31.
- **Schema changes**: Add a new file to `supabase/migrations/` with the format `YYYYMMDD_description.sql`. Update `schema.sql` to match. Then regenerate types: `supabase gen types typescript > src/supabase/types.ts`.
- **Next.js version**: Always check `node_modules/next/dist/docs/` before using Next.js APIs — this is v16, not v14/15.

---

## Composer UI Features

- **WYSIWYG HTML editor**: The composer defaults to a visual `contentEditable` editor with paragraph, heading, emphasis, list, link, and clear-format controls. The **HTML source** tab remains available for exact markup edits. Both modes synchronize into the existing `html` form value so autosave, preview, test sends, and queueing keep the same server-action contract.
- **Per-recipient merge tags**: Campaign subject, HTML, and text support `{{firstName}}`, `{{name}}`, and `{{email}}` placeholders. The queue worker renders them per recipient at send time using `mail_queue.payload.toName` and `payload.to`, so queued campaigns do not duplicate full HTML per recipient. `{{firstName|friend}}` style fallbacks are supported for recipients without stored names.
- **One-time mail merge audiences**: The composer can import/paste a CSV with an `email` header plus arbitrary fields such as `name`, `first_name`, `opener`, `company`, or `custom_note`. The UI validates valid/skipped rows, previews a selected row, imports the data as a one-time list without schema changes, and queues through the normal approval/SES path. Arbitrary CSV headers render as merge tags such as `{{opener}}` or `{{company|your team}}`.
- **Preview button**: Opens a new `800×700` browser window and writes the current synchronized HTML content into it via `document.write`. Purely client-side — no save required. Added to `composer-form.tsx` alongside the other action buttons.
- **Send Test button**: Calls `sendTestAction` (in `email/actions.ts`) but overrides `recipients` in the FormData to `a@sarva.co` (owner address). Does not affect the To field or selected list. Test sends appear in Past Sends (`mail_queue` row with `status = 'succeeded'`). The action accepts any valid `recipients` value — the caller controls the destination.
