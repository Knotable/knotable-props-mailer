/**
 * POST /api/workers/send-queued
 *
 * Narrow cron endpoint for external schedulers. It drains one batch for an
 * email already marked `sending`, so a scheduler cannot release drafts or
 * broadly drain queued/sent campaigns.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { runQueueWorker } from "@/lib/queueWorker";

export const dynamic = "force-dynamic";

const ACTIVE_EMAIL_SCAN_LIMIT = 10;

type SendingEmailRow = {
  id: string;
  subject: string | null;
};

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`);
}

async function queueCountsForEmail(emailId: string) {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const [pendingDueResult, processingResult] = await Promise.all([
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", emailId)
      .eq("status", "pending")
      .lte("available_at", nowIso),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", emailId)
      .eq("status", "processing"),
  ]);

  if (pendingDueResult.error) throw pendingDueResult.error;
  if (processingResult.error) throw processingResult.error;

  return {
    pendingDue: pendingDueResult.count ?? 0,
    processing: processingResult.count ?? 0,
  };
}

async function loadNextSendingEmail() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("emails")
    .select("id, subject")
    .eq("status", "sending")
    .order("updated_at", { ascending: true })
    .limit(ACTIVE_EMAIL_SCAN_LIMIT);

  if (error) throw error;

  const candidates = (data ?? []) as SendingEmailRow[];
  for (const email of candidates) {
    const counts = await queueCountsForEmail(email.id);
    if (counts.pendingDue > 0 || counts.processing > 0) {
      return { ...email, ...counts, scanned: candidates.length };
    }
  }

  return { scanned: candidates.length };
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action?: unknown } = {};
  try {
    body = (await request.json()) as { action?: unknown };
  } catch {
    body = {};
  }

  if (body.action != null && body.action !== "send_queued") {
    return NextResponse.json({ error: "Unsupported worker action" }, { status: 400 });
  }

  try {
    const active = await loadNextSendingEmail();
    if (!("id" in active)) {
      return NextResponse.json({
        ok: true,
        action: "send_queued",
        processed: 0,
        message: "No sending campaigns have due or processing queue rows.",
        scannedSendingEmails: active.scanned,
      });
    }

    const result = await runQueueWorker({ emailId: active.id });
    return NextResponse.json({
      ok: true,
      action: "send_queued",
      emailId: active.id,
      subject: active.subject,
      before: {
        pendingDue: active.pendingDue,
        processing: active.processing,
      },
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker trigger failed";
    console.error("[send-queued worker trigger] failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
