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
  tables: TableStorage[];
  indexes: IndexStorage[];
};

export const FREE_TIER_LIMIT_BYTES = 500 * 1024 * 1024;

// Used until the tables hold enough rows to measure. Queue rows carry ~11
// indexes; events carry a recipient, ids and four indexes.
const DEFAULT_QUEUE_BYTES_PER_ROW = 1_000;
const DEFAULT_EVENT_BYTES_PER_ROW = 550;
const MIN_ROWS_TO_MEASURE = 1_000;
// Each queue row is rewritten ~3 times (release, claim, success) and every
// rewrite copies the row and its index entries until vacuum reclaims them.
export const QUEUE_PEAK_FACTOR = 2;
// delivered + opened, the two events every recipient produces.
export const EVENTS_PER_RECIPIENT = 2;

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
  queueBytes: number;
  eventBytes: number;
  peakBytes: number;
  limitBytes: number;
  headroomBytes: number;
  percentOfLimit: number;
  level: "ok" | "tight" | "over";
};

// Worst-case size while a campaign of `recipients` is in flight, assuming its
// rows and events are still in the database (i.e. before archive-and-purge).
export function projectSend(stats: StorageStats, recipients: number, limitBytes = getDatabaseLimitBytes()): SendProjection {
  const queue = bytesPerRow(stats.tables.find((table) => table.name === "mail_queue"), DEFAULT_QUEUE_BYTES_PER_ROW);
  const events = bytesPerRow(stats.tables.find((table) => table.name === "provider_events"), DEFAULT_EVENT_BYTES_PER_ROW);
  const count = Math.max(0, Math.floor(recipients));
  const queueBytes = Math.round(count * queue.value * QUEUE_PEAK_FACTOR);
  const eventBytes = Math.round(count * events.value * EVENTS_PER_RECIPIENT);
  const peakBytes = stats.database_bytes + queueBytes + eventBytes;
  const percentOfLimit = (peakBytes / limitBytes) * 100;
  return {
    recipients: count,
    queueBytesPerRow: queue.value,
    eventBytesPerRow: events.value,
    measured: queue.measured && events.measured,
    queueBytes,
    eventBytes,
    peakBytes,
    limitBytes,
    headroomBytes: limitBytes - peakBytes,
    percentOfLimit,
    level: percentOfLimit >= 100 ? "over" : percentOfLimit >= 85 ? "tight" : "ok",
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
