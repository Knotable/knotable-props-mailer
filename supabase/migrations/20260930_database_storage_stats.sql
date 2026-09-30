-- Read-only storage diagnostics for the app's Storage page (/email/storage).
-- PostgREST cannot read pg_stat_* views directly, so this exposes exactly the
-- numbers needed to decide what to trim before a large send: database size,
-- per-table heap/index/dead-row sizes, and per-index size with scan counts
-- (an index that is never scanned is a candidate to drop).
-- Service-role only; no row data is returned.

create or replace function public.get_database_storage_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'tables', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.total_bytes desc)
      from (
        select
          s.relname as name,
          pg_total_relation_size(s.relid) as total_bytes,
          pg_relation_size(s.relid) as heap_bytes,
          pg_indexes_size(s.relid) as index_bytes,
          s.n_live_tup as live_rows,
          s.n_dead_tup as dead_rows,
          s.last_autovacuum as last_autovacuum
        from pg_stat_user_tables s
        where s.schemaname = 'public'
        order by pg_total_relation_size(s.relid) desc
        limit 20
      ) t
    ), '[]'::jsonb),
    'indexes', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.bytes desc)
      from (
        select
          s.relname as table_name,
          s.indexrelname as name,
          pg_relation_size(s.indexrelid) as bytes,
          s.idx_scan as scans,
          x.indisunique as is_unique,
          x.indisprimary as is_primary
        from pg_stat_user_indexes s
        join pg_index x on x.indexrelid = s.indexrelid
        where s.schemaname = 'public'
        order by pg_relation_size(s.indexrelid) desc
        limit 30
      ) i
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_database_storage_stats() from public, anon, authenticated;
grant execute on function public.get_database_storage_stats() to service_role;
