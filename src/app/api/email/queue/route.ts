/**
 * POST /api/email/queue
 *
 * Queue worker — called by Vercel Cron daily at midnight UTC (vercel.json).
 * Can also be triggered manually via triggerQueueAction on the Schedule page.
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
import { sendEmail } from "@/lib/emailProvider";
import { getDailySentCount, DAILY_SEND_LIMIT, todayUTC } from "@/lib/dailyQuota";

const WORKER_BATCH_SIZE = 50;
// Rows stuck in "processing" longer than this are assumed abandoned (worker crash / timeout).
const STUCK_PROCESSING_TTL_MS = 15 * 60 * 1000;

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

  const supabase = getSupabaseAdmin();
  const today = todayUTC();
  const now = new Date();

  // ── 1. Reclaim stuck processing rows ─────────────────────────────────────
  // If a prior worker invocation crashed or was killed by Vercel's function
  // timeout, its rows remain in "processing" forever.  Reset any row that has
  // been locked for more than STUCK_PROCESSING_TTL_MS.
  const staleLockedBefore = new Date(now.getTime() - STUCK_PROCESSING_TTL_MS).toISOString();
  const { data: reclaimed } = await supabase
    .from("mail_queue")
    .update({
      status: "pending",
      locked_at: null,
      updated_at: now.toISOString(),
    })
    .eq("status", "processing")
    .lt("locked_at", staleLockedBefore)
    .select("id");

  const reclaimedCount = reclaimed?.length ?? 0;
  if (reclaimedCount > 0) {
    console.info(`[queue worker] reclaimed ${reclaimedCount} stuck processing row(s)`);
  }

  // ── 2. Check daily quota ──────────────────────────────────────────────────
  const sentToday = await getDailySentCount(today);
  const remaining = Math.max(0, DAILY_SEND_LIMIT - sentToday);

  if (remaining === 0) {
    await writeMetrics(supabase, { queueDepth: 0, processed: 0, failed: 0 });
    return NextResponse.json({
      ok: true,
      message: `Daily cap of ${DAILY_SEND_LIMIT} reached. No sends this run.`,
      sentToday,
      reclaimed: reclaimedCount,
    });
  }

  const limit = Math.min(remaining, WORKER_BATCH_SIZE);

  // ── 3. Claim a batch of pending items ─────────────────────────────────────
  // Select then immediately mark as "processing".  Two concurrent invocations
  // can race here — the second one will also update the same rows, but both
  // will attempt the send.  This is the best we can do without FOR UPDATE
  // SKIP LOCKED (not exposed by Supabase JS client).  The duplicate-send risk
  // is low given cron fires at most once daily; manual triggers should not
  // overlap since they're initiated by a single operator.
  const { data: items, error: fetchError } = await supabase
    .from("mail_queue")
    .select("id, email_id, payload, list_id")
    .eq("status", "pending")
    .lte("available_at", now.toISOString())
    .order("available_at", { ascending: true })
    .limit(limit);

  if (fetchError) {
    console.error("[queue worker] fetch error", fetchError);
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!items || items.length === 0) {
    const { count: pendingCount } = await supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    await writeMetrics(supabase, { queueDepth: pendingCount ?? 0, processed: 0, failed: 0 });
    return NextResponse.json({
      ok: true,
      message: "No pending items.",
      sentToday,
      remaining,
      reclaimed: reclaimedCount,
    });
  }

  const ids = items.map((i) => i.id);
  await supabase
    .from("mail_queue")
    .update({ status: "processing", locked_at: now.toISOString() })
    .in("id", ids);

  // ── 4. Send each item ─────────────────────────────────────────────────────
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

      if (!result.sesMessageId) {
        throw new Error("sendMail returned no message ID — treat as unconfirmed");
      }

      await supabase
        .from("mail_queue")
        .update({
          status: "succeeded",
          send_date: today,
          ses_message_id: result.sesMessageId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[queue worker] send failed for ${item.id}:`, message);

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
          available_at: isDead
            ? new Date().toISOString()
            : new Date(Date.now() + attempts * 10 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      failed++;
    }
  }

  // ── 5. Write queue metrics snapshot ──────────────────────────────────────
  const { count: pendingAfter } = await supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  await writeMetrics(supabase, {
    queueDepth: pendingAfter ?? 0,
    processed: items.length,
    failed,
  });

  return NextResponse.json({
    ok: true,
    processed: items.length,
    succeeded,
    failed,
    reclaimed: reclaimedCount,
    sentToday: sentToday + succeeded,
    remaining: remaining - succeeded,
    dailyCap: DAILY_SEND_LIMIT,
  });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeMetrics(supabase: any, opts: { queueDepth: number; processed: number; failed: number }) {
  await supabase
    .from("queue_metrics")
    .insert({
      queue_depth: opts.queueDepth,
      processed_count: opts.processed,
      failed_count: opts.failed,
      last_run_at: new Date().toISOString(),
    })
    .catch((e: unknown) => console.error("[queue worker] queue_metrics insert failed", e));
}
