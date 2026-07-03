# AI Operator Runbook

Use this guide when the user asks for a Props Mailer task that is operational,
UI-adjacent, or email-campaign related rather than a normal coding task.

Read this after `README-AI.md` and before clicking around, editing production
data, queueing, sending, opening the monitor, or diagnosing a send.

## First Principles

- Never use Gmail or the Gmail connector for project, campaign, newsletter,
  list, test, resend, or follow-up emails. Use Props Mailer and SES only.
- Treat sends, queue releases, monitor runs, and production database writes as
  external side effects. Do not send or release mail without explicit approval
  for the exact subject, body, sender, list/recipients, and recipient count.
- Prefer read-only inspection first. Confirm the exact `email_id` and `list_id`
  before mutating anything.
- Do not open or auto-run `/email/monitor` casually. Use
  `/email/monitor?emailId=<uuid>` for ordinary campaign work. A guarded global
  worker path exists for repair/debug only and needs explicit operator intent.
- Health checks can use planner estimates. If `/api/health` reports due queue
  work, verify with exact per-status counts before assuming there is live work.
- If the task touches Next.js code, follow `AGENTS.md`: read the relevant
  `node_modules/next/dist/docs/` guide before editing.

## Standard Startup

1. Read `README-AI.md` completely.
2. Read this runbook if the request involves drafting, sending, list work,
   analytics, delivery reconciliation, screenshots of the UI, or operational
   debugging.
3. Restate the current safety posture when relevant: current queue due count,
   processing count, held count, SES daily cap, and whether you will avoid
   sending until confirmation.
4. Inspect before acting:
   - For a screenshot, identify the page and any visible subject/list/error.
   - For a campaign, find the `emails.id`.
   - For a list, find the `lists.id` and exact active member count.
   - For queue work, get exact counts for the target email.

## Startup Menu

If the user's first message is broad, vague, or asks what you can do here,
offer this menu instead of silently exploring:

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
> For anything that sends, releases, queues, or mutates production data, I will
> inspect first and ask for exact approval before the side effect.

Skip the menu when the user has already asked for a concrete task.

## Useful Read-Only Checks

Use env variables from `.env.local`; do not print secret values. If local
`CRON_SECRET` does not authenticate the deployed app, use Supabase REST with the
service-role key for read-only checks.

Find a campaign by subject:

```bash
zsh -lc 'set -a; source .env.local; curl -sS "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/emails?select=id,subject,status,from_address,reply_to,created_at,updated_at,sent_at,campaigns,tags,is_test&subject=ilike.*More%20AI*&order=created_at.desc&limit=10" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"'
```

Read the send report for one campaign:

```bash
zsh -lc 'set -a; source .env.local; curl -sS "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/email_send_report?select=*&email_id=eq.<email_id>" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"'
```

Exact queue count for one campaign/status:

```bash
zsh -lc 'set -a; source .env.local; curl -sS -i "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/mail_queue?select=id&email_id=eq.<email_id>&status=eq.pending&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Prefer: count=exact" | tr -d "\r" | sed -n "/^content-range:/p"'
```

Exact global due/processing/held counts:

```bash
zsh -lc 'set -a; source .env.local; NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ); curl -sS -i "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/mail_queue?select=id&status=eq.pending&available_at=lte.$NOW&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Prefer: count=exact" | tr -d "\r" | sed -n "/^content-range:/p"'
zsh -lc 'set -a; source .env.local; curl -sS -i "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/mail_queue?select=id&status=eq.processing&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Prefer: count=exact" | tr -d "\r" | sed -n "/^content-range:/p"'
zsh -lc 'set -a; source .env.local; NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ); curl -sS -i "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/mail_queue?select=id&status=eq.pending&available_at=gt.$NOW&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Prefer: count=exact" | tr -d "\r" | sed -n "/^content-range:/p"'
```

Find the list for a campaign and active member count:

```bash
zsh -lc 'set -a; source .env.local; curl -sS "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/mail_queue?select=list_id&email_id=eq.<email_id>&list_id=not.is.null&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"'
zsh -lc 'set -a; source .env.local; curl -sS -i "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/list_members?select=id&list_id=eq.<list_id>&status=eq.active&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Prefer: count=exact" | tr -d "\r" | sed -n "/^content-range:/p"'
```

## Reconciling Sent vs Delivered

When the user asks whether an email was delivered, distinguish three layers:

- `mail_queue.status = succeeded`: Props Mailer submitted the message and SES
  accepted it over SMTP.
- `provider_events.event_type = delivered`: SES/SNS confirmed delivery to the
  recipient's receiving mail server.
