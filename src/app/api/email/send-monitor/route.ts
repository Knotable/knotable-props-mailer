/**
 * GET /api/email/send-monitor
 *
 * Returns a live snapshot of the queue for the send-monitor page.
 * Called every ~31 seconds by the browser while a send is in progress.
 *
 * POST /api/email/send-monitor
 *
 * Fires the queue worker. When emailId is omitted it drains due rows only for
 * campaigns whose parent email is queued, sending, or sent.
 *
 * Auth: browser requests use the signed-in user session. GET requires any
 * account; POST requires can_send. CRON_SECRET bearer auth is still accepted
 * for manual/debug calls.
 */

import { NextResponse } from "next/server";
import { requireCanSendAuthContext, requireServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { QUOTA_WINDOW_HOURS, getQuotaUsageSnapshot, todayUTC } from "@/lib/dailyQuota";
import { getSesMaxSendRatePerSecond } from "@/lib/appSettings";
import { parseUuid } from "@/lib/ids";
import { effectiveSesSendRate, runQueueWorker } from "@/lib/queueWorker";

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

async function hasReadAccess(request: Request) {
  if (authCheck(request)) return true;
  try {
    await requireServerAuthContext();
    return true;
  } catch {
    return false;
  }
}

async function hasWorkerAccess(request: Request) {
  if (authCheck(request)) return true;
  try {
    await requireCanSendAuthContext();
    return true;
  } catch {
    return false;
  }
}

function optionalEmailId(request: Request): { emailId?: string; error?: string } {
  const raw = new URL(request.url).searchParams.get("emailId");
  if (!raw) return {};
  const emailId = parseUuid(raw);
  return emailId ? { emailId } : { error: "emailId must be a valid UUID" };
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = String(error.message ?? "").trim();
    if (message) return message;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : fallback;
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

async function countSucceededRows(emailId?: string, sendDateGte?: string) {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "succeeded");

  if (emailId) query = query.eq("email_id", emailId);
  if (sendDateGte) query = query.gte("send_date", sendDateGte);

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function countSucceededOnDate(date: string) {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("send_date", date)
    .eq("status", "succeeded");

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
  const last7Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (!emailId) {
    const [quota, sentLast7Days, sesMaxSendRatePerSecond, pendingDue, pendingHeld, processing] =
      await Promise.all([
        getQuotaUsageSnapshot(),
        countSucceededRows(undefined, last7Date),
        getSesMaxSendRatePerSecond(),
        countQueueRows("pending", undefined, "due"),
        countQueueRows("pending", undefined, "held"),
        countQueueRows("processing"),
      ]);
    const effectiveSendRatePerSecond = effectiveSesSendRate(sesMaxSendRatePerSecond);

    const pending = pendingDue + pendingHeld;
    const total = pending + processing;
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      emailId: null,
      subject: null,
      emailStatus: null,
      displayStatus: total > 0 ? "Sending" : "No active queue rows",
      statusDetail:
        total > 0
          ? `${(pending + processing).toLocaleString()} recipient${
              pending + processing === 1 ? "" : "s"
            } still waiting or sending.`
          : "No pending or processing queue rows.",
      date: today,
      dailyCap: quota.dailyCap,
      sentToday: quota.acceptedTodayUtc,
      acceptedTodayUtc: quota.acceptedTodayUtc,
      rolling24hSent: quota.rolling24hSent,
      sentLast7Days,
      sentAllTime: null,
      remainingToday: quota.remainingRolling24h,
      remainingRolling24h: quota.remainingRolling24h,
      quotaWindowHours: QUOTA_WINDOW_HOURS,
      sesMaxSendRatePerSecond,
      effectiveSendRatePerSecond,
      total,
      resolved: 0,
      terminalFailures: 0,
      isDrained: total === 0,
      pending,
      pendingDue,
      pendingHeld,
      processing,
      succeeded: 0,
      failed: 0,
      dead: 0,
      canceled: 0,
      recipientLog: [],
    };
  }

  const [
    quota,
    sentLast7Days,
    sesMaxSendRatePerSecond,
    pending,
    processing,
    succeeded,
    failed,
    dead,
    canceled,
    pendingDue,
    pendingHeld,
  ] = await Promise.all([
    getQuotaUsageSnapshot(),
    countSucceededRows(emailId, last7Date),
    getSesMaxSendRatePerSecond(),
    countQueueRows("pending", emailId),
    countQueueRows("processing", emailId),
    countQueueRows("succeeded", emailId),
    countQueueRows("failed", emailId),
    countQueueRows("dead", emailId),
    countQueueRows("canceled", emailId),
    countQueueRows("pending", emailId, "due"),
    countQueueRows("pending", emailId, "held"),
  ]);
  const effectiveSendRatePerSecond = effectiveSesSendRate(sesMaxSendRatePerSecond);

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
  const sentAllTime = succeeded;
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
    generatedAt: new Date().toISOString(),
    emailId: emailId ?? null,
    subject,
    emailStatus,
    displayStatus,
    statusDetail,
    date: today,
    dailyCap: quota.dailyCap,
    sentToday: quota.acceptedTodayUtc,
    acceptedTodayUtc: quota.acceptedTodayUtc,
    rolling24hSent: quota.rolling24hSent,
    sentLast7Days,
    sentAllTime,
    remainingToday: quota.remainingRolling24h,
    remainingRolling24h: quota.remainingRolling24h,
    quotaWindowHours: QUOTA_WINDOW_HOURS,
    sesMaxSendRatePerSecond,
    effectiveSendRatePerSecond,
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
    recipientLog: [],
  };
}

export async function GET(request: Request) {
  if (!(await hasReadAccess(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = optionalEmailId(request);
    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
    return NextResponse.json(await buildMonitorSnapshot(parsed.emailId), {
      headers: {
        "Cache-Control": "private, no-store, no-cache, max-age=0, must-revalidate",
        Expires: "0",
        Pragma: "no-cache",
      },
    });
  } catch (error) {
    const message = errorMessage(error, "Unable to load queue status");
    console.error("[send-monitor] snapshot error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await hasWorkerAccess(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let emailId: string | null | undefined;
  try {
    const body = (await request.json()) as { emailId?: unknown };
    if (body.emailId == null) {
      emailId = null;
    } else {
      emailId = parseUuid(body.emailId) ?? undefined;
    }
  } catch {
    emailId = null;
  }

  if (emailId === undefined) {
    return NextResponse.json(
      { error: "emailId must be a valid UUID when provided." },
      { status: 400 },
    );
  }

  try {
    const result = await runQueueWorker({ emailId });
    return NextResponse.json(result);
  } catch (error) {
    const message = errorMessage(error, "Worker failed");
    console.error("[send-monitor] worker error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
