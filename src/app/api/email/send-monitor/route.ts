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
import { QUOTA_WINDOW_HOURS, getMailerRuntimeLimits, todayUTC } from "@/lib/dailyQuota";
import { parseUuid } from "@/lib/ids";
import { effectiveSesSendRate, runQueueWorker } from "@/lib/queueWorker";

export const dynamic = "force-dynamic";

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

async function buildMonitorSnapshot(emailId?: string) {
  const supabase = getSupabaseAdmin();
  const today = todayUTC();
  const now = new Date();
  const nowIso = now.toISOString();

  if (!emailId) {
    const [runtime, { data: activeRows, error: activeError }] = await Promise.all([
      getMailerRuntimeLimits(null, now),
      supabase.rpc("get_global_active_queue_summary", { p_now: nowIso }),
    ]);
    if (activeError) throw activeError;
    const active = activeRows?.[0];
    const quota = runtime.quota;
    const sentLast7Days = runtime.sentLast7Days;
    const sesMaxSendRatePerSecond = runtime.sesMaxSendRatePerSecond;
    const pendingDue = Number(active?.pending_due ?? 0);
    const pendingHeld = Number(active?.pending_held ?? 0);
    const processing = Number(active?.processing ?? 0);
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

  const [runtime, { data: summaryRows, error: summaryError }, { data: emailData, error: emailError }] =
    await Promise.all([
      getMailerRuntimeLimits(emailId, now),
      supabase.rpc("get_queue_campaign_summaries", {
        p_email_ids: [emailId],
        p_now: nowIso,
      }),
      supabase.from("emails").select("subject, status").eq("id", emailId).maybeSingle(),
    ]);
  if (summaryError) throw summaryError;
  if (emailError) throw emailError;
  const counts = (summaryRows ?? []).reduce(
    (total, row) => ({
      pendingDue: total.pendingDue + Number(row.pending_due ?? 0),
      pendingHeld: total.pendingHeld + Number(row.pending_held ?? 0),
      processing: total.processing + Number(row.processing ?? 0),
      succeeded: total.succeeded + Number(row.succeeded ?? 0),
      failed: total.failed + Number(row.failed ?? 0),
      dead: total.dead + Number(row.dead ?? 0),
      canceled: total.canceled + Number(row.canceled ?? 0),
    }),
    { pendingDue: 0, pendingHeld: 0, processing: 0, succeeded: 0, failed: 0, dead: 0, canceled: 0 },
  );
  const quota = runtime.quota;
  const sentLast7Days = runtime.sentLast7Days;
  const sesMaxSendRatePerSecond = runtime.sesMaxSendRatePerSecond;
  const pendingDue = counts.pendingDue;
  const pendingHeld = counts.pendingHeld;
  const pending = pendingDue + pendingHeld;
  const processing = counts.processing;
  const succeeded = counts.succeeded;
  const failed = counts.failed;
  const dead = counts.dead;
  const canceled = counts.canceled;
  const effectiveSendRatePerSecond = effectiveSesSendRate(sesMaxSendRatePerSecond);

  const row = emailData as { subject?: string | null; status?: string | null } | null;
  const subject = row?.subject ?? null;
  const emailStatus = row?.status ?? null;

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