- Opens/clicks: tracking events, not proof of delivery to every recipient.

Procedure:

1. Find the `emails.id` by subject, UI URL, screenshot, or recent history.
2. Read `email_send_report` for that id.
3. Query `mail_queue` samples to verify `ses_message_id` exists.
4. Query `provider_events` by `email_id` and, if needed, by a sample
   `ses_message_id`.
5. Report conservatively:
   - If `succeeded = total_queued` and `delivered = 0`, say "SES accepted all
     rows, but we do not have provider-confirmed delivery events."
   - If bounces/complaints exist, state the exact counts.
   - If no pending/processing/dead/canceled rows remain, state that the app
     queue drained.

## Drafting Follow-Ups

For "bubble this up", "reply-looking", or similar follow-ups:

1. Use the same From and Reply-To as the original unless the user says
   otherwise.
2. Use the same list only after confirming the active member count.
3. Use a `Re:` subject if the user wants it to look like a reply.
4. Be clear that true mailbox threading needs `In-Reply-To` and `References`
   headers. This app does not currently carry those fields through the queue,
   and older campaigns may not have the original RFC `Message-ID` needed for
   exact per-recipient threading.
5. "Plaintext" currently means plain-looking copy with both `text` and minimal
   HTML body populated. The send provider still sends an HTML part unless code
   is changed.
6. Create or update a draft first. Do not queue or send until the user approves
   the exact draft and recipient list.

Direct draft creation is acceptable when the UI is not enough, but keep it
minimal:

- Insert into `emails` with `status = 'draft'`.
- Add one `email_recipients` row for the list address, such as
  `cure51@props.sarva.co`, so the Composer can resolve the selected list.
- Do not insert `mail_queue` rows unless the user explicitly asked to queue and
  has approved the duplicate/recent-contact implications.

After creating a draft, verify:

- `emails.status = draft`
- the subject/from/reply-to/body are correct
- `email_recipients` contains the intended list address or individual recipients
- `mail_queue` has zero rows for that draft unless queueing was explicitly done

## Queueing and Sending

Queueing and sending are separate.

1. Queue creates `mail_queue` rows and normally holds them at
   `2999-12-31T23:59:59Z`.
2. Release/Send Now makes rows due and starts the monitor path.
3. Ordinary monitor use should drain only the scoped `emailId`; use the guarded
   global drain only for explicit repair/debug work.

Before queueing:

- Confirm exact draft id, subject, sender, reply-to, list id, and active member
  count.
- Warn if the app will raise duplicate/recent-send confirmations.
- Check exact global due/processing counts.

Before releasing/sending:

- Get explicit user approval naming the exact draft/campaign and recipient
  count.
- Confirm daily cap headroom.
- Confirm target queue rows are held/pending as expected.
- Open or run only the scoped monitor for that `emailId`.

After sending:

- Verify queue outcomes by exact counts.
- Check `email_send_report`.
- Check provider events, but do not overstate delivery if SES/SNS events are
  missing.
- Tell the user exactly what was sent, to how many recipients, and what remains
  pending/failed/dead/canceled.

## Troubleshooting "Why Didn't This Send?"

Start from the visible UI error, then inspect the server-side facts.

1. Identify whether the user clicked Save Draft, Send Test, Queue, Send Now, or
   Monitor.
2. If Composer shows "internal error" while queueing:
   - Save the draft first if needed.
   - Confirm the draft has a selected list or valid recipients.
   - Check active member count for the list.
   - Check duplicate/recent-contact warnings.
   - Check `error_logs` and any server route/action errors around the timestamp.
   - Check whether any `mail_queue` rows were partially inserted.
3. If Queue page Send Now failed:
   - Check held/due/processing rows for that `emailId`.
   - Check release confirmation requirements.
   - Check daily cap headroom.
4. If Monitor did not drain:
   - Confirm `/email/monitor?emailId=<uuid>` has the exact id.
   - Confirm `CRON_SECRET` is available in the deployed app.
   - Check `mail_queue.last_error`, stuck `processing`, and transient SES
     throttling.

Do not "fix" by using Gmail, by sending directly from a mail client, or by
running an unscoped/global queue drain without explicit repair/debug intent.

## User Communication

Keep the operator informed in concrete terms:

- Say what you are checking and whether it is read-only.
- Separate "drafted", "queued", "released", and "sent".
- For external side effects, ask for exact approval before the side effect.
- In the final response, include the draft/campaign id, app link, recipient
  count, and whether anything was actually sent.
