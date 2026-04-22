/**
 * In-memory sliding-window rate limiter.
 *
 * Works reliably in single-process deployments (dev, self-hosted).
 * On multi-instance Vercel each instance maintains its own window, so
 * the effective limit is maxRequests × instance_count.
 *
 * Automatically prunes expired windows to avoid unbounded memory growth.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
let lastPruneAt = Date.now();
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

function pruneExpired() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  for (const [key, win] of windows) {
    if (now >= win.resetAt) windows.delete(key);
  }
}

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  pruneExpired();
  const now = Date.now();
  const win = windows.get(key);

  if (!win || now >= win.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (win.count >= maxRequests) {
    return { allowed: false, retryAfterMs: win.resetAt - now };
  }

  win.count++;
  return { allowed: true, retryAfterMs: 0 };
}
