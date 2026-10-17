"use server";

import { createClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { requireCanSendAuthContext, verifyBypassPassword } from "@/lib/authAccess";
import { env } from "@/lib/env";
import { logAudit } from "@/lib/logger";
import { checkRateLimitSync } from "@/lib/rateLimit";
import { buildQueueReleaseConfirmation } from "@/lib/queueReleaseGuard";
import { campaignContentDigest, getAutopilotRecord, parseFutureSendAt, parseSendWindowInput } from "@/lib/sendAutopilot";
import {
  buildSendRequest,
  checkSendRequest,
  hashApprovalToken,
  loadSendRequestByToken,
  newApprovalToken,
  saveSendRequest,
  transitionSendRequest,
} from "@/lib/sendApprovalRequests";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { assertSendReadySubject } from "@/lib/subjectReadiness";
import { sendQueuedEmailAction } from "@/app/(dashboard)/email/actions";

const appUrl = (path: string) => `${env.appBaseUrl.replace(/\/$/, "")}${path}`;

async function unsentFor(emailId: string) {
  const { data, error } = await getSupabaseAdmin().rpc("get_queue_campaign_summaries", {
    p_email_ids: [emailId],
    p_now: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return (data ?? []).reduce(
    (total: number, row: { pending_due?: number | null; pending_held?: number | null }) =>
      total + Number(row.pending_due ?? 0) + Number(row.pending_held ?? 0),
    0,
  );
}

// ── Request (callable by AI agents through /ai) ─────────────────────────────
// Creates a pending request and returns a one-time approval URL. Never sends.
export async function createSendRequestAction(formData: FormData): Promise<{
  url?: string;
  expiresAt?: string;
  unsent?: number;
  error?: string;
}> {
  try {
    const auth = await requireCanSendAuthContext();
    const emailId = String(formData.get("id") ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(emailId)) return { error: "Invalid campaign id." };

    const supabase = getSupabaseAdmin();
    const { data: email, error } = await supabase
      .from("emails")
      .select("status, subject, from_address, reply_to, html, text")
      .eq("id", emailId)
      .maybeSingle();
    if (error) return { error: error.message };
    if (!email) return { error: "Campaign not found." };
    if (!["queued", "sending"].includes(email.status)) return { error: `Campaign is ${email.status}; queue it before requesting a send.` };
    assertSendReadySubject(email.subject ?? "");
    const record = await getAutopilotRecord(emailId);
    if (record?.state === "preparing") return { error: "Recipients are still being prepared; request the send once it shows prepared." };

    const windowInput = parseSendWindowInput(formData.get("send_window"));
    if (windowInput.error) return { error: windowInput.error };
    const schedule = parseFutureSendAt(formData.get("send_at"));
    if (schedule.error) return { error: schedule.error };

    const unsent = await unsentFor(emailId);
    if (unsent === 0) return { error: "No unsent recipients remain for this campaign." };

    const token = newApprovalToken();
    const request = buildSendRequest({
      tokenHash: hashApprovalToken(token),
      emailId,
      subject: email.subject ?? "",
      requestedBy: auth.email,
      unsentAtRequest: unsent,
      contentSha256: campaignContentDigest(email),
      sendWindow: windowInput.sendWindow,
      sendAt: schedule.startAt,
      note: String(formData.get("note") ?? ""),
    });
    await saveSendRequest(request);
    logAudit({
      userId: auth.userId,
      action: "campaign.send_requested",
      entity: "emails",
      entityId: emailId,
      payload: { unsent, sendWindow: request.sendWindow, expiresAt: request.expiresAt },
    }).catch(console.error);
    return { url: appUrl(`/approve/${token}`), expiresAt: request.expiresAt, unsent };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unable to create the approval request." };
  }
}

// The password is the human gate: AI agents are never permitted to enter one.
// A throwaway client checks it so the operator's own session is untouched.
async function passwordMatches(email: string, password: string) {
  if (!password) return false;
  if (await verifyBypassPassword(password).catch(() => false)) return true;
  if (!env.supabase.url || !env.supabase.anonKey) return false;
  const client = createClient(env.supabase.url, env.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  return !error && Boolean(data.user);
}

export type ApprovalState = { error?: string };

// ── Approve (human only: password required) ─────────────────────────────────
export async function approveSendRequestAction(_prev: ApprovalState, formData: FormData): Promise<ApprovalState> {
  const auth = await requireCanSendAuthContext();
  const token = String(formData.get("token") ?? "");
  const { allowed } = checkRateLimitSync(`send-approval:${auth.userId}`, 5, 15 * 60 * 1000);
  if (!allowed) return { error: "Too many attempts. Wait 15 minutes and try again." };

  const request = await loadSendRequestByToken(token);
  if (!request) return { error: "This approval link is not valid." };
  const { data: email } = await getSupabaseAdmin()
    .from("emails")
    .select("subject, from_address, reply_to, html, text")
    .eq("id", request.emailId)
    .maybeSingle();
  const check = checkSendRequest(request, email ? campaignContentDigest(email) : null);
  if (!check.ok) return { error: check.message };

  const expected = String(formData.get("expectedRecipients") ?? "").trim();
  if (!/^\d+$/.test(expected)) return { error: "Reload the page so the recipient count is current, then approve again." };

  if (!(await passwordMatches(auth.email, String(formData.get("password") ?? "")))) {
    return { error: "That password is not correct." };
  }

  const claimed = await transitionSendRequest(request, "pending", { status: "approving", decidedBy: auth.email });
  if (!claimed) return { error: "This request was already decided in another tab." };

  const sendFd = new FormData();
  sendFd.set("id", request.emailId);
  sendFd.set("releaseConfirmation", buildQueueReleaseConfirmation(request.emailId));
  sendFd.set("expectedRecipients", expected);
  if (request.sendWindow) sendFd.set("sendWindow", request.sendWindow);
  if (request.sendAt) sendFd.set("sendAt", request.sendAt);
  const result = await sendQueuedEmailAction(sendFd);

  if (result.error) {
    await transitionSendRequest(claimed, "approving", { status: "pending", lastError: result.error, decidedBy: undefined });
    return { error: result.error };
  }
  await transitionSendRequest(claimed, "approving", { status: "approved", decidedAt: new Date().toISOString(), decidedBy: auth.email });
  logAudit({
    userId: auth.userId,
    action: "campaign.send_request_approved",
    entity: "emails",
    entityId: request.emailId,
    payload: { requestedBy: request.requestedBy, recipients: formData.get("expectedRecipients") },
  }).catch(console.error);
  redirect(`/email/monitor?emailId=${request.emailId}&notice=${encodeURIComponent("Approved. The cloud sender picks it up within a few minutes.")}`);
}

// ── Reject ───────────────────────────────────────────────────────────────────
export async function rejectSendRequestAction(formData: FormData) {
  const auth = await requireCanSendAuthContext();
  const request = await loadSendRequestByToken(String(formData.get("token") ?? ""));
  if (request?.status === "pending") {
    await transitionSendRequest(request, "pending", { status: "rejected", decidedAt: new Date().toISOString(), decidedBy: auth.email });
    logAudit({ userId: auth.userId, action: "campaign.send_request_rejected", entity: "emails", entityId: request.emailId }).catch(console.error);
  }
  redirect("/email/schedule");
}
