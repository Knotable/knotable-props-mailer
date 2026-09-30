import crypto from "node:crypto";

export const AUTOPILOT_KEY_PREFIX = "send_autopilot:";
export const WORKER_LEASE_KEY = "send_worker_lease";
export const ACTIVE_STATES = ["preparing", "approved", "running", "waiting_quota", "waiting_window", "waiting_reconcile", "waiting_retry"];
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
  if (["running", "preparing"].includes(record.state) && isHeartbeatFresh(record, nowMs, staleMs)) return false;
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

// Deliverability circuit breaker. Rates are measured on events since this
// approval's baseline, so an operator's deliberate re-approval starts clean.
// 5% hard bounces is where SES places an account under review (10% can pause
// it), and on a large send this campaign dominates the account's rate — so
// stop at the review line rather than above it.
export const BREAKER_DEFAULTS = { minSample: 300, maxHardBounceRate: 0.05, maxComplaintRate: 0.003 };

export function evaluateDeliverability({ accepted, hardBounces, complaints }, thresholds = BREAKER_DEFAULTS) {
  const { minSample, maxHardBounceRate, maxComplaintRate } = { ...BREAKER_DEFAULTS, ...thresholds };
  if (accepted < minSample) return { trip: false };
  const bounceRate = hardBounces / accepted;
  const complaintRate = complaints / accepted;
  if (complaintRate > maxComplaintRate) {
    return { trip: true, reason: `Complaint rate ${(complaintRate * 100).toFixed(2)}% (${complaints} of ${accepted}) exceeds ${(maxComplaintRate * 100).toFixed(2)}%.` };
  }
  if (bounceRate > maxHardBounceRate) {
    return { trip: true, reason: `Hard-bounce rate ${(bounceRate * 100).toFixed(1)}% (${hardBounces} of ${accepted}) exceeds ${(maxHardBounceRate * 100).toFixed(1)}%.` };
  }
  return { trip: false, bounceRate, complaintRate };
}

// Recipients to cancel at send time: unsubscribed/bounced/complained on the
// row's own list after queueing, or blocked anywhere (global suppression).
export function lateSuppressedIds(items, inactiveMembers) {
  const byEmail = new Map();
  for (const member of inactiveMembers) {
    const key = String(member.email ?? "").trim().toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), member]);
  }
  const suppressed = new Set();
  for (const item of items) {
    const members = byEmail.get(String(item.payload?.to ?? "").trim().toLowerCase()) ?? [];
    if (members.some((member) => member.status === "blocked" || (item.list_id && member.list_id === item.list_id))) suppressed.add(item.id);
  }
  return suppressed;
}

// Send window like "07:00-21:00 America/New_York" (may wrap midnight).
export function parseSendWindow(spec) {
  const match = String(spec ?? "").trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)$/);
  if (!match) return null;
  const [, sh, sm, eh, em, timeZone] = match;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    return null;
  }
  const startMin = Number(sh) * 60 + Number(sm);
  const endMin = Number(eh) * 60 + Number(em);
  if (startMin >= 1440 || endMin > 1440 || startMin === endMin) return null;
  return { startMin, endMin, timeZone, label: `${sh.padStart(2, "0")}:${sm}–${eh.padStart(2, "0")}:${em} ${timeZone}` };
}

function localMinutes(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(nowMs);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

export function sendWindowStatus(nowMs, window) {
  if (!window) return { open: true, nextOpenAt: null };
  const local = localMinutes(nowMs, window.timeZone);
  const { startMin, endMin } = window;
  const open = startMin < endMin ? local >= startMin && local < endMin : local >= startMin || local < endMin;
  if (open) return { open: true, nextOpenAt: null };
  const minutesUntil = (startMin - local + 1440) % 1440 || 1440;
  // Round to the minute; the worker re-checks, so DST edges self-correct.
  return { open: false, nextOpenAt: new Date(Math.ceil((nowMs + minutesUntil * 60_000) / 60_000) * 60_000).toISOString() };
}

// Results report sent once, a day after a campaign completes, when provider
// events (deliveries, bounces, opens, clicks) have mostly arrived.
export function isReportDue(record, nowMs, delayMs = 24 * 3_600_000) {
  if (record?.state !== "complete" || record.reportSentAt) return false;
  const completed = Date.parse(record.completedAt ?? "");
  return Number.isFinite(completed) && nowMs - completed >= delayMs;
}

const pct = (part, whole, digits = 1) => (whole > 0 ? `${((part / whole) * 100).toFixed(digits)}%` : "—");

export function formatResultsReport({ accepted, delivered, bounced, complained, opened, clicked }) {
  return [
    `Accepted by SES: ${accepted.toLocaleString()}`,
    `Delivered: ${delivered.toLocaleString()} (${pct(delivered, accepted)})`,
    `Bounced: ${bounced.toLocaleString()} (${pct(bounced, accepted)})`,
    `Complaints: ${complained.toLocaleString()} (${pct(complained, accepted, 2)})`,
    `Opened (unique): ${opened.toLocaleString()} (${pct(opened, delivered || accepted)} of delivered; Apple Mail privacy inflates opens)`,
    `Clicked (unique): ${clicked.toLocaleString()} (${pct(clicked, delivered || accepted)} of delivered; ${pct(clicked, opened)} of openers)`,
  ];
}
