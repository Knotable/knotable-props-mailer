# Automatic audience sequences

Queue each audience as a separate campaign, review the content and count, then
approve the first campaign. For the next campaign, expand **Send to N**, select
**Send after**, and optionally enter hours to wait after the first completes.
Confirm its exact count. Repeat for any later stage. All stages are approved
up front; the browser can close. No new service, subscription, schema migration,
or per-recipient dependency rows are needed.

The worker and scheduled probe enforce the dependency. A stage binds the exact
predecessor `approvalId` plus its campaign id. It cannot run until that approval
is `complete` with a valid `completedAt`, and the completion-relative delay has
elapsed. Any absolute start time and send window also apply. SES quota waits,
retry backoff and worker restarts preserve the dependency. Zero-delay successors
can start in the same worker invocation. Tests cover a three-stage sequence,
12-hour restart, canceled/paused/blocked/deleted/replaced predecessors, permission
and count errors, and cycles.

Pausing, blocking, deleting or re-approving an earlier stage stops its successors
for review. The operator receives the existing blocked-campaign email. Re-approve
the successor against the intended current predecessor after resolving the issue.
Pausing a successor preserves its queue and its previous selection in the form.
`complete` means the queue drained to terminal outcomes, not that every recipient
received an inbox delivery. Permanent failures and suppressions remain in totals.

The `/ai` send action supports `after_campaign_id`, `after_approval_id`, and
`after_delay_minutes` (0–86400). Its ordinary exact-count confirmation and content
digest still apply. Queue preparation alone does not approve sending. Existing
prepared campaigns are never promoted by deployment.

The cloud worker uses GitHub Actions. Scheduled starts target five-minute ticks,
but GitHub can delay or drop scheduled runs; this is not a start-time SLA. An
optional repository-scoped Actions dispatch token in Vercel starts approved work
without waiting for cron. App dispatches drain all approved campaigns, allowing
successors to follow immediately. Neither path needs an open tab or an AI chat.
No broad personal token should be copied into app configuration.

Finished-campaign compaction now wakes the worker even if no new send or report
is due. The probe honors `SES_COMPACT_HISTORY` and `SES_COMPACT_AFTER_HOURS`, so
cleanup no longer depends on someone returning to send another campaign.
