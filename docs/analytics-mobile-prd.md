# Analytics Reliability + iPhone Mode PRD

Status: In progress
Owner: Amol / Props Mailer
Created: 2026-07-02

## Context

Props Mailer is used for high-volume newsletter sends where the operator needs to answer three questions quickly:

1. Did SES accept the campaign?
2. Are provider events fresh enough to trust?
3. What should I do next from my phone?

Mailchimp's own reporting model separates campaign reports, mobile analytics, and provider caveats. Their documentation emphasizes campaign reports with opens, clicks, delivery, bounces, and e-commerce context; mobile reports expose analytics from a dedicated tab; and their help docs warn that bot activity can inflate opens/clicks. Review sites and user comments consistently praise ease of use and real-time analytics, while complaints cluster around price, account/support friction, customization limits, and occasional analytics/reporting delays.

Reference inputs:

- Mailchimp email reports: https://mailchimp.com/help/about-email-campaign-reports/
- Mailchimp mobile reports: https://mailchimp.com/help/view-reports-mobile/
- Mailchimp reports and analytics product page: https://mailchimp.com/features/reports-and-analytics/
- Capterra Mailchimp review summary: https://www.capterra.com/p/110228/MailChimp/
- G2 Mailchimp review summary: https://www.g2.com/products/intuit-mailchimp-all-in-one-marketing-platform/reviews
- Apple App Store Mailchimp app listing: https://apps.apple.com/us/app/mailchimp-email-marketing/id366794783
- Reddit Mailchimp reporting delay thread: https://www.reddit.com/r/MailChimp/comments/1r2z0wn/analytics_reporting_delays/

## Goals

- Make Analytics exact for the recent campaign set, not sampled.
- Make confidence visible: queue-side truth, provider-side truth, and freshness must be obvious.
- Make `/email/analytics` usable on an iPhone without sideways scrolling.
- Make the app shell usable one-handed with bottom navigation on mobile.
- Keep send safety intact. Analytics improvements must not queue, release, send, or drain mail.

## Non-Goals

- No Mailchimp clone.
- No Gmail sending or Gmail connector usage.
- No automated cron worker.
- No production send or queue mutation as part of this work.
- No schema-type regeneration until the broader Supabase type drift task is handled.

## User Stories

- As an operator on iPhone, I can open Analytics and see recent campaign health in cards without pinching or rotating.
- As an operator, I can distinguish SES accepted, delivered, opened, clicked, bounced, complained, failed, pending, and canceled.
- As an operator, I can see when analytics is in fallback mode because the DB migration is missing.
- As an operator, I can navigate between Composer, Queue, Sends, Monitor, Analytics, Lists, Account, and Users from the bottom of the screen.
- As an operator, I can trust that large campaign rows are not silently capped by a page-level sample limit.

## Requirements

- Analytics data source:
  - Add `get_recent_email_analytics_stats(p_limit, p_offset)` in Supabase.
  - Page from `emails` first.
  - Count queue outcomes with indexed `mail_queue.email_id/status` lookups.
  - Count provider outcomes with indexed `provider_events.email_id/event_type` lookups.
  - Return `delivered`, `bounced`, `complained`, `opened`, `clicked`, `latest_event_at`, and queue outcome counts.

- Analytics UI:
  - Keep desktop table for dense scanning.
  - Add mobile campaign cards under `md`.
  - Show a confidence panel for queue truth, provider truth, and exact-vs-fallback campaign rows.
  - Include open/click/bounce rates on mobile cards.
  - Preserve the daily send-cap form.

- Mobile shell:
  - Keep desktop nav at the top.
  - Add fixed bottom nav on mobile with safe-area padding.
  - Add enough page bottom padding that content is not hidden by the bottom nav.
  - Keep active route state visible.

## Task List

- Done: Create this PRD and source-backed requirement summary.
- Done: Add `20260702_recent_analytics_rpc.sql`.
- Done: Add canonical `schema.sql` entries for the analytics RPC and supporting indexes.
- Done: Update `/email/analytics` to use exact recent campaign analytics when available.
- Done: Add mobile cards for campaign analytics.
- Done: Add mobile bottom navigation in the app shell.
- Pending: Apply the new migration to production Supabase.
- Pending: Verify `/email/analytics` against a known large campaign after migration.
- Pending: Add per-campaign detail drilldown for exact recipient/event samples.
- Pending: Add bot/filter caveats once SES event payload analysis identifies reliable bot signals.
- Pending: Regenerate `src/supabase/types.ts` after the schema drift task is handled.

## Acceptance Criteria

- On iPhone-width screens, Analytics shows card rows and no campaign table horizontal scrolling.
- On desktop, Analytics still shows a dense table.
- If `get_recent_email_analytics_stats` is missing, Analytics renders a clear migration warning instead of failing.
- New SQL can be applied independently and is read-only except for function/index DDL.
- No mail is queued, released, sent, canceled, or drained by this work.
