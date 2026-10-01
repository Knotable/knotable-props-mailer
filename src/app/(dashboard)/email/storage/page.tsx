import { connection } from "next/server";
import { requireServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  formatBytes,
  getDatabaseLimitBytes,
  isStorageStats,
  projectSend,
  unusedIndexes,
  type StorageStats,
} from "@/lib/databaseStorage";

type StoragePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const DIAGNOSTIC_SQL = `select relname, pg_size_pretty(pg_total_relation_size(relid)) total,
       pg_size_pretty(pg_relation_size(relid)) heap,
       pg_size_pretty(pg_indexes_size(relid)) indexes, n_live_tup, n_dead_tup
from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 12;`;

async function loadStats(): Promise<{ stats: StorageStats | null; problem: string | null }> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("get_database_storage_stats" as never);
    if (error) {
      const missing = error.code === "42883" || error.code === "PGRST202" || /could not find|does not exist/i.test(error.message ?? "");
      return {
        stats: null,
        problem: missing
          ? "The storage function is not installed yet. Apply supabase/migrations/20260930_database_storage_stats.sql (Supabase → SQL editor), then reload."
          : `The database did not return storage statistics (${error.code ?? "error"}: ${error.message}).`,
      };
    }
    if (!isStorageStats(data)) return { stats: null, problem: "The storage function returned an unexpected shape." };
    return { stats: data, problem: null };
  } catch (err) {
    return { stats: null, problem: err instanceof Error ? err.message : String(err) };
  }
}

const levelStyles = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  tight: "border-amber-300 bg-amber-50 text-amber-900",
  over: "border-red-300 bg-red-50 text-red-900",
} as const;

const levelText = {
  ok: "Fits with room to spare.",
  tight: "Fits, but with little margin.",
  over: "Would exceed the limit.",
} as const;

export default async function StoragePage({ searchParams }: StoragePageProps) {
  await connection();
  await requireServerAuthContext();
  const params = (await searchParams) ?? {};
  const requested = Number(String(params.recipients ?? "").replace(/,/g, ""));
  const recipients = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 185_000;

  const { stats, problem } = await loadStats();
  const limit = getDatabaseLimitBytes();

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Admin</p>
        <h2 className="text-2xl font-semibold text-slate-900">Database storage</h2>
        <p className="text-sm text-slate-500">
          How much of the database a large send would use, and where the space goes. Read-only; nothing here changes data.
        </p>
      </header>

      {problem || !stats ? (
        <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">{problem}</p>
          <p>Until then, this query in the Supabase SQL editor gives the same table sizes:</p>
          <pre className="overflow-x-auto rounded bg-white p-3 text-xs text-slate-700">{DIAGNOSTIC_SQL}</pre>
        </section>
      ) : (
        <StorageDetails stats={stats} limit={limit} recipients={recipients} />
      )}
    </div>
  );
}

