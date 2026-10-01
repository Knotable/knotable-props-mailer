import { describe, expect, it } from "vitest";
import {
  FREE_TIER_LIMIT_BYTES,
  formatBytes,
  getDatabaseLimitBytes,
  isStorageStats,
  projectSend,
  unusedIndexes,
  type StorageStats,
} from "./databaseStorage";

const MB = 1024 * 1024;

function stats(overrides: Partial<StorageStats> = {}): StorageStats {
  return {
    database_bytes: 150 * MB,
    tables: [
      { name: "mail_queue", total_bytes: 1_000 * 1_000, heap_bytes: 0, index_bytes: 0, live_rows: 1_000, dead_rows: 0, last_autovacuum: null },
      { name: "provider_events", total_bytes: 500 * 2_000, heap_bytes: 0, index_bytes: 0, live_rows: 2_000, dead_rows: 0, last_autovacuum: null },
    ],
    indexes: [
      { table_name: "mail_queue", name: "a", bytes: 10, scans: 0, is_unique: false, is_primary: false },
      { table_name: "mail_queue", name: "b", bytes: 10, scans: 5, is_unique: false, is_primary: false },
      { table_name: "mail_queue", name: "c", bytes: 10, scans: 0, is_unique: true, is_primary: false },
      { table_name: "mail_queue", name: "d", bytes: 10, scans: 0, is_unique: false, is_primary: true },
    ],
    ...overrides,
  };
}

describe("projectSend", () => {
  const ledgerTable = { name: "email_deliveries", total_bytes: 0, heap_bytes: 0, index_bytes: 0, live_rows: 0, dead_rows: 0, last_autovacuum: null };

  it("uses measured per-row sizes when the tables are big enough", () => {
    const projection = projectSend(stats(), 100_000, 500 * MB);
    expect(projection.measured).toBe(true);
    expect(projection.queueBytesPerRow).toBe(1_000);
    expect(projection.eventBytesPerRow).toBe(500);
    expect(projection.ledger).toBe(false);
    // Without the ledger: 100k * 1000 * 2.9 (no vacuum) + 100k * 500 * 2 events + 150 MB existing.
    expect(projection.peakBytes).toBe(150 * MB + 290_000_000 + 100_000_000);
    expect(projection.peakBytesVacuumed).toBe(150 * MB + 120_000_000 + 100_000_000);
    expect(projection.permanentBytes).toBe(100_000 * (1_000 + 2 * 500));
  });

  it("models the delivery ledger once its tables exist: tiny permanent cost, rare event rows", () => {
    const withLedger = stats({ tables: [...stats().tables, ledgerTable] });
    const projection = projectSend(withLedger, 100_000, 500 * MB);
    expect(projection.ledger).toBe(true);
    // 100k * 1000 * 1.2 (vacuumed) + 100k * 115 ledger + 100k * 500 * 0.03 event rows + 150 MB.
    expect(projection.peakBytesVacuumed).toBe(150 * MB + 120_000_000 + 11_500_000 + 1_500_000);
    expect(projection.permanentBytes).toBe(900_000);
    expect(projection.peakBytesVacuumed).toBeLessThan(projectSend(stats(), 100_000, 500 * MB).peakBytesVacuumed);
  });

  it("trusts the explicit ledger_installed flag over the table list", () => {
    expect(projectSend(stats({ ledger_installed: true }), 1_000).ledger).toBe(true);
    expect(projectSend(stats({ tables: [...stats().tables, ledgerTable], ledger_installed: false }), 1_000).ledger).toBe(false);
  });

  it("falls back to measured defaults on small tables and says so", () => {
    const projection = projectSend(stats({ tables: [] }), 1_000, 500 * MB);
    expect(projection.measured).toBe(false);
    expect(projection.queueBytesPerRow).toBe(725);
  });

  it("flags tight and over-limit sends, separately with and without vacuuming", () => {
    expect(projectSend(stats(), 1_000, 500 * MB).level).toBe("ok");
    expect(projectSend(stats(), 185_000, 500 * MB).level).toBe("over");
    const tight = projectSend(stats({ database_bytes: 360 * MB }), 40_000, 500 * MB);
    expect(tight.levelVacuumed).toBe("tight");
    expect(tight.level).toBe("over");
  });

  it("clamps negative or fractional recipient counts", () => {
    expect(projectSend(stats(), -5).recipients).toBe(0);
    expect(projectSend(stats(), 10.9).recipients).toBe(10);
  });
});

describe("storage helpers", () => {
  it("lists only non-constraint indexes that were never scanned", () => {
    expect(unusedIndexes(stats()).map((index) => index.name)).toEqual(["a"]);
  });

  it("reads the limit from SUPABASE_DB_LIMIT_MB with a free-tier default", () => {
    expect(getDatabaseLimitBytes({})).toBe(FREE_TIER_LIMIT_BYTES);
    expect(getDatabaseLimitBytes({ SUPABASE_DB_LIMIT_MB: "8192" })).toBe(8192 * MB);
    expect(getDatabaseLimitBytes({ SUPABASE_DB_LIMIT_MB: "nope" })).toBe(FREE_TIER_LIMIT_BYTES);
  });

  it("validates the RPC shape and formats sizes", () => {
    expect(isStorageStats(stats())).toBe(true);
    expect(isStorageStats({ database_bytes: "x" })).toBe(false);
    expect(isStorageStats(null)).toBe(false);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(150 * MB)).toBe("150 MB");
    expect(formatBytes(3 * 1024 * MB)).toBe("3.00 GB");
  });
});
