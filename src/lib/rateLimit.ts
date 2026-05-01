/**
 * DB-backed fixed-window rate limiter.
 *
 * Uses the existing `error_logs` table as a lightweight counter store via an
 * upsert trick: we INSERT a sentinel row and count matching rows within the
 * window. No new table needed, no schema changes.
 *
 * Strategy: for each (key, window-bucket) pair, we INSERT a counting row.
 * We then SELECT COUNT where source=key and created_at >= window start.
 * If count > maxRequests we deny; otherwise we allow (the INSERT already
 * reserved the slot).
 *
 * This is "optimistic" — under extreme concurrency you may get slightly over
 * limit before the count is read back, but for our use case (webhook rate
 * limiting at 300 req/min) the margin is fine.  The critical property is that
 * it works across Vercel instances, unlike the old in-memory Map.
 *
 * Falls back to allow=true if the DB call fails, so a Supabase hiccup never
 * blocks legitimate traffic.
 */

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Check and consume one slot in the rate-limit window.
 *
 * @param key         Unique limiter key, e.g. "ses-webhook:1.2.3.4"
 * @param maxRequests Maximum requests allowed in the window
 * @param windowMs    Window size in milliseconds
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  try {
    const supabase = getSupabaseAdmin();
    const now = Date.now();
    const windowStart = new Date(now - windowMs).toISOString();

    // Count existing hits in this window BEFORE inserting.
    // We use error_logs with source="rate_limit:<key>" and message="hit".
    const { count } = await supabase
      .from("error_logs")
      .select("id", { count: "exact", head: true })
      .eq("source", `rate_limit:${key}`)
      .gte("created_at", windowStart);

    const currentCount = count ?? 0;

    if (currentCount >= maxRequests) {
      // Window is full. Estimate how long until the oldest hit ages out.
      // Simplification: return half the window as a hint; accurate enough.
      return { allowed: false, retryAfterMs: Math.round(windowMs / 2) };
    }

    // Reserve the slot by inserting a hit row.
    await supabase.from("error_logs").insert({
      source: `rate_limit:${key}`,
      message: "hit",
      // No user_id, no stack — these are intentionally minimal sentinel rows.
    });

    return { allowed: true, retryAfterMs: 0 };
  } catch (err) {
    // Fail open: a DB error should never block legitimate traffic.
    console.warn("[rateLimit] DB check failed, failing open:", err);
    return { allowed: true, retryAfterMs: 0 };
  }
}

/**
 * Synchronous in-memory fallback for callers that cannot await.
 * Only use this where you'd otherwise call the old synchronous API.
 * Effective only within a single Vercel instance — use checkRateLimit
 * (async) for anything that needs to work across instances.
 */
interface MemWindow {
  count: number;
  resetAt: number;
}
const memWindows = new Map<string, MemWindow>();

export function checkRateLimitSync(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const win = memWindows.get(key);

  if (!win || now >= win.resetAt) {
    memWindows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (win.count >= maxRequests) {
    return { allowed: false, retryAfterMs: win.resetAt - now };
  }

  win.count++;
  return { allowed: true, retryAfterMs: 0 };
}
