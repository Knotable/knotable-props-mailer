import { describe, expect, it } from "vitest";
import { describeIncompleteCleanup, runBatchedCleanup, type CleanupOps } from "./queueCleanup";

// In-memory stand-in for one campaign's unsent rows, ordered by id.
function fakeRows(total: number, opts: { timeoutAbove?: number; failOnCall?: number } = {}) {
  const ids = Array.from({ length: total }, (_, i) => String(i).padStart(8, "0"));
  let remaining = [...ids];
  let applyCalls = 0;
  const ops: CleanupOps = {
    async boundary(batchSize) {
      return remaining.length >= batchSize ? remaining[batchSize - 1] : null;
    },
    async apply(boundary) {
      applyCalls += 1;
      if (opts.failOnCall === applyCalls) throw new Error("permission denied for table mail_queue");
      const hit = boundary === null ? remaining : remaining.filter((id) => id <= boundary);
      if (opts.timeoutAbove !== undefined && hit.length > opts.timeoutAbove) {
        throw new Error("canceling statement due to statement timeout");
      }
      remaining = remaining.filter((id) => !hit.includes(id));
      return hit.length;
    },
  };
  return { ops, remaining: () => remaining.length, applyCalls: () => applyCalls };
}

describe("runBatchedCleanup", () => {
  it("clears every row in bounded batches and reports completion", async () => {
    const rows = fakeRows(12_345);
    const result = await runBatchedCleanup(rows.ops, { batchSize: 1_000 });
    expect(result).toEqual({ affected: 12_345, complete: true });
    expect(rows.remaining()).toBe(0);
    expect(rows.applyCalls()).toBe(13);
  });

  it("completes immediately when nothing is left", async () => {
    const rows = fakeRows(0);
    expect(await runBatchedCleanup(rows.ops)).toEqual({ affected: 0, complete: true });
  });

  it("halves the batch on statement timeouts instead of failing", async () => {
    const rows = fakeRows(3_000, { timeoutAbove: 600 });
    const result = await runBatchedCleanup(rows.ops, { batchSize: 5_000, minBatchSize: 100 });
    expect(result.complete).toBe(true);
    expect(result.affected).toBe(3_000);
    expect(rows.remaining()).toBe(0);
  });

  it("never claims success when a non-timeout error stops it", async () => {
    const rows = fakeRows(5_000);
    const result = await runBatchedCleanup(rows.ops, { batchSize: 1_000 }).then((r) => r);
    expect(result.complete).toBe(true);
    const failing = fakeRows(5_000, { failOnCall: 3 });
    const stopped = await runBatchedCleanup(failing.ops, { batchSize: 1_000 });
    expect(stopped).toMatchObject({ affected: 2_000, complete: false });
    expect(stopped.error).toMatch(/permission denied/);
    expect(failing.remaining()).toBe(3_000);
  });

  it("stops at the time budget and says how far it got", async () => {
    const rows = fakeRows(10_000);
    let clock = 0;
    const result = await runBatchedCleanup(
      { boundary: rows.ops.boundary, apply: async (b) => { clock += 1_000; return rows.ops.apply(b); } },
      { batchSize: 1_000, budgetMs: 2_500, now: () => clock },
    );
    expect(result).toEqual({ affected: 3_000, complete: false });
    expect(describeIncompleteCleanup("Unqueue", result)).toMatch(/Unqueue cleared 3,000 rows but more remain/);
  });

  it("gives up at the minimum batch when even that times out", async () => {
    const rows = fakeRows(1_000, { timeoutAbove: 10 });
    const result = await runBatchedCleanup(rows.ops, { batchSize: 400, minBatchSize: 100 });
    expect(result.complete).toBe(false);
    expect(result.error).toMatch(/statement timeout/);
  });
});
