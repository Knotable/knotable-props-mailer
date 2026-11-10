-- Storage audit for the Props Mailer Supabase database.
-- Read-only. Paste into the Supabase SQL editor and run section by section.
-- Companion to docs/storage-rationalization.md and /email/storage.

-- 1. Total size, and how it splits between real data and everything else.
select pg_size_pretty(pg_database_size(current_database())) as database_size;

-- 2. Per-table: on-disk total vs live rows vs dead rows.
--    A table whose dead_rows or "bloat_estimate" is large is holding empty
--    pages that plain VACUUM will NOT return to the operating system.
select
  s.relname                                    as table_name,
  pg_size_pretty(pg_total_relation_size(s.relid)) as total,
  pg_size_pretty(pg_relation_size(s.relid))       as heap,
  pg_size_pretty(pg_indexes_size(s.relid))        as indexes,
  s.n_live_tup                                 as live_rows,
  s.n_dead_tup                                 as dead_rows,
  case when s.n_live_tup > 0
    then round(pg_relation_size(s.relid)::numeric / s.n_live_tup, 0)
    else null end                              as bytes_per_live_row,
  s.last_autovacuum,
  s.last_vacuum
from pg_stat_user_tables s
where s.schemaname = 'public'
order by pg_total_relation_size(s.relid) desc
limit 25;

-- 3. Per-index: size and how often it has ever been scanned.
--    scans = 0 on a large index is a drop candidate.
select
  s.relname     as table_name,
  s.indexrelname as index_name,
  pg_size_pretty(pg_relation_size(s.indexrelid)) as size,
  s.idx_scan    as scans,
  x.indisunique as is_unique,
  x.indisprimary as is_primary
from pg_stat_user_indexes s
join pg_index x on x.indexrelid = s.indexrelid
where s.schemaname = 'public'
order by pg_relation_size(s.indexrelid) desc
limit 30;

-- 4. The tables that grow with sending: how much is still live?
select 'mail_queue' as t, status, count(*) from public.mail_queue group by 2
union all
select 'provider_events', event_type, count(*) from public.provider_events group by 2
union all
select 'list_members', status, count(*) from public.list_members group by 2
union all
select 'error_logs', 'all', count(*) from public.error_logs
order by 1, 3 desc;

-- 5. Oldest rows in the event/log tables (retention candidates).
select
  (select min(received_at) from public.provider_events) as oldest_provider_event,
  (select max(received_at) from public.provider_events) as newest_provider_event,
  (select pg_size_pretty(sum(pg_column_size(payload))::bigint) from public.provider_events)
    as provider_events_payload_bytes;

-- 6. Campaigns that still hold queue rows but are finished — compaction candidates.
select
  e.id, e.subject, e.status,
  count(q.id) filter (where q.status in ('succeeded','failed','canceled','dead')) as terminal_rows,
  count(q.id) filter (where q.status in ('pending','processing','held'))          as unsent_rows,
  exists (select 1 from public.email_history_rollups r where r.email_id = e.id)   as has_rollup
from public.emails e
join public.mail_queue q on q.email_id = e.id
group by e.id, e.subject, e.status
having count(q.id) filter (where q.status in ('pending','processing','held')) = 0
order by terminal_rows desc;

-- 7. WAL / replication slots holding disk (rare, but free-tier-fatal when it happens).
select slot_name, active, pg_size_pretty(
         pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained_wal
from pg_replication_slots;
