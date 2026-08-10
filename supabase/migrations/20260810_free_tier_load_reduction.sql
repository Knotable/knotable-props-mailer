-- Free-tier load reduction (2026-08-10)
--
-- 1. Enforce provider_events dedupe with a partial unique index so the SES
--    webhook can drop its per-event pre-select. Open/Click events are excluded
--    on purpose: repeated opens/clicks are engagement data and keep one row
--    per occurrence.
-- 2. Purge accumulated background rows (DB-backed rate-limiter sentinels in
--    error_logs, no-op queue_metrics rows) that only ever grew.
-- 3. Schedule a daily pg_cron cleanup so these tables stay bounded.

-- ── 1. provider_events dedupe index ─────────────────────────────────────────

-- Remove existing duplicates first (keep the earliest row per pair) so the
-- unique index can build.
delete from public.provider_events pe
using public.provider_events dup
where pe.message_id is not null
  and pe.event_type not in ('opened', 'clicked')
  and dup.message_id = pe.message_id
  and dup.event_type = pe.event_type
  and dup.id < pe.id;

create unique index if not exists provider_events_message_event_unique_idx
  on public.provider_events (message_id, event_type)
  where message_id is not null and event_type not in ('opened', 'clicked');

-- ── 2. One-time purge of accumulated background rows ────────────────────────

-- Rate-limiter sentinel rows: the webhook now uses an in-memory limiter, so
-- these no longer accumulate; clear the backlog.
delete from public.error_logs
where source like 'rate_limit:%';

-- queue_metrics rows recorded by idle monitor polls (no work processed).
delete from public.queue_metrics
where processed_count = 0
  and failed_count = 0;

-- ── 3. Recurring cleanup via pg_cron ────────────────────────────────────────

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable, skipping scheduled cleanup: %', sqlerrm;
  end;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'props_mailer_cleanup') then
      perform cron.unschedule('props_mailer_cleanup');
    end if;

    perform cron.schedule(
      'props_mailer_cleanup',
      '17 3 * * *',
      $job$
        delete from public.error_logs
        where source like 'rate_limit:%'
          and created_at < now() - interval '1 day';
        delete from public.error_logs
        where source = 'auth'
          and created_at < now() - interval '30 days';
        delete from public.queue_metrics
        where processed_count = 0
          and failed_count = 0;
      $job$
    );
  end if;
end
$$;
