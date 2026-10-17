import { createHash, randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { Json } from "@/supabase/types";

// Human approval links for AI-requested sends.
//
// An AI agent driving the /ai interface may *request* a send but cannot
// approve one: request_send stores a pending request and returns a one-time
// URL (/approve/<token>). The operator opens it, reviews the rendered email,
// audience and exact count, and approves with their account password — a step
// agents are never permitted to perform. Only the SHA-256 of the token is
// stored, so a database read does not reveal working links. Requests expire
// after 24 hours and are consumed by the first decision.

export const SEND_REQUEST_KEY_PREFIX = "send_request:";
export const SEND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export type SendRequestStatus = "pending" | "approving" | "approved" | "rejected";

export type SendRequest = {
  kind: "send_request";
  tokenHash: string;
  emailId: string;
  subject: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  unsentAtRequest: number;
  contentSha256: string;
  sendWindow: string | null;
  sendAt: string | null;
  note: string | null;
  status: SendRequestStatus;
  decidedAt?: string;
  decidedBy?: string;
  lastError?: string;
};

export function newApprovalToken() {
  return randomBytes(32).toString("base64url");
}

export function hashApprovalToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export const sendRequestKey = (tokenHash: string) => `${SEND_REQUEST_KEY_PREFIX}${tokenHash}`;

export function buildSendRequest(input: {
  tokenHash: string;
  emailId: string;
  subject: string;
  requestedBy: string;
  unsentAtRequest: number;
  contentSha256: string;
  sendWindow?: string | null;
  sendAt?: string | null;
  note?: string | null;
  nowMs?: number;
}): SendRequest {
  const now = input.nowMs ?? Date.now();
  return {
    kind: "send_request",
    tokenHash: input.tokenHash,
    emailId: input.emailId,
    subject: input.subject,
    requestedBy: input.requestedBy,
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SEND_REQUEST_TTL_MS).toISOString(),
    unsentAtRequest: input.unsentAtRequest,
    contentSha256: input.contentSha256,
    sendWindow: input.sendWindow?.trim() || null,
    sendAt: input.sendAt?.trim() || null,
    note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
    status: "pending",
  };
}

export type RequestCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "expired" | "decided" | "content_changed"; message: string };

// Whether a request can still be approved. Content drift is checked against
// the live campaign digest so an edited email cannot ride an old link.
export function checkSendRequest(
  request: SendRequest | null,
  liveContentSha256: string | null,
  nowMs = Date.now(),
): RequestCheck {
  if (!request) return { ok: false, reason: "missing", message: "This approval link is not valid." };
  if (request.status !== "pending") {
    return { ok: false, reason: "decided", message: `This request was already ${request.status === "approving" ? "being approved" : request.status}.` };
  }
  if (Date.parse(request.expiresAt) <= nowMs) {
    return { ok: false, reason: "expired", message: "This approval link has expired. Ask for a new one." };
  }
  if (liveContentSha256 && liveContentSha256 !== request.contentSha256) {
    return {
      ok: false,
      reason: "content_changed",
      message: "The email's subject, sender or body changed after this link was created. Ask for a new link so you approve what will actually go out.",
    };
  }
  return { ok: true };
}

// ── Storage (app_settings) ───────────────────────────────────────────────────

export async function saveSendRequest(request: SendRequest) {
  const { error } = await getSupabaseAdmin()
    .from("app_settings")
    .upsert(
      { key: sendRequestKey(request.tokenHash), value: request as unknown as Json, description: "AI-requested send awaiting human approval", updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) throw new Error(`save send request: ${error.message}`);
}

export async function loadSendRequestByToken(token: string): Promise<SendRequest | null> {
  if (!isWellFormedToken(token)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("app_settings")
    .select("value")
    .eq("key", sendRequestKey(hashApprovalToken(token)))
    .maybeSingle();
  if (error) throw new Error(`load send request: ${error.message}`);
  const value = (data as { value?: unknown } | null)?.value;
  return value && typeof value === "object" && (value as SendRequest).kind === "send_request" ? (value as SendRequest) : null;
}

// Moves a request from one status to the next only if it is still in `from`
// (compare-and-set), so two clicks or two tabs cannot both approve.
export async function transitionSendRequest(
  request: SendRequest,
  from: SendRequestStatus,
  patch: Partial<SendRequest> & { status: SendRequestStatus },
): Promise<SendRequest | null> {
  const next: SendRequest = { ...request, ...patch };
  const { data, error } = await getSupabaseAdmin()
    .from("app_settings")
    .update({ value: next as unknown as Json, updated_at: new Date().toISOString() })
    .eq("key", sendRequestKey(request.tokenHash))
    .eq("value->>status", from)
    .select("key");
  if (error) throw new Error(`update send request: ${error.message}`);
  return data?.length ? next : null;
}
