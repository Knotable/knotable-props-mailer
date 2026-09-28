import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { Json } from "@/supabase/types";

// Shared contract with scripts/ses-bulk-worker.mjs (scripts/lib/autopilot-core.mjs).
export const AUTOPILOT_KEY_PREFIX = "send_autopilot:";
export const ACTIVE_AUTOPILOT_STATES = ["preparing", "approved", "running", "waiting_quota", "waiting_reconcile", "waiting_retry"] as const;
export const HEARTBEAT_STALE_MS = 3 * 60_000;
export const AUTOPILOT_SCHEDULE_MINUTES = 5;

export type AutopilotState =
  | (typeof ACTIVE_AUTOPILOT_STATES)[number]
  | "prepared"
  | "paused"
  | "canceled"
  | "blocked"
  | "complete";

export type AutopilotRecord = {
  emailId: string;
  approvalId: string;
  approvedAt: string;
  approvedBy?: string;
  approvedRecipients?: number;
  approvedMaxRecipients?: number;
  audience?: { listIds: string[]; excludeRecipients?: string[] };
  sendAfterPrepare?: boolean;
  contentSha256?: string;
  subject?: string;
  source?: string;
  state: AutopilotState;
  message?: string;
  heartbeatAt?: string | null;
  nextCheckAt?: string | null;
  startAt?: string | null;
  updatedAt?: string;
  completedAt?: string;
  lastError?: string;
  errorCount?: number;
  run?: { url?: string | null; startedAt?: string };
  progress?: {
    prepared?: number;
    acceptedThisRun?: number;
    failedThisRun?: number;
    remainingEstimate?: number;
    ratePerSecond?: number;
    targetRatePerSecond?: number;
    etaSeconds?: number;
    backoffMs?: number;
  };
  quota?: { max24HourSend?: number; sentLast24Hours?: number; available?: number; reserve?: number; checkedAt?: string };
  totals?: Record<string, number>;
  canaryPassed?: boolean;
  canary?: { recipients: number; sent: number } | null;
  deliverability?: {
    accepted: number;
    hardBounces: number;
    complaints: number;
    maxHardBounceRate: number;
    maxComplaintRate: number;
    checkedAt?: string;
  };
};

export const autopilotKey = (emailId: string) => `${AUTOPILOT_KEY_PREFIX}${emailId}`;

export function campaignContentDigest(email: {
  from_address?: string | null;
  reply_to?: string | null;
  subject?: string | null;
  html?: string | null;
  text?: string | null;
}) {
  const parts = [email.from_address ?? "", email.reply_to ?? "", email.subject ?? "", email.html ?? "", email.text ?? ""];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function isActiveAutopilot(record: Pick<AutopilotRecord, "state"> | null | undefined) {
  return Boolean(record && (ACTIVE_AUTOPILOT_STATES as readonly string[]).includes(record.state));
}

function toRecord(value: Json | null | undefined): AutopilotRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as unknown as AutopilotRecord;
  return record.emailId && record.state ? record : null;
}

export async function getAutopilotRecords(emailIds: string[]): Promise<Map<string, AutopilotRecord>> {
  const result = new Map<string, AutopilotRecord>();
  if (!emailIds.length) return result;
  const { data, error } = await getSupabaseAdmin()
    .from("app_settings")
    .select("key, value")
    .in("key", emailIds.map(autopilotKey));
  if (error) {
    console.warn("[autopilot] record lookup failed", error.message);
    return result;
  }
  for (const row of data ?? []) {
    const record = toRecord(row.value as Json);
    if (record) result.set(record.emailId, record);
  }
  return result;
}

export async function getAutopilotRecord(emailId: string) {
  return (await getAutopilotRecords([emailId])).get(emailId) ?? null;
}

export async function listActiveAutopilotRecords(): Promise<AutopilotRecord[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_settings")
    .select("key, value")
    .like("key", `${AUTOPILOT_KEY_PREFIX}%`);
  if (error) {
    console.warn("[autopilot] active record lookup failed", error.message);
    return [];
  }
  return (data ?? [])
    .map((row) => toRecord(row.value as Json))
    .filter((record): record is AutopilotRecord => isActiveAutopilot(record))
    .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
}

export async function writeAutopilotRecord(record: AutopilotRecord) {
  const updatedAt = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("app_settings")
    .upsert(
      {
        key: autopilotKey(record.emailId),
        value: { ...record, updatedAt } as unknown as Json,
        description: "Props Mailer autopilot send approval and live worker status",
        updated_at: updatedAt,
      },
      { onConflict: "key" },
    );
  if (error) throw new Error(`Unable to record send approval: ${error.message}`);
}

// Stops future worker pickups. A running worker notices within ~15 seconds
// because it re-reads both this record and the email status on heartbeat.
export async function setAutopilotState(emailId: string, state: "paused" | "canceled", message: string) {
  const record = await getAutopilotRecord(emailId);
  if (!record || !isActiveAutopilot(record)) return false;
  const detail = record.state === "preparing"
    ? "Preparation stopped before the recipient list was complete. Queue it again from the Composer to finish."
    : message;
  await writeAutopilotRecord({ ...record, state, message: detail, nextCheckAt: null });
  return true;
}

