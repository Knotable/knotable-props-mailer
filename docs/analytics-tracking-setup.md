# Analytics and Tracking Setup

Props Mailer has two engagement data sources and one delivery source. Do not
collapse them into a single raw event count.

## What the app already does

- `mail_queue.status = succeeded` means SES accepted the SMTP submission.
- SES/SNS events provide delivery, bounce, complaint, open, and click events.
- The queue worker also adds a per-recipient Props open pixel at
  `/api/email/open/<queue-id>` as an independent open signal.
- Campaign analytics deduplicate recipients across the SES and Props open
  sources. Raw event totals are shown separately as repeat activity.

Adding another pixel would not improve measurement. It would add a third noisy
open source. The useful upgrade is to make SES event publishing complete and to
prefer clicks, replies, and downstream conversions over opens.

## Required application setup

1. Apply these Supabase migrations:
   - `20260702_recent_analytics_rpc.sql`
   - `20260714_campaign_analytics_detail.sql`
2. Set `AWS_SES_CONFIGURATION_SET` in Vercel to the exact SES configuration-set name.
3. Set `AWS_SES_SNS_TOPIC_ARN` in Vercel to the SNS topic ARN.
4. Confirm `NEXT_PUBLIC_APP_URL` points to the production Props Mailer origin so
   the built-in Props pixel uses a public HTTPS URL.
5. Open `/api/health` after deployment and confirm the SES/SNS freshness check is green.

## Required AWS SES setup

In the same AWS Region as the SMTP endpoint:

1. SES → Configuration sets → open the set named in `AWS_SES_CONFIGURATION_SET`.
2. Add an SNS event destination.
3. Enable: Send, Delivery, DeliveryDelay, Bounce, Complaint, Reject, Rendering
   Failure, Open, and Click when available.
4. SNS → subscribe the topic to:
   `https://knotable-props-mailer.vercel.app/api/webhooks/ses`
5. Confirm the HTTPS subscription. The webhook handles the SNS confirmation.
6. Send a test through Props Mailer, open it, and click a real link.
7. Verify the campaign page shows an SES message ID, a delivered event, an SES
   open, and a click. A Props pixel open may also appear.

SES inserts its own open pixel and rewrites links when Open/Click event
publishing is enabled for the configuration set. The app's SMTP provider already
sends the `X-SES-CONFIGURATION-SET` header.

## Recommended tracking-domain setup

SES can use AWS-owned tracking URLs without additional work. For a cleaner
recipient experience and more consistent branding, configure a dedicated HTTPS
tracking subdomain in the SES configuration set, for example
`track.props.sarva.co`.

This requires a verified SES subdomain, DNS, TLS, and usually CloudFront in
front of the regional SES tracking domain. Set the SES HTTPS policy to
`REQUIRE`. This is optional and does not change the meaning of the metrics.

## Metric definitions

- **SES accepted:** queue rows successfully submitted to SES over SMTP.
- **Delivered:** unique recipients with an SES Delivery event. This confirms
  receipt by the destination mail server, not inbox placement.
- **Opened:** unique recipients with at least one SES or Props open event.
- **Open events:** every recorded pixel load, including repeats and privacy
  preloading. Never present this as unique people.
- **Clicked:** unique recipients with at least one SES Click event.
- **Click events:** every recorded click event, including repeat clicks.
- **Bounce/complaint:** unique affected recipients from SES provider events.

## Interpretation rules

- Prefer clicks over opens when judging engagement.
- Treat opens as directional. Images can be blocked, cached, or downloaded in
  the background by privacy features.
- Never call `succeeded` “delivered.” It means SES accepted the submission.
- A missing provider event can mean missing AWS configuration, delayed event
  delivery, or a correlation issue—not necessarily a delivery failure.
- For important outcomes, add first-party conversion events at the destination
  site with campaign and recipient-safe attribution. Email pixels cannot measure
  what happened after the click.

