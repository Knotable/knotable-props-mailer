import type { getSupabaseAdmin } from "@/lib/supabaseAdmin";

type Admin = ReturnType<typeof getSupabaseAdmin>;

// Bulk queue cleanup that cannot silently fail.
//
// A single UPDATE/DELETE over a large campaign's mail_queue rows (190k on
// 2026-10-16) exceeds Supabase's statement timeout. The old cancel/delete
// actions issued one such statement, ignored its error and reported success,
// so "Unqueued" left every row held. This module walks the rows in id-ordered
// batches, shrinks the batch when the database is slow, stops at a time budget
// and always reports exactly how far it got.

export type CleanupMode = "cancel" | "delete";

export type CleanupResult = {
  affected: number;
  complete: boolean;
  error?: string;
};

export type CleanupOps = {
  // Id of the `batchSize`-th remaining row in id order, or null when fewer
  // than `batchSize` rows remain (the next apply then covers all of them).
  boundary(batchSize: number): Promise<string | null>;
  // Apply to remaining rows with id <= boundary (all remaining when null).
  // Returns the number of rows changed.
  apply(boundary: string | null): Promise<number>;
};

export type CleanupOptions = {
  batchSize?: number;
  minBatchSize?: number;
  budgetMs?: number;
  now?: () => number;
};

const DEFAULT_BATCH = 5_000;
const DEFAULT_MIN_BATCH = 250;
// Server actions get maxDuration = 60 s on the pages that call them; leave room
// for the surrounding work and the response.
export const DEFAULT_CLEANUP_BUDGET_MS = 40_000;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(error: unknown) {
  return /statement timeout|canceling statement|timed out|timeout/i.test(message(error));
}

export async function runBatchedCleanup(ops: CleanupOps, options: CleanupOptions = {}): Promise<CleanupResult> {
  const now = options.now ?? Date.now;
  const minBatch = Math.max(1, options.minBatchSize ?? DEFAULT_MIN_BATCH);
  const budgetMs = options.budgetMs ?? DEFAULT_CLEANUP_BUDGET_MS;
  let batchSize = Math.max(minBatch, options.batchSize ?? DEFAULT_BATCH);
  const startedAt = now();
  let affected = 0;

  for (;;) {
    if (now() - startedAt > budgetMs) return { affected, complete: false };
    let boundary: string | null;
    let changed: number;
    try {
      boundary = await ops.boundary(batchSize);
      changed = await ops.apply(boundary);
    } catch (error) {
      if (isTimeout(error) && batchSize > minBatch) {
        batchSize = Math.max(minBatch, Math.floor(batchSize / 2));
        continue;
      }
      return { affected, complete: false, error: message(error) };
    }
    affected += changed;
    if (boundary === null) return { affected, complete: true };
  }
}

const UNSENT = ["pending"];

// Supabase adapter. `statuses` limits the rows touched; omit it to touch every
// row of the campaign (delete).
export function mailQueueCleanupOps(
  supabase: Admin,
  emailId: string,
  mode: CleanupMode,
  statuses: string[] | null = UNSENT,
): CleanupOps {
  return {
    async boundary(batchSize) {
      let query = supabase.from("mail_queue").select("id").eq("email_id", emailId);
      if (statuses) query = query.in("status", statuses);
      const { data, error } = await query.order("id", { ascending: true }).range(batchSize - 1, batchSize - 1);
      if (error) throw new Error(error.message);
      return (data?.[0] as { id?: string } | undefined)?.id ?? null;
    },
    async apply(boundary) {
      const base = supabase.from("mail_queue");
      let query = mode === "delete"
        ? base.delete({ count: "exact" })
        : base.update({ status: "canceled", locked_at: null, updated_at: new Date().toISOString() }, { count: "exact" });
      query = query.eq("email_id", emailId);
      if (statuses) query = query.in("status", statuses);
      if (boundary) query = query.lte("id", boundary);
      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  };
}

// True when the campaign has ever sent (or is sending) to a list audience.
// Test sends are stored with list_id = null and do not count. A campaign that
// never reached a list keeps no useful history in its held rows, so they are
// deleted rather than kept forever as `canceled`.
export async function hasMailedListAudience(supabase: Admin, emailId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("mail_queue")
    .select("id")
    .eq("email_id", emailId)
    .not("list_id", "is", null)
    .in("status", ["processing", "succeeded", "failed", "dead"])
    .limit(1);
  if (error) throw new Error(error.message);
  return Boolean(data?.length);
}

// Unsent rows that belong to lists outside `listIds`. Queueing on top of them
// would silently merge the old audience into the new send (2026-10-16: a
// six-list Send Now landed on 187k leftover rows from a five-list queue).
export async function findForeignUnsentList(
  supabase: Admin,
  emailId: string,
  listIds: string[],
): Promise<string | null> {
  let query = supabase
    .from("mail_queue")
    .select("list_id")
    .eq("email_id", emailId)
    .in("status", ["pending", "processing"])
    .not("list_id", "is", null);
  if (listIds.length) query = query.not("list_id", "in", `(${listIds.join(",")})`);
  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0] as { list_id?: string | null } | undefined)?.list_id ?? null;
}

export function describeIncompleteCleanup(action: string, result: CleanupResult) {
  const done = result.affected.toLocaleString();
  return result.error
    ? `${action} stopped after ${done} rows: ${result.error}. Nothing will send; run it again to finish clearing.`
    : `${action} cleared ${done} rows but more remain (the database is slow on large campaigns). Nothing will send; run it again to finish.`;
}