export type AutopilotDispatchResult = { dispatched: boolean; detail: string };

// Optional instant start. Without a token the 5-minute schedule picks the
// campaign up, so a failure here is informational, never fatal.
export async function dispatchAutopilotWorker(emailId: string): Promise<AutopilotDispatchResult> {
  const token = process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
  const fallback = `The autopilot schedule picks it up within ${AUTOPILOT_SCHEDULE_MINUTES} minutes.`;
  if (!token) return { dispatched: false, detail: fallback };
  const repository = process.env.GITHUB_REPOSITORY ?? "Knotable/knotable-props-mailer";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return { dispatched: false, detail: fallback };
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/ses-bulk-worker.yml/dispatches`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: process.env.GITHUB_ACTIONS_REF ?? "master", inputs: { mode: "autopilot", email_id: emailId } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 204) return { dispatched: true, detail: "A worker is starting now." };
    console.warn("[autopilot] dispatch failed", response.status, (await response.text()).slice(0, 300));
  } catch (error) {
    console.warn("[autopilot] dispatch error", error);
  }
  return { dispatched: false, detail: fallback };
}

export type AutopilotView = {
  label: string;
  tone: "green" | "blue" | "amber" | "red" | "slate";
  detail: string;
  live: boolean;
};

export function describeAutopilot(record: AutopilotRecord | null | undefined, nowMs = Date.now()): AutopilotView | null {
  if (!record) return null;
  const heartbeatMs = Date.parse(record.heartbeatAt ?? "");
  const live = Number.isFinite(heartbeatMs) && nowMs - heartbeatMs < HEARTBEAT_STALE_MS;
  const detail = record.message ?? "";
  switch (record.state) {
    case "preparing":
      return live
        ? { label: "Preparing recipients", tone: "blue", detail, live }
        : { label: "Preparing recipients", tone: "blue", detail: detail || `Waiting for a cloud worker to build the recipient queue (within ${AUTOPILOT_SCHEDULE_MINUTES} minutes).`, live };
    case "prepared":
      return { label: "Prepared", tone: "slate", detail: detail || "Recipients are queued. Review, then press Send.", live: false };
    case "approved": {
      const startMs = Date.parse(record.startAt ?? "");
      if (Number.isFinite(startMs) && startMs > nowMs) {
        return { label: "Scheduled", tone: "slate", detail: `Sends automatically at ${formatUtc(record.startAt!)}. Pause to cancel.`, live: false };
      }
      return { label: "Starting", tone: "blue", detail: detail || `Approved; a worker starts within ${AUTOPILOT_SCHEDULE_MINUTES} minutes.`, live };
    }
    case "running":
      return live
        ? { label: "Sending", tone: "blue", detail, live }
        : { label: "Restarting", tone: "amber", detail: "Worker heartbeat is stale; the next scheduled run takes over automatically.", live };
    case "waiting_quota":
      return { label: "Waiting for SES quota", tone: "amber", detail, live };
    case "waiting_reconcile":
      return { label: "Settling interrupted batch", tone: "amber", detail, live };
    case "waiting_retry":
      return { label: "Retrying soon", tone: "amber", detail, live };
    case "paused":
      return { label: "Paused", tone: "slate", detail: detail || "Paused by an operator.", live: false };
    case "canceled":
      return { label: "Canceled", tone: "slate", detail, live: false };
    case "blocked":
      return { label: "Blocked", tone: "red", detail, live: false };
    case "complete":
      return { label: "Sent", tone: "green", detail, live: false };
    default:
      return { label: String(record.state), tone: "slate", detail, live };
  }
}

export function formatUtc(iso: string) {
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

// SES caps the account at 15/s and 65,400 per rolling 24h; autopilot runs at
// ~13/s and keeps a 500-recipient reserve.
export function estimateSendDuration(recipients: number, { ratePerSecond = 13, dailyCap = 65_400, reserve = 500 } = {}) {
  if (recipients <= 0) return null;
  const perWindow = Math.max(1, dailyCap - reserve);
  if (recipients > perWindow) {
    const days = Math.ceil(recipients / perWindow) - 1;
    return `~${days + 1} quota windows (about ${days} day${days === 1 ? "" : "s"} + a few hours); autopilot resumes each window by itself`;
  }
  const minutes = Math.ceil(recipients / ratePerSecond / 60);
  return minutes < 60 ? `~${minutes} min` : `~${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function parseFutureSendAt(raw: unknown, nowMs = Date.now()): { startAt: string | null; error?: string } {
  if (typeof raw !== "string" || !raw.trim()) return { startAt: null };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { startAt: null, error: "Scheduled time is not a valid date." };
  if (ms <= nowMs + 60_000) return { startAt: null };
  if (ms > nowMs + 60 * 24 * 3_600_000) return { startAt: null, error: "Schedule sends at most 60 days ahead." };
  return { startAt: new Date(ms).toISOString() };
}
