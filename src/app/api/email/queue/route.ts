/**
 * POST /api/email/queue
 *
 * Queue worker — manual/debug endpoint. No automatic cron is used.
 *
 * POST may include a specific emailId. Without one it drains due rows only for
 * campaigns whose parent email is queued, sending, or sent.
 *
 * Each invocation:
 *   1. Reclaims stuck "processing" rows (worker crash / timeout recovery).
 *   2. Checks the SES rolling 24-hour send quota.
 *   3. Claims a batch of pending items using locked_at as an optimistic lock.
 *   4. Sends each via SES SMTP.
 *   5. Updates row status: succeeded / back-to-pending with backoff / dead.
 *   6. Writes a queue_metrics snapshot.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { QUOTA_WINDOW_HOURS, getQuotaUsageSnapshot, todayUTC } from "@/lib/dailyQuota";
import { getSesMaxSendRatePerSecond } from "@/lib/appSettings";
import { parseUuid } from "@/lib/ids";
import { effectiveSesSendRate, runQueueWorker } from "@/lib/queueWorker";

export async function POST(request: Request) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // Fail loudly in production so misconfiguration is caught immediately.
    console.error("[queue worker] CRON_SECRET is not set — refusing request");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
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
    const message = error instanceof Error ? error.message : "Queue worker failed";
    console.error("[queue worker] fatal error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET: quota + queue status — same CRON_SECRET auth as POST
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = todayUTC();
  const [quota, sesMaxSendRatePerSecond] = await Promise.all([
    getQuotaUsageSnapshot(),
    getSesMaxSendRatePerSecond(),
  ]);
  const effectiveSendRatePerSecond = effectiveSesSendRate(sesMaxSendRatePerSecond);

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const [{ count: pendingCount }, { count: pendingDue }, { count: pendingHeld }, { count: processingCount }] =
    await Promise.all([
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .lte("available_at", nowIso),
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .gt("available_at", nowIso),
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "processing"),
    ]);

  return NextResponse.json({
    date: today,
    sentToday: quota.acceptedTodayUtc,
    acceptedTodayUtc: quota.acceptedTodayUtc,
    rolling24hSent: quota.rolling24hSent,
    dailyCap: quota.dailyCap,
    remaining: quota.remainingRolling24h,
    remainingRolling24h: quota.remainingRolling24h,
    quotaWindowHours: QUOTA_WINDOW_HOURS,
    sesMaxSendRatePerSecond,
    effectiveSendRatePerSecond,
    pendingInQueue: pendingCount ?? 0,
    pendingDue: pendingDue ?? 0,
    pendingHeld: pendingHeld ?? 0,
    processing: processingCount ?? 0,
  });
}
