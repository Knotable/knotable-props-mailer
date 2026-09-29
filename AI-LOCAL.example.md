# AI-LOCAL.md — operating Props Mailer through AI mode (`/ai`)

> **Setup (once per machine):** `cp AI-LOCAL.example.md AI-LOCAL.md`, then fill in
> **My credentials** below. `AI-LOCAL.md` is gitignored and this repository is
> public, so never paste a password into this `.example` file or any committed file.

This file is for AI agents (Claude Code, Codex, Cursor, browser agents) running on
this machine. It says how to sign in to the live Props Mailer and use its agent
interface. For the codebase and send history, read `README-AI.md`.

## My credentials (fill in only in AI-LOCAL.md)

- App: `https://knotable-props-mailer.vercel.app`
- Owner account: `a@sarva.co`
- Bypass password: `PASTE-HERE`
  - Get it by running GitHub **Actions → Reset bypass password → Run workflow** with
    `confirm=rotate`. The new password is emailed to the operator address and is never
    printed in logs. Rotating it signs out every existing bypass session.
- Supabase password for `a@sarva.co` (optional, for `login_password`): `PASTE-HERE`

## Sign in (curl)

The session is a cookie, so keep a cookie jar and send it on every request.

```bash
BASE=https://knotable-props-mailer.vercel.app
JAR=/tmp/props-ai.cookies

# Bypass sign-in: acts as the owner for 12 hours. Limited to 5 tries per 15 minutes.
curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/ai/do/login_bypass" \
  -F format=json -F password='<bypass password>'
# → {"action":"login_bypass","ok":true,"message":"Signed in with bypass.","next":"/ai"}

# Or sign in with email + password:
curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/ai/do/login_password" \
  -F format=json -F email=a@sarva.co -F password='<password>'

# Check you're signed in: "signedInAs" should be "a@sarva.co".
curl -s -b "$JAR" "$BASE/ai/status?format=json"

# Sign out
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/ai/do/logout" -F format=json
```

## Sign in (browser agent)

Open `$BASE/ai/login`, fill `#login_bypass-password`, and click `#submit-login_bypass`.
Success redirects to `/ai?result=…&ok=1`. Every page is plain HTML with no scripts.
The result is in `#result[data-ok]`, and each form is `#form-<action>` with fields
`#<action>-<field>`.

## Using it

- Start at `GET /ai?format=json`, the catalog of every page and action. Any page returns
  JSON with `?format=json`, including the actions valid right now and their fields.
- Pages: `/ai/status`, `/ai/campaigns[?status=draft|queued|sending|sent|all&q=&limit=]`,
  `/ai/campaigns/new`, `/ai/campaigns/{id}` (plus `/log` and `/analytics`), `/ai/lists`,
  `/ai/lists/{id}[?q=&status=&page=]`.
- Actions are `POST /ai/do/<action>` as form fields. Add `format=json` for a JSON reply.
  Without it, the reply is a 303 redirect with `?result=…&ok=1|0`.
- Leave out the `Origin` header or set it to the app's own origin. Cross-site posts are
  rejected.
- If you get a JSON error saying "Not signed in", your cookie is missing or expired.
  Sign in again.

| Action | Fields | Notes |
|---|---|---|
| `save_draft` | `id`? `from` `replyTo`? `subject` `html` `recipients`? `campaigns`? `tags`? | Leave `id` blank to create a new draft. Words like draft, test or TBD in the subject block sending. |
| `duplicate`, `test_to_me` | `id` | `test_to_me` emails only the signed-in user. |
| `test_send` | `id` `recipients` | |
| `queue` | `id` `list_id` (repeat for several lists) `confirm_recent_contact`? `exclude_exact_duplicates`? | Builds the audience. **Sends nothing.** |
| `send` | `id` `confirm_recipients` `send_at`? `send_window`? | **Real send.** `confirm_recipients` must equal the unsent count on the campaign page. |
| `pause`, `unqueue`, `edit`, `mark_sent`, `retry_failed` | `id` | |
| `delete` | `id` `confirm=delete` | |
| `list_upsert` | `name` `address` `description`? | |
| `list_import` | `list_id` `members` | One address per line. Automated senders (noreply@, invoice@, mail.company.com…) are blocked automatically. |
| `member_suppress` | `list_id` `member_id` | |

## Rules for agents

1. **Never run `send` without the human's explicit OK** for that campaign id and its
   exact unsent count. `queue`, drafts and `test_to_me` are safe to prepare first.
2. Never send campaign or list mail through Gmail or any other channel. All mail goes
   through Props Mailer / SES.
3. The SES account is under review (Sep 2026) for bounces and complaints. Send only to
   cleaned lists of people who opted in.
4. Don't print or commit credentials. Don't copy this file into the repository.
5. User and permission admin can only be done by a human in the normal UI.
