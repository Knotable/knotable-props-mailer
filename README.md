# Knotable Props Mailer V2

An admin console for composing and operating HTML email campaigns through **Amazon SES**. Supabase and Vercel still host the legacy authoring UI and historical data, but campaigns above 10,000 recipients are moving to an AWS-native execution plane: immutable S3 campaign packages, DynamoDB recipient state, SES sending, and SNS/Lambda/S3 events. A browser tab, Vercel request, and Supabase queue must not keep a large send alive.

> **150k status (2026-09-04): code hardened; cloud approval/deployment and canaries remain.** The immutable manifest now defines three non-overlapping approval batches; the worker accepts an exact batch number, refuses partial-batch quota, checkpoints per-batch counters, promotes but never sends the next batch, and claims the operator completion notice at most once. `/email/aws-native` reads DynamoDB state and dispatches only a separately confirmed batch. The worker emits recipient-specific RFC 8058 headers, but the narrow public AWS unsubscribe endpoint and OIDC IAM role still require explicit security-boundary approval before they are added/deployed. The SES quota will remain `65,400/24h`; releases therefore wait for `50,001` rolling headroom and will ordinarily be about 24 hours apart. Graduated canaries remain mandatory.

> **Analytics status (2026-09-04): live and verified.** The old 50-campaign aggregate timed out. The page now renders campaign identities immediately, refreshes only one campaign and one bounded metric at a time, caches completed rows in the browser for 15 minutes, labels active work, and offers **Update now**. `20260904_lazy_campaign_analytics.sql` was applied transactionally and the six-metric test passed for completed campaign `4ea3511e-64e7-40a0-94af-08d5381bd110`. This legacy screen is not the status source for future AWS-native campaigns.

> **Release hygiene (2026-09-04): verified.** Next.js is patched to `16.3.4`, Nodemailer to `10.0.0`, and Vitest/Vite to `5.0.0`/`8.2.2`. The production build and all 49 tests pass, lint has no errors, and `npm audit` reports zero known vulnerabilities.

