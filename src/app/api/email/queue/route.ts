/**
 * POST /api/email/queue
 *
 * Queue worker — triggered manually via triggerQueueAction on the Schedule page
 * ("⚡ Process Queue Now" button). No automatic cron is used.
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
import { getDailySentCount, DAILY_SEND_LIMIT, todayUTC } from "@/lib/dailyQuota";
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

  try {
    const result = await runQueueWorker();
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
  const remaining = Math.max(0, DAILY_SEND_LIMIT - sentToday);

  const supabase = getSupabaseAdmin();
  const { count: pendingCount } = await supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return NextResponse.json({
    date: today,
    sentToday,
    dailyCap: DAILY_SEND_LIMIT,
    remaining,
    pendingInQueue: pendingCount ?? 0,
  });
}
