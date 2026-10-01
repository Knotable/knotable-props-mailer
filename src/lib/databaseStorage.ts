// Database storage diagnostics for the Storage page. The numbers come from the
// service-role-only RPC `get_database_storage_stats()` (migration
// 20260930_database_storage_stats.sql); everything else here is pure so the
// projection can be tested without a database.

export type TableStorage = {
  name: string;
  total_bytes: number;
  heap_bytes: number;
  index_bytes: number;
  live_rows: number;
  dead_rows: number;
  last_autovacuum: string | null;
};

export type IndexStorage = {
  table_name: string;
  name: string;
  bytes: number;
  scans: number;
  is_unique: boolean;
  is_primary: boolean;
};

export type StorageStats = {
  database_bytes: number;
  // Reported by the function once the delivery-ledger migration is applied.
  ledger_installed?: boolean;
  tables: TableStorage[];
  indexes: IndexStorage[];
};

export const FREE_TIER_LIMIT_BYTES = 500 * 1024 * 1024;

// Measured on a 200k-recipient campaign against Postgres 16 with this repo's
// schema and migrations (2026-09-30):
//   mail_queue: 145 MB after queueing (~725 B/row); 417 MB after the send when
//   nothing vacuumed in between (every row is rewritten twice, each rewrite leaves
//   a dead copy and index entries); 174 MB with a VACUUM every 5,000 accepted.
//   email_deliveries (hot per-recipient ledger): 23 MB (~115 B/recipient).
//   email_delivery_archive (after compaction): 1.75 MB (~9 B/recipient).
// The defaults below are used until the live tables hold enough rows to measure.
const DEFAULT_QUEUE_BYTES_PER_ROW = 725;
const DEFAULT_EVENT_BYTES_PER_ROW = 550;
const MIN_ROWS_TO_MEASURE = 1_000;
export const QUEUE_PEAK_FACTOR_NO_VACUUM = 2.9;
export const QUEUE_PEAK_FACTOR_VACUUMED = 1.2;
export const LEDGER_BYTES_PER_RECIPIENT = 115;
export const ARCHIVE_BYTES_PER_RECIPIENT = 9;
// Without the ledger, delivered + opened are stored as rows for every recipient.
export const LEGACY_EVENTS_PER_RECIPIENT = 2;
// With it only bounces, complaints and clicks keep rows.
export const LEDGER_EVENT_ROWS_PER_RECIPIENT = 0.03;

export function getDatabaseLimitBytes(env: Record<string, string | undefined> = process.env): number {
  const mb = Number(env.SUPABASE_DB_LIMIT_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : FREE_TIER_LIMIT_BYTES;
}

export function isStorageStats(value: unknown): value is StorageStats {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.database_bytes === "number" &&
    Array.isArray(record.tables) &&
    Array.isArray(record.indexes)
  );
}

function bytesPerRow(table: TableStorage | undefined, fallback: number): { value: number; measured: boolean } {
  if (table && table.live_rows >= MIN_ROWS_TO_MEASURE && table.total_bytes > 0) {
    return { value: Math.round(table.total_bytes / table.live_rows), measured: true };
  }
  return { value: fallback, measured: false };
}

export type SendProjection = {
  recipients: number;
  queueBytesPerRow: number;
  eventBytesPerRow: number;
  measured: boolean;
  // True once the delivery-ledger migration is applied (the tables exist).
  ledger: boolean;
  limitBytes: number;
  // Worst-case size while the campaign is in flight, before it is compacted.
  peakBytes: number;
  peakBytesVacuumed: number;
  percentOfLimit: number;
  percentOfLimitVacuumed: number;
  level: "ok" | "tight" | "over";
  levelVacuumed: "ok" | "tight" | "over";
  // What the campaign costs to keep afterwards.
  permanentBytes: number;
};

function levelFor(percent: number): "ok" | "tight" | "over" {
  return percent >= 100 ? "over" : percent >= 85 ? "tight" : "ok";
}

export function hasDeliveryLedger(stats: StorageStats): boolean {
  if (typeof stats.ledger_installed === "boolean") return stats.ledger_installed;
  return stats.tables.some((table) => table.name === "email_deliveries" || table.name === "email_delivery_archive");
}

// Size while `recipients` are in flight (rows still in the database, i.e. before
// compaction), with and without the worker's in-send VACUUM, plus what is kept
// permanently afterwards.
export function projectSend(stats: StorageStats, recipients: number, limitBytes = getDatabaseLimitBytes()): SendProjection {
  const queue = bytesPerRow(stats.tables.find((table) => table.name === "mail_queue"), DEFAULT_QUEUE_BYTES_PER_ROW);
  const events = bytesPerRow(stats.tables.find((table) => table.name === "provider_events"), DEFAULT_EVENT_BYTES_PER_ROW);
  const ledger = hasDeliveryLedger(stats);
  const count = Math.max(0, Math.floor(recipients));
  const eventBytes = count * events.value * (ledger ? LEDGER_EVENT_ROWS_PER_RECIPIENT : LEGACY_EVENTS_PER_RECIPIENT);
  const ledgerBytes = ledger ? count * LEDGER_BYTES_PER_RECIPIENT : 0;
  const peak = (factor: number) => Math.round(stats.database_bytes + count * queue.value * factor + eventBytes + ledgerBytes);
  const peakBytes = peak(QUEUE_PEAK_FACTOR_NO_VACUUM);
  const peakBytesVacuumed = peak(QUEUE_PEAK_FACTOR_VACUUMED);
  const percentOfLimit = (peakBytes / limitBytes) * 100;
  const percentOfLimitVacuumed = (peakBytesVacuumed / limitBytes) * 100;
  return {
    recipients: count,
    queueBytesPerRow: queue.value,
    eventBytesPerRow: events.value,
    measured: queue.measured && events.measured,
    ledger,
    limitBytes,
    peakBytes,
    peakBytesVacuumed,
    percentOfLimit,
    percentOfLimitVacuumed,
    level: levelFor(percentOfLimit),
    levelVacuumed: levelFor(percentOfLimitVacuumed),
    permanentBytes: ledger
      ? Math.round(count * ARCHIVE_BYTES_PER_RECIPIENT)
      : Math.round(count * (queue.value + LEGACY_EVENTS_PER_RECIPIENT * events.value)),
  };
}

// Indexes the database has never used since statistics were last reset.
// Unique and primary-key indexes are excluded: they enforce constraints even
// though they are rarely scanned. Treat this as a shortlist to audit against
// the code, not a drop list.
export function unusedIndexes(stats: StorageStats): IndexStorage[] {
  return stats.indexes.filter((index) => index.scans === 0 && !index.is_unique && !index.is_primary);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${Math.round(bytes)} B`;
  if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (abs < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(abs < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