function StorageDetails({ stats, limit, recipients }: { stats: StorageStats; limit: number; recipients: number }) {
  const projection = projectSend(stats, recipients, limit);
  const usedPercent = (stats.database_bytes / limit) * 100;
  const unused = unusedIndexes(stats);

  return (
    <>
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Database now</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{formatBytes(stats.database_bytes)}</p>
          <p className="text-xs text-slate-500">
            {usedPercent.toFixed(0)}% of the {formatBytes(limit)} limit (set SUPABASE_DB_LIMIT_MB if the plan changes)
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Free space</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{formatBytes(Math.max(0, limit - stats.database_bytes))}</p>
          <p className="text-xs text-slate-500">Past the limit the database turns read-only and sends stop.</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Cost per recipient</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            {formatBytes(projection.queueBytesPerRow + 2 * projection.eventBytesPerRow)}
          </p>
          <p className="text-xs text-slate-500">
            queue row {formatBytes(projection.queueBytesPerRow)} + 2 events {formatBytes(2 * projection.eventBytesPerRow)}
            {projection.measured ? " (measured)" : " (estimate: tables too small to measure)"}
          </p>
        </div>
      </section>

      <section className={`space-y-3 rounded-lg border p-4 ${levelStyles[projection.levelVacuumed]}`}>
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="space-y-1">
            <span className="block text-xs uppercase tracking-wide opacity-70">What if I send to</span>
            <input
              name="recipients"
              defaultValue={recipients}
              inputMode="numeric"
              className="w-32 rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900"
            />
          </label>
          <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">
            Project
          </button>
        </form>
        <p className="text-sm font-medium">
          Peak while {recipients.toLocaleString()} recipients are in flight: {formatBytes(projection.peakBytesVacuumed)} (
          {projection.percentOfLimitVacuumed.toFixed(0)}% of the limit) with the worker&apos;s in-send cleanup.{" "}
          {levelText[projection.levelVacuumed]}
        </p>
        <p className={`rounded-md border px-3 py-2 text-xs ${levelStyles[projection.level]}`}>
          Without that cleanup (the worker needs the <code>SUPABASE_DB_CONNECTION</code> secret to run it): {formatBytes(projection.peakBytes)} (
          {projection.percentOfLimit.toFixed(0)}%). {levelText[projection.level]}
        </p>
        <p className="text-xs opacity-80">
          Each queue row is rewritten twice while it sends, and every rewrite leaves a dead copy behind until the database cleans up.
          Measured on 200k recipients that grew the queue table from 145 MB to 417 MB uncleaned, versus 174 MB with cleanup every 5,000 sends.
          {projection.ledger
            ? " Delivered/opened events are recorded as flags on a small per-recipient ledger instead of event rows."
            : " The delivery-ledger migration (20260930_delivery_ledger.sql) is not applied yet, so every recipient also produces about two event rows."}
        </p>
        <p className="text-sm">
          <span className="font-medium">Kept afterwards: {formatBytes(projection.permanentBytes)}.</span>{" "}
          <span className="text-xs opacity-80">
            {projection.ledger
              ? "A day after the results report, the finished campaign is folded into about 9 bytes per recipient and its queue rows are deleted."
              : "Until the ledger migration is applied, finished campaigns stay in the database at full size."}
          </span>
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Tables</h3>
        <div className="overflow-x-auto">
          <table className="w-full table-auto text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2">Table</th>
                <th className="pb-2 text-right">Total</th>
                <th className="pb-2 text-right">Data</th>
                <th className="pb-2 text-right">Indexes</th>
                <th className="pb-2 text-right">Live rows</th>
                <th className="pb-2 text-right">Dead rows</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stats.tables.map((table) => (
                <tr key={table.name}>
                  <td className="py-2 font-medium text-slate-800">{table.name}</td>
                  <td className="py-2 text-right tabular-nums">{formatBytes(table.total_bytes)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-500">{formatBytes(table.heap_bytes)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-500">{formatBytes(table.index_bytes)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-500">{table.live_rows.toLocaleString()}</td>
                  <td className="py-2 text-right tabular-nums text-slate-500">{table.dead_rows.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          Dead rows are old copies left behind by updates; a large number means the table is bloated until vacuum catches up.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Largest indexes</h3>
        <div className="overflow-x-auto">
          <table className="w-full table-auto text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2">Index</th>
                <th className="pb-2">Table</th>
                <th className="pb-2 text-right">Size</th>
                <th className="pb-2 text-right">Times used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stats.indexes.map((index) => (
                <tr key={`${index.table_name}.${index.name}`}>
                  <td className="py-2 font-medium text-slate-800">
                    {index.name}
                    {index.is_primary ? <span className="ml-2 text-xs text-slate-400">primary key</span> : null}
                    {index.is_unique && !index.is_primary ? <span className="ml-2 text-xs text-slate-400">unique</span> : null}
                  </td>
                  <td className="py-2 text-slate-500">{index.table_name}</td>
                  <td className="py-2 text-right tabular-nums">{formatBytes(index.bytes)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-500">{index.scans.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {unused.length ? (
          <p className="text-xs text-amber-800">
            {unused.length} non-unique {unused.length === 1 ? "index was" : "indexes were"} never used since statistics were last reset (
            {unused.map((index) => index.name).join(", ")}). These are candidates to drop, but check the code for queries that
            use them first; the counters restart after a database restart.
          </p>
        ) : (
          <p className="text-xs text-slate-500">Every non-unique index among the largest 30 has been used.</p>
        )}
      </section>
    </>
  );
}
