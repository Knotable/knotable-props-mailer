import crypto from "node:crypto";

export const AUTOPILOT_KEY_PREFIX = "send_autopilot:";
export const WORKER_LEASE_KEY = "send_worker_lease";
export const ACTIVE_STATES = ["approved", "running", "waiting_quota", "waiting_reconcile", "waiting_retry"];
export const AMBIGUOUS_CLAIM_PREFIX = "ambiguous_claim:";

export const autopilotKey = (emailId) => `${AUTOPILOT_KEY_PREFIX}${emailId}`;

export function emailIdFromKey(key) {
  return typeof key === "string" && key.startsWith(AUTOPILOT_KEY_PREFIX) ? key.slice(AUTOPILOT_KEY_PREFIX.length) : null;
}

// Must stay byte-identical with src/lib/sendAutopilot.ts; a parity test guards it.
export function campaignContentDigest(email) {
  const parts = [email.from_address ?? "", email.reply_to ?? "", email.subject ?? "", email.html ?? "", email.text ?? ""];
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function isActiveRecord(record) {
  return Boolean(record && ACTIVE_STATES.includes(record.state));
}

export function isHeartbeatFresh(record, nowMs, staleMs = 3 * 60_000) {
  const at = Date.parse(record?.heartbeatAt ?? "");
  return Number.isFinite(at) && nowMs - at < staleMs;
}

// A record is due for a worker when it is active, no live worker is heartbeating
// it, and any deliberate back-off (quota or reconciliation wait) has elapsed.
export function isRecordDue(record, nowMs, staleMs) {
  if (!isActiveRecord(record)) return false;
  if (record.state === "running" && isHeartbeatFresh(record, nowMs, staleMs)) return false;
  const nextCheckAt = Date.parse(record.nextCheckAt ?? "");
  return !Number.isFinite(nextCheckAt) || nextCheckAt <= nowMs;
}

export function orderDueRecords(records, nowMs, staleMs) {
  return records
    .filter((record) => isRecordDue(record, nowMs, staleMs))
    .sort((a, b) => String(a.approvedAt ?? "").localeCompare(String(b.approvedAt ?? "")));
}

export function availableQuota({ max24HourSend, sentLast24Hours, reserve = 0 }) {
  const max = Number(max24HourSend ?? 0);
  const sent = Number(sentLast24Hours ?? 0);
  return Math.max(0, Math.floor(max - sent - Math.max(0, reserve)));
}

export function effectiveRate({ sesMaxSendRate, requestedRate }) {
  const sesCeiling = Math.max(1, Number(sesMaxSendRate ?? 1) * 0.9);
  const requested = Number(requestedRate);
  if (!Number.isFinite(requested) || requested <= 0) return sesCeiling;
  return Math.max(0.5, Math.min(sesCeiling, requested));
}

// Token-bucket pacer: each take(n) reserves n recipients of SES send-rate
// budget. Time spent on database work between sends counts toward the budget,
// so the worker sustains the target rate instead of rate + overhead.
export function createPacer(ratePerSecond, { now = () => Date.now(), sleep } = {}) {
  let nextAt = 0;
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return {
    async take(count) {
      const current = now();
      const startAt = Math.max(current, nextAt);
      if (startAt > current) await wait(startAt - current);
      nextAt = startAt + Math.ceil((count / ratePerSecond) * 1000);
    },
    reset() {
      nextAt = 0;
    },
  };
}

// Adaptive database back-off. Supabase shares capacity with the SES webhook,
// so a slow or failed claim/checkpoint means the database is under pressure.
// Pause exponentially while it is unhealthy; resume full speed once healthy.
export function createBackoff({ slowMs = 4_000, basePauseMs = 15_000, maxPauseMs = 120_000, healthyToReset = 5 } = {}) {
  let pauseMs = 0;
  let healthyStreak = 0;
  return {
    observe({ latencyMs, retried = false }) {
      if (retried || latencyMs > slowMs) {
        healthyStreak = 0;
        pauseMs = pauseMs ? Math.min(maxPauseMs, pauseMs * 2) : basePauseMs;
        return pauseMs;
      }
      healthyStreak += 1;
      if (healthyStreak >= healthyToReset) pauseMs = 0;
      return 0;
    },
    get currentPauseMs() {
      return pauseMs;
    },
  };
}

const THROTTLE_PATTERN = /throttl|rate exceeded|too many requests|maximum sending rate/i;
const QUOTA_PATTERN = /daily message quota|quota exceeded|sending quota/i;

// Classify an exception thrown by SES SendBulkEmail. When AWS returned an HTTP
// response, the request was rejected and nothing was sent, so retrying is safe.
// Without a response (socket reset, timeout) SES may have accepted the batch,
// so it is ambiguous and must never be retried automatically.
const NEVER_CONNECTED_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "CredentialsProviderError"]);

export function classifySendException(error) {
  const status = Number(error?.$metadata?.httpStatusCode ?? 0);
  const text = `${error?.name ?? ""} ${error?.message ?? ""}`;
  // The request never reached SES, so nothing can have been sent.
  if (!status && (NEVER_CONNECTED_CODES.has(error?.code) || NEVER_CONNECTED_CODES.has(error?.name))) {
    return { kind: "retryable", message: text.trim() };
  }
  if (!status) return { kind: "ambiguous", message: text.trim() || "No response from SES" };
  if (QUOTA_PATTERN.test(text)) return { kind: "quota", message: text.trim() };
  if (THROTTLE_PATTERN.test(text) || status === 429 || status >= 500) return { kind: "retryable", message: text.trim() };
  return { kind: "rejected", message: text.trim() || `SES rejected the request (${status})` };
}

export function estimateEtaSeconds(remaining, ratePerSecond) {
  if (!remaining || !ratePerSecond) return 0;
  return Math.ceil(remaining / ratePerSecond);
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${total}s`;
}

export function runUrlFromEnv(env = process.env) {
  return env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
}
