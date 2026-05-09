/**
 * GET /api/email/send-monitor
 *
 * Returns a live snapshot of the queue for the send-monitor page.
 * Called every ~31 seconds by the browser while a send is in progress.
 *
 * POST /api/email/send-monitor
 *
 * Fires the queue worker for a specific emailId (or all pending if omitted).
 * This is what the monitor page hits on each tick.
 *
 * Auth: same CRON_SECRET bearer token as /api/email/queue.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailySentCount, todayUTC } from "@/lib/dailyQuota";
import { getDailySendLimit } from "@/lib/appSettings";
import { runQueueWorker } from "@/lib/queueWorker";

export const dynamic = "force-dynamic";

type RecipientLogRow = {
  recipientEmail: string | null;
  status: string | null;
  attemptCount: number | null;
  maxAttempts: number | null;
  availableAt: string | null;
  updatedAt: string | null;
  lastError: string | null;
};

type QueueLogRow = {
  payload?: { to?: string | null } | null;
  status?: string | null;
  attempts?: number | null;
  max_attempts?: number | null;
  available_at?: string | null;
  updated_at?: string | null;
  last_error?: string | null;
};

function authCheck(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

function optionalEmailId(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get("emailId")?.trim();
  return value || undefined;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return fallback;
  }
}

async function countQueueRows(status: string, emailId?: string, availability?: "due" | "held") {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", status);

  if (emailId) query = query.eq("email_id", emailId);
  if (availability === "due") query = query.lte("available_at", new Date().toISOString());
  if (availability === "held") query = query.gt("available_at", new Date().toISOString());

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function loadRecipientLog(emailId: string, limit = 250): Promise<RecipientLogRow[]> {
  const supabase = getSupabaseAdmin();
  const safeLimit = Math.min(Math.max(limit, 1), 2_000);

  const { data, error } = await supabase
    .from("mail_queue")
    .select("payload, status, attempts, max_attempts, available_at, updated_at, last_error")
    .eq("email_id", emailId)
    .order("updated_at", { ascending: false })
    .limit(safeLimit);

  if (error) {
    console.error("[send-monitor] recipient log load failed", error);
    return [];
  }

  return ((data ?? []) as QueueLogRow[]).map((row) => ({
    recipientEmail: row.payload?.to ?? null,
    status: row.status ?? null,
    attemptCount: row.attempts ?? null,
    maxAttempts: row.max_attempts ?? null,
    availableAt: row.available_at ?? null,
    updatedAt: row.updated_at ?? null,
    lastError: row.last_error ?? null,
  }));
}

async function buildMonitorSnapshot(emailId?: string) {
  const supabase = getSupabaseAdmin();
  const today = todayUTC();

  const [
    sentToday,
    dailySendLimit,
    pending,
    processing,
    succeeded,
    failed,
    dead,
    canceled,
    pendingDue,
    pendingHeld,
  ] = await Promise.all([
    getDailySentCount(today),
    getDailySendLimit(),
    countQueueRows("pending", emailId),
    countQueueRows("processing", emailId),
    countQueueRows("succeeded", emailId),
    countQueueRows("failed", emailId),
    countQueueRows("dead", emailId),
    countQueueRows("canceled", emailId),
    countQueueRows("pending", emailId, "due"),
    countQueueRows("pending", emailId, "held"),
  ]);

  let subject: string | null = null;
  let emailStatus: string | null = null;
  if (emailId) {
    const { data } = await supabase
      .from("emails")
      .select("subject, status")
      .eq("id", emailId)
      .maybeSingle();
    const row = data as { subject?: string | null; status?: string | null } | null;
    subject = row?.subject ?? null;
    emailStatus = row?.status ?? null;
  }

  const terminalFailures = failed + dead;
  const total = pending + processing + succeeded + failed + dead + canceled;
  const resolved = succeeded + failed + dead + canceled;
  const isDrained = total > 0 && pending === 0 && processing === 0;
  const displayStatus =
    total === 0
      ? emailStatus ?? "No queue rows"
      : pending > 0 || processing > 0
        ? "Sending"
        : succeeded > 0 && terminalFailures > 0
          ? "Complete with permanent failures"
          : succeeded > 0
            ? "Complete"
            : terminalFailures > 0
              ? "Failed"
              : canceled > 0
                ? "Canceled"
                : emailStatus ?? "Unknown";
  const statusDetail =
    total === 0
      ? "No queue rows exist for this email."
      : pending > 0 || processing > 0
        ? `${pending + processing} recipient${pending + processing === 1 ? "" : "s"} still waiting or sending.`
        : terminalFailures > 0
          ? `${succeeded.toLocaleString()} accepted by SES; ${terminalFailures.toLocaleString()} recipient${
              terminalFailures === 1 ? "" : "s"
            } permanently failed.`
          : `${succeeded.toLocaleString()} recipient${succeeded === 1 ? "" : "s"} accepted by SES.`;

  return {
    ok: true,
    emailId: emailId ?? null,
    subject,
    emailStatus,
    displayStatus,
    statusDetail,
    date: today,
    dailyCap: dailySendLimit,
    sentToday,
    remainingToday: Math.max(0, dailySendLimit - sentToday),
    total,
    resolved,
    terminalFailures,
    isDrained,
    pending,
    pendingDue,
    pendingHeld,
    processing,
    succeeded,
    failed,
    dead,
    canceled,
    recipientLog: emailId ? await loadRecipientLog(emailId) : [],
  };
}

export async function GET(request: Request) {
  if (!authCheck(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await buildMonitorSnapshot(optionalEmailId(request)));
  } catch (error) {
    const message = errorMessage(error, "Unable to load queue status");
    console.error("[send-monitor] snapshot error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!authCheck(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let emailId: string | undefined;
  try {
    const body = (await request.json()) as { emailId?: string };
    emailId = body.emailId;
  } catch {
    // No body is fine - run the global worker.
  }

  try {
    const result = await runQueueWorker(emailId ? { emailId } : {});
    return NextResponse.json(result);
  } catch (error) {
    const message = errorMessage(error, "Worker failed");
    console.error("[send-monitor] worker error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
