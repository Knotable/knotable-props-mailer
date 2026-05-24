/**
 * POST /api/email/queue
 *
 * Queue worker — manual/debug endpoint. No automatic cron is used.
 *
 * POST requires a specific emailId. Global runs are intentionally rejected so a
 * broad API call cannot accidentally drain unrelated due rows.
 *
 * Each invocation:
 *   1. Reclaims stuck "processing" rows (worker crash / timeout recovery).
 *   2. Checks the daily send quota.
 *   3. Claims a batch of pending items using locked_at as an optimistic lock.
 *   4. Sends each via SES SMTP.
 *   5. Updates row status: succeeded / back-to-pending with backoff / dead.
 *   6. Writes a queue_metrics snapshot.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailySentCount, todayUTC } from "@/lib/dailyQuota";
import { getDailySendLimit } from "@/lib/appSettings";
import { parseUuid } from "@/lib/ids";
import { runQueueWorker } from "@/lib/queueWorker";

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

  let emailId: string | null = null;
  try {
    const body = (await request.json()) as { emailId?: unknown };
    emailId = parseUuid(body.emailId);
  } catch {
    // Handled below.
  }

  if (!emailId) {
    return NextResponse.json(
      { error: "emailId is required. Global queue worker runs are disabled for operator safety." },
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
  const sentToday = await getDailySentCount(today);
  const dailySendLimit = await getDailySendLimit();
  const remaining = Math.max(0, dailySendLimit - sentToday);

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
    sentToday,
    dailyCap: dailySendLimit,
    remaining,
    pendingInQueue: pendingCount ?? 0,
    pendingDue: pendingDue ?? 0,
    pendingHeld: pendingHeld ?? 0,
    processing: processingCount ?? 0,
  });
}
