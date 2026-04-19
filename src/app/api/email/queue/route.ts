/**
 * POST /api/email/queue
 *
 * Queue worker — called by Vercel Cron (e.g. every 5 minutes).
 * Processes pending mail_queue items up to the remaining daily quota.
 *
 * Vercel cron.json entry (see vercel.json at repo root):
 *   schedule: every 5 minutes
 *
 * The route is protected by a CRON_SECRET header check so only Vercel
 * (or an authorised caller) can trigger it.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";
import { getDailySentCount, DAILY_SEND_LIMIT, todayUTC } from "@/lib/dailyQuota";

// How many items to attempt in a single cron invocation.
const WORKER_BATCH_SIZE = 50;

export async function POST(request: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getSupabaseAdmin();
  const today = todayUTC();

  // ── Check daily quota ───────────────────────────────────────────────────────
  const sentToday = await getDailySentCount(today);
  const remaining = Math.max(0, DAILY_SEND_LIMIT - sentToday);

  if (remaining === 0) {
    return NextResponse.json({
      ok: true,
      message: `Daily cap of ${DAILY_SEND_LIMIT} reached. No sends this run.`,
      sentToday,
    });
  }

  const limit = Math.min(remaining, WORKER_BATCH_SIZE);

  // ── Claim a batch of pending items ──────────────────────────────────────────
  // Only pick items whose available_at is ≤ now (respects multi-day scheduling).
  const { data: items, error: fetchError } = await supabase
    .from("mail_queue")
    .select("id, email_id, payload, list_id")
    .eq("status", "pending")
    .lte("available_at", new Date().toISOString())
    .order("available_at", { ascending: true })
    .limit(limit);

  if (fetchError) {
    console.error("[queue worker] fetch error", fetchError);
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!items || items.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No pending items.",
      sentToday,
      remaining,
    });
  }

  // Mark them all as processing atomically to avoid double-sends.
  const ids = items.map((i) => i.id);
  await supabase
    .from("mail_queue")
    .update({ status: "processing", locked_at: new Date().toISOString() })
    .in("id", ids);

  // ── Send each item ──────────────────────────────────────────────────────────
  let succeeded = 0;
  let failed = 0;

  for (const item of items) {
    const payload = item.payload as {
      from: string;
      to: string;
      subject: string;
      html: string;
      text?: string;
      tags?: string[];
      campaigns?: string[];
    };

    try {
      const result = await sendEmail({
        from: payload.from,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        tags: payload.tags,
        campaigns: payload.campaigns,
      });

      await supabase
        .from("mail_queue")
        .update({
          status: "succeeded",
          send_date: today,
          ses_message_id: result.sesMessageId ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[queue worker] send failed for ${item.id}:`, message);

      // Increment attempts; move to dead if max_attempts exceeded.
      const { data: current } = await supabase
        .from("mail_queue")
        .select("attempts, max_attempts")
        .eq("id", item.id)
        .single();

      const attempts = (current?.attempts ?? 0) + 1;
      const isDead = attempts >= (current?.max_attempts ?? 5);

      await supabase
        .from("mail_queue")
        .update({
          status: isDead ? "dead" : "pending",
          attempts,
          last_error: message,
          locked_at: null,
          // Back off: retry after 10 min × attempt number.
          available_at: isDead
            ? new Date().toISOString()
            : new Date(Date.now() + attempts * 10 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      failed++;
    }
  }

  return NextResponse.json({
    ok: true,
    processed: items.length,
    succeeded,
    failed,
    sentToday: sentToday + succeeded,
    remaining: remaining - succeeded,
    dailyCap: DAILY_SEND_LIMIT,
  });
}

// GET: status check — returns today's quota usage.
export async function GET() {
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
