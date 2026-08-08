# SES bulk worker

## Where it runs

The bulk worker runs as one manually dispatched GitHub Actions job. Vercel still
hosts the Props Mailer UI, readiness pages, tracking pixel, and SES/SNS webhook,
but no Vercel request remains open while a campaign drains. The legacy Vercel
worker workflow is manual-only so it cannot race the bulk worker.

One Actions run can remain active for up to the workflow's two-hour timeout. At
the current SES limit of 15 recipients/second, a 12,000-recipient campaign should
take roughly 15 minutes plus API and checkpoint overhead.

## What “bulk” means

The worker uses the SES v2 `SendBulkEmail` API. Each request contains up to 50
separate destination objects, capped further at 90% of the live SES per-second
quota. Every destination remains a private, personalized message with its own SES
message id and open-tracking queue id.

Supabase receives three index-friendly bounded operations per 50-recipient
claim: select 50 pending IDs through the campaign/status/created-at index,
conditionally mark those IDs processing, and checkpoint the result set. GitHub
concurrency permits only one bulk worker per campaign, and the conditional
transition fails closed if anything races it. SES calls inside the claim remain
split and paced to 90% of the live per-second quota (normally 13 recipients per
request). This keeps the SES rate unchanged and avoids the expensive held/due
OR-and-sort plan in the general-purpose SQL claim RPC.

## Required GitHub configuration

Repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

Repository variables:

- `AWS_REGION` (the SES region, currently expected to match the SMTP region)
- `AWS_SES_CONFIGURATION_SET` (the set that publishes Send, Delivery, Bounce,
  Complaint, Open, Click, and Rendering Failure events)

The AWS IAM identity needs `ses:GetAccount` and `ses:SendBulkEmail`, restricted to
the intended SES region and identities where practical. SES SMTP credentials are
not AWS API credentials and cannot be reused for this worker.

Apply `supabase/migrations/20260808_ses_bulk_worker.sql` before the first run.

## Safe operating sequence

1. Open GitHub Actions → **SES Bulk Worker** → **Run workflow**.
2. Enter the exact campaign UUID and choose `dry-run`. Leave confirmation blank.
3. Review the logged subject, status, due/held/processing/succeeded counts, and
   confirm that the dry run made no changes.
4. Run it again with mode `send` and confirmation `send:<campaign UUID>` only
   after the recipient count and SES quota are approved.
5. Do not launch the legacy Vercel worker for the same campaign.

The send mode refuses to start if any row is already `processing`, which prevents
automatic duplicate retries after an ambiguous network failure. Each SES
destination is tagged with `queue_id`; the SNS Send event can repair the narrow
case where SES accepted a message before the Actions job checkpointed it.

If a run stops with processing rows, do not blindly retry it. Wait for SES/SNS
Send events, inspect the affected queue ids and message ids, reconcile any
remaining ambiguous rows, and then launch another campaign-scoped run.