> ⚠️ **Before enabling the AWS control page, read [Security — do this before you go live](#security--do-this-before-you-go-live).** The bypass credentials are now server-side and fail closed, but production needs fresh values; old subscriber PII and the retired credential values remain in git history.

---

## What you'll need, and what it costs

| Tool | Cost | What it's for |
|---|---|---|
| GitHub account | Free | Hosts the code, connects to Vercel |
| [Supabase](https://supabase.com) project | Free tier | Database, auth, file storage |
| [Vercel](https://vercel.com) account | Free (Hobby) | Hosting/deployment |
| [AWS](https://aws.amazon.com) account + SES | **Not free** — pay-as-you-go, ~$0.10 per 1,000 emails | Actually sending the emails |
| Domain name (optional) | **Not free** — typically $10–20/yr | A real URL instead of `*.vercel.app` |
| [Cloudflare](https://cloudflare.com) (optional) | Free | DNS for your domain |

So: everything is free except AWS (a few cents per send) and, if you want one, a domain name (a few dollars a year — Cloudflare doesn't mark domains up, but it doesn't give them away either).

---

## The 5-minute path (local dev, no real sending yet)

This gets the app running on your laptop with a real database and working login. Sending actual email comes after, in its own section, because AWS approval can take a few hours.

### 1. Clone and install
```bash
git clone <your-repo-url>
cd knotable-props-mailer
npm install
```

### 2. Create a free Supabase project (~2 min)
1. Go to [supabase.com](https://supabase.com) → **New project**. Pick any name/region, generate a database password (save it somewhere), and wait ~1 minute for provisioning.
2. In your new project: **SQL Editor** → paste the contents of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. Then run every file in [`supabase/migrations/`](supabase/migrations) **in filename order** (they're dated `YYYYMMDD_*.sql`) the same way — paste, run, next file.
4. Go to **Settings → API** and copy three values: **Project URL**, **anon public key**, and **service_role secret key**. Go to **Settings → API → JWT Settings** and copy the **JWT secret** too.

### 3. Set up your local environment file
```bash
cp .env.example .env.local
```
Fill in the four Supabase values from step 2. Leave the `AWS_SES_*` values alone for now — the app runs fine without them, it just can't send real mail yet.

Also add these two (not in `.env.example` but required for login + the queue worker):
```bash
ALLOWED_EMAIL=you@yourdomain.com   # the one admin email allowed to log in
CRON_SECRET=$(openssl rand -hex 32)
```

### 4. Run it
```bash
npm run dev
```
Open **http://localhost:3000**. Log in with a magic-link code sent to `ALLOWED_EMAIL` via Supabase Auth (check your inbox — Supabase's free-tier email sender is rate-limited to a couple of emails per hour, so don't spam the login button).

### 5. Check your work
```bash
curl -s http://localhost:3000/api/health | jq
```
This hits a built-in self-check that lists every env var, DB table, and DB function the app expects, with copy-pasteable fixes for anything missing. Green (`"ok": true`) means your Supabase setup is correct. Keep this URL bookmarked — use it again after every deploy.

**You're up and running.** Next: hook up AWS SES so you can actually send mail, then deploy to Vercel.

---

## Setting up AWS SES (the one part that isn't free)

SES bills per email (~$0.10/1,000) — there's no meaningful free tier when sending from Vercel (the famous "62,000 free emails" only applies to mail sent from an EC2 instance, which doesn't apply here). Budget a few dollars a month at most for typical newsletter volumes.

1. **Create an AWS account** at [aws.amazon.com](https://aws.amazon.com) if you don't have one.
2. **Pick a region** (e.g. `us-east-1`) and go to **SES → Verified identities → Create identity**. Verify either a single email address or, better, your whole sending domain (SES gives you DNS records to add — see the Cloudflare section below).
3. **Create SMTP credentials**: SES → **SMTP settings** → **Create SMTP credentials**. This opens an IAM user for you — click **Create user**, then **Show** on the password and copy it immediately (it cannot be retrieved again). These SMTP credentials are *not* the same as a regular AWS access key — don't substitute one for the other.
4. **You start in SES Sandbox mode**: you can only send to verified addresses, capped at 200 emails/day. To send to real subscribers, go to **SES → Account dashboard → Request production access**, describe your use case (a newsletter/transactional mailer), and submit. Approval is usually a few hours, sometimes up to a day.
5. **(Recommended) Wire up delivery tracking**: SES → **Configuration sets** → create one → **Event destinations** → add an **SNS** destination for Send/Delivery/Bounce/Complaint/Open/Click. Create an SNS topic, subscribe it to `https://<your-app>/api/webhooks/ses` (HTTPS protocol) — the app auto-confirms the subscription. This is what powers the Analytics tab and auto-unsubscribes hard bounces/complaints.
6. **Add the values to your env**:
   ```
   AWS_SES_SMTP_ENDPOINT=email-smtp.us-east-1.amazonaws.com
   AWS_SES_SMTP_PORT=587
   AWS_SES_SMTP_USERNAME=<from step 3>
   AWS_SES_SMTP_PASSWORD=<from step 3>
   AWS_SES_CONFIGURATION_SET=<from step 5, optional>
   AWS_SES_SNS_TOPIC_ARN=<from step 5, optional but recommended — locks the webhook to your topic>
   ```

More detail and troubleshooting (rotating credentials, common SMTP error codes) is in [`docs/ses-smtp-setup.md`](docs/ses-smtp-setup.md).

---

## Deploying to Vercel (free)

1. Push your repo to GitHub if it isn't already there.
2. At [vercel.com](https://vercel.com) → **Add New → Project** → import the repo. Vercel auto-detects Next.js — no config needed.
3. Before the first deploy (or right after, then redeploy), add **every** variable from `.env.example` plus `ALLOWED_EMAIL` and `CRON_SECRET` under **Project Settings → Environment Variables**. Set `APP_BASE_URL` to your real Vercel URL (e.g. `https://your-app.vercel.app`).
4. Deploy. **Don't add a Vercel Cron job** — this app intentionally has none (`vercel.json` stays `{}`). For legacy campaigns already materialized in `mail_queue`, use the campaign-scoped GitHub repair worker. New campaigns above 10,000 recipients use the AWS-native worker after its production gates pass; neither flow depends on keeping a browser tab open.
5. Verify: `curl https://your-app.vercel.app/api/health | jq`.

That's the whole deploy. Every future `git push` to your default branch auto-redeploys.

---

## Optional: a custom domain via Cloudflare

Skip this if `your-app.vercel.app` is good enough — it works exactly the same.

1. **Buy a domain.** Any registrar works; [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/) sells at wholesale cost with no markup, which is about as cheap as it gets (still real money, typically $10–20/yr depending on the TLD).
2. **Point DNS at Cloudflare** (free plan): add your domain to Cloudflare, then update your registrar's nameservers to the two Cloudflare gives you.
3. **Add the domain in Vercel**: Project → **Settings → Domains** → add your domain. Vercel shows you a CNAME (or A record) to create.
4. **Create that record in Cloudflare's DNS tab.** If you want Cloudflare's proxy/CDN features, that's fine — Vercel works behind it. SSL is automatic either way.
5. **Verify your sending domain in SES too** (separate from the web domain, or a subdomain like `mail.yourdomain.com`) — SES gives you TXT/CNAME records, add those in Cloudflare DNS the same way. Propagation is usually under an hour.
6. Update `APP_BASE_URL` in Vercel's env vars to your new domain and redeploy.

---

## Environment variables reference

| Variable | Required | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase → Settings → API → anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase → Settings → API → service_role secret key — **never expose this client-side** |
| `SUPABASE_JWT_SECRET` | Yes | Supabase → Settings → API → JWT Settings |
| `ALLOWED_EMAIL` | Yes | The one admin email allowed to log in (single-admin app, see below) |
| `CRON_SECRET` | Yes | Generate yourself: `openssl rand -hex 32` |
| `BYPASS_PASSWORD_SHA256` / `BYPASS_COOKIE_HMAC_KEY` | Optional emergency login | Fresh SHA-256 password hash and independent random 32-byte key; bypass is disabled unless both are valid 64-character hex |
| `AWS_SES_SMTP_USERNAME` / `AWS_SES_SMTP_PASSWORD` | Yes, for sending | AWS SES → SMTP settings → Create SMTP credentials |
| `AWS_SES_SMTP_ENDPOINT` | Yes, for sending | e.g. `email-smtp.us-east-1.amazonaws.com` |
| `AWS_SES_SMTP_PORT` | No (defaults 587) | 587 (STARTTLS) or 465 (TLS) |
| `AWS_SES_CONFIGURATION_SET` | Recommended | SES → Configuration sets |
| `AWS_SES_SNS_TOPIC_ARN` | Recommended | SNS → Topics — locks the bounce/open webhook to your topic |
| `APP_BASE_URL` | Yes | Your deployed URL, e.g. `https://your-app.vercel.app` |
| `AWS_REGION` / `AWS_SES_NATIVE_CONFIGURATION_SET` | AWS-native path | Region and dedicated native SES configuration set |
| `SES_CAMPAIGN_BUCKET` / `SES_CAMPAIGN_STATE_TABLE` | AWS-native path | Immutable campaign S3 bucket and DynamoDB execution-state table |
| `AWS_NATIVE_CONTROL_ENABLED` | AWS control page | Keep `false` until cloud deployment, credentials, live readiness, and canaries are complete |
| `GITHUB_ACTIONS_DISPATCH_TOKEN` | AWS control page | Fine-grained token limited to Actions: write for this repository |
| `GITHUB_REPOSITORY` / `GITHUB_ACTIONS_REF` | AWS control page | Defaults to `Knotable/knotable-props-mailer` / `master` |
| `SES_UNSUBSCRIBE_BASE_URL` / `SES_UNSUBSCRIBE_SECRET_ARN` | Native worker | Approved AWS unsubscribe endpoint and its Secrets Manager key |
| `SES_OPERATOR_EMAIL` / `SES_APP_URL` | Native worker | Completion-notice recipient and return-to-app base URL |

Run `curl <your-url>/api/health` any time — it tells you exactly which of these are missing and how to fix each one.

---

## How sending actually works (so you don't get surprised)

- There's **no Vercel cron or browser-owned drain**. Legacy Supabase campaigns use a campaign-scoped GitHub Actions repair worker. New large campaigns target the AWS-native worker, which survives closing the app because S3 and DynamoDB—not the browser—own its inputs and checkpoints.
- The native flow partitions one immutable manifest into three digest-bound release batches. It checks rolling SES headroom for the entire batch plus one completion notice, stops on ambiguous `CLAIMED` recipients, and never sends a later batch automatically. Per-batch checkpoints, typed approval, native status/control, and at-most-once completion-notice code are checked in. Production authorization still requires the narrow AWS OIDC/unsubscribe infrastructure, all live variables, a green `npm run check:150k -- --live`, and graduated canaries.
- This app assumes **one admin user** (`ALLOWED_EMAIL`). There's no multi-user invite flow yet.

---

## Feature backlog

These are product requests that should be prioritized deliberately before implementation:

- **Amazon SES suppression-list reconciliation.** Add sync or reconciliation with Amazon SES account-level suppression lists so Props Mailer can detect addresses SES has already suppressed, mark matching list members appropriately, and avoid queueing mail that SES will reject or silently suppress.
- **Embeddable newsletter sign-up widget.** Build a Mailchimp-like sign-up box that can be pasted into another website as a content item. Consider backing submissions with Google Apps Script or another highly available lightweight endpoint so sign-ups still work if the Props Mailer host is asleep, redeploying, or unavailable. Clarify the unfinished requirement after: "but I do want to ...".
- **Performance and usability sprint.** The web app UI is redundant and can feel slow. Review repeated controls, duplicate queue/status language, over-fetching, and slow remote calls; simplify the interface around the operator's main tasks.
- **Informative progress feedback.** When the app is waiting on remote calls, show clear progress text such as "Saving draft to Supabase", "Preparing recipients", "Queueing batch 3", or "Sending through SES" so the page does not feel stuck during slow operations.

---

## Useful commands

```bash
npm run dev      # local dev server
npm run build    # production build
npm run lint     # eslint
npm test         # vitest
npm run check:analytics       # read-only sequential test of one campaign's six bounded analytics metrics
npm run check:150k            # static 150k/three-batch AWS-native gates; expected red until cutover is complete
npm run check:150k -- --live  # read-only live SES/S3/DynamoDB/event checks; never sends
```

---

## Project structure

```
src/app/(auth)/login       passwordless magic-link login
src/app/(dashboard)/email  composer, schedule, monitor, sends, analytics
src/app/(dashboard)/lists  mailing list CRUD
src/app/api                queue worker, health check, SES webhook
src/lib                    Supabase clients, SES client, queue worker, auth
supabase/schema.sql        canonical DB schema — run this first
supabase/migrations/       incremental changes — run in date order after schema.sql
docs/                      SES setup guide, data model, roadmap
```

For a deep architectural walkthrough (full schema, send pipeline, conventions), see [`README-AI.md`](README-AI.md).

---

## Security — do this before you go live

A security pass on this repo found a few issues. Status as of this branch:

1. **🟡 Fixed in code; fresh production values required — auth bypass.** The checked-in password hash and cookie-signing key were removed. Bypass now fails closed unless `BYPASS_PASSWORD_SHA256` and `BYPASS_COOKIE_HMAC_KEY` are distinct valid 64-character hex values, and the login is limited to five attempts per 15 minutes per app instance. Generate a fresh password hash with `printf %s 'NEW-LONG-PASSWORD' | shasum -a 256` and an independent signing key with `openssl rand -hex 32`, store both only in Vercel, and redeploy. The retired values remain in git history, so do not reuse the old bypass password or key.
2. **🟢 Fixed (on this branch) — real subscriber PII committed to the repo.** The `.csv`/`.txt` files that lived at the repo root (`list_members_import.csv`, `amols-*.csv`, `AMOLPERS-bounceclean-*.csv`, 14MB+ total) have been removed from tracking, and `.gitignore` now blocks root-level `*.csv`/`*.txt` so they can't be re-added by accident. `import_contacts.py` and `import_list.mjs` now expect list exports at `private/<file>.csv` (already gitignored) instead of the repo root.
   - **Caveat:** this only stops *future* commits from carrying this data. The original files are still recoverable from this repo's pre-existing git history (they were committed on `master`, not introduced by this branch). Removing them from history for good means rewriting commits with `git filter-repo` (or BFG) and force-pushing — a disruptive, one-way operation that needs a deliberate, separate pass with everyone's buy-in, not something to do as a drive-by fix.
3. **🟡 Partially fixed — smaller hardening items.**
   - ~~`import_contacts.py` hardcoded the production Supabase URL and anon key~~ — fixed alongside #2: it now reads `SUPABASE_PROJECT_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the environment (and uses the service-role key, since `list_members` now requires it under RLS anyway — the anon key wouldn't have worked).
   - ~~`bypassLogin` had no rate limiting~~ — fixed with a five-attempt/15-minute per-instance gate. A future distributed limiter would give stronger multi-instance protection.
   - The `CRON_SECRET` bearer-token checks in `/api/email/queue`, `/api/email/send-monitor`, and `/api/email/report` still use plain `!==` instead of a timing-safe comparison. Still open.

Everything else — SNS webhook signature verification, RLS policies, CSP headers, rate limiting on the public webhook — was solid.
