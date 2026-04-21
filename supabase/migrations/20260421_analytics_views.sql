-- Aggregate views for analytics and past-sends pages.
--
-- Without these views both pages fetch every mail_queue row into Node memory
-- and aggregate in JavaScript.  At 45k sends/day the table grows by ~315k rows
-- per week; those pages would time out within days.
--
-- After applying this migration the pages use DB-level GROUP BY instead,
-- returning one row per campaign / one row per email regardless of list size.

-- ── Per-campaign delivery stats ────────────────────────────────────────────────
-- Used by the Analytics page campaign table.
CREATE OR REPLACE VIEW public.campaign_stats AS
SELECT
  campaign_label,
  email_id,
  list_id,
  COUNT(*)          FILTER (WHERE status = 'succeeded')                 AS sent,
  COUNT(*)          FILTER (WHERE status IN ('failed', 'dead'))         AS failed,
  COUNT(*)          FILTER (WHERE status IN ('pending', 'processing'))  AS pending,
  MIN(created_at)                                                       AS started_at
FROM public.mail_queue
WHERE campaign_label IS NOT NULL
GROUP BY campaign_label, email_id, list_id;

-- ── Per-email delivery stats ───────────────────────────────────────────────────
-- Used by the Past Sends page.  One row per email draft that has queue rows.
CREATE OR REPLACE VIEW public.email_send_stats AS
SELECT
  email_id,
  -- collect distinct list_ids as an array (filters out NULLs automatically)
  ARRAY_AGG(DISTINCT list_id) FILTER (WHERE list_id IS NOT NULL)       AS list_ids,
  COUNT(*)          FILTER (WHERE status = 'succeeded')                 AS sent,
  COUNT(*)          FILTER (WHERE status IN ('failed', 'dead'))         AS failed,
  COUNT(*)          FILTER (WHERE status IN ('pending', 'processing'))  AS pending,
  MIN(send_date)    FILTER (WHERE status = 'succeeded')                 AS first_sent,
  MAX(created_at)                                                       AS last_queued_at
FROM public.mail_queue
WHERE email_id IS NOT NULL
GROUP BY email_id;

-- Grant read access to all Supabase roles (RLS is handled at the table level;
-- views surface only aggregates so no row-level data is exposed).
GRANT SELECT ON public.campaign_stats   TO anon, authenticated, service_role;
GRANT SELECT ON public.email_send_stats TO anon, authenticated, service_role;

-- ── Supporting indexes ─────────────────────────────────────────────────────────
-- Speeds up:
--   • Both views (GROUP BY email_id / campaign_label with status filter)
--   • Duplicate-detection COUNT in queueCampaignAction
--   • Recent-contact COUNT in queueCampaignAction
CREATE INDEX IF NOT EXISTS mail_queue_email_list_status
  ON public.mail_queue (email_id, list_id, status);

CREATE INDEX IF NOT EXISTS mail_queue_list_status_created
  ON public.mail_queue (list_id, status, created_at DESC)
  WHERE list_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mail_queue_campaign_label_status
  ON public.mail_queue (campaign_label, status)
  WHERE campaign_label IS NOT NULL;
