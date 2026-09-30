-- mail_queue has accumulated 19 indexes across migrations, and every insert and
-- every row rewrite (claim, finalize) pays for each of them. These three are
-- strict prefixes of another index on the same table, so any query that could
-- use them can use the larger index instead; dropping them cannot slow a query.
--
--   mail_queue_campaign_label_idx   (campaign_label)
--     covered by mail_queue_campaign_label_status (campaign_label, status)
--   mail_queue_list_id_idx          (list_id)
--     covered by mail_queue_list_status_created (list_id, status, created_at desc)
--     (partial on list_id is not null, which every list_id = <value> filter implies)
--   mail_queue_email_list_idx       (email_id, list_id) where email_id/list_id not null
--     covered by mail_queue_email_list_status (email_id, list_id, status)
--
-- Indexes that merely look unused were deliberately left alone: the Storage page
-- (/email/storage) shows how often each one is scanned, which is the evidence to
-- use before dropping anything else. Apply between sends (DROP INDEX briefly
-- locks the table).

drop index if exists public.mail_queue_campaign_label_idx;
drop index if exists public.mail_queue_list_id_idx;
drop index if exists public.mail_queue_email_list_idx;
