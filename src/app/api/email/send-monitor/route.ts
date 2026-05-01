/**
 * GET /api/email/send-monitor
 *
 * Returns a live snapshot of the queue for the send-monitor page.
 * Called every ~31 seconds by the browser while a send is in progress.
 *
 * POST /api/email/send-monitor
 *
 * Fires the queue worker for a specific emailId (or all pending if omitted).
 * This is what the monitor page hits on each tick — it's the "keep it going"
 * mechanism while you have the page open.
 *
 * Auth: same CRON_SECRET bearer token as /api/email/queue, so this endpoint
 * can only be called by the monitor page (which reads the secret from the
 * environment on page load via a server component) or a legitimate cron.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailySentCount, DAILY_SEND_LIMIT, todayUTC } from "@/lib/dailyQuota";
import { runQueueWorker } from "@/lib/queueWorker";

function authCheck(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(request: Request) {
  if (!authCheck(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const today = todayUTC();
  const sentToday = await getDailySentCount(today);
  const remaining = Math.max(0, DAILY_SEND_LIMIT - sentToday);

  // Active sends: rows that are in flight right now
  const [
    { count: pending },
    { count: processing },
    { count: succeeded },
    { count: failed },
    { count: dead },
  ] = await Promise.all([
    supabase.from("mail_queue").select("id", { count: "exact", head: true }).eq("status", "pending").lte("available_at", new Date().toISOString()),
    supabase.from("mail_queue").select("id", { count: "exact", head: true }).eq("status", "processing"),
    supabase.from("mail_queue").select("id", { count: "exact", head: true }).eq("status", "succeeded").eq("send_date", today),
    supabase.from("mail_queue").select("id", { count: "exact", head: true }).eq("status", "failed"),
    supabase.from("mail_queue").select("id", { count: "exact", head: true }).eq("status", "dead"),
  ]);

  // Per-email breakdown of in-progress sends
  const { data: activeEmails } = await supabase
    .from("mail_queue")
    .select("email_id, status, emails(subject)")
    .in("status", ["pending", "processing"])
    .lte("available_at", new Date().toISOString())
    .limit(20);

  const emailSummary = new Map<string, { subject: string; pending: number; processing: number }>();
  for (const row of activeEmails ?? []) {
    if (!row.email_id) continue;
    const subject = (row.emails as { subject?: string } | null)?.subject ?? "(no subject)";
    const entry = emailSummary.get(row.email_id) ?? { subject, pending: 0, processing: 0 };
    if (row.status === "pending") entry.pending++;
    if (row.status === "processing") entry.processing++;
    emailSummary.set(row.email_id, entry);
  }

  return NextResponse.json({
    ok: true,
    date: today,
    sentToday,
    dailyCap: DAILY_SEND_LIMIT,
    remaining,
    queue: {
      pending: pending ?? 0,
      processing: processing ?? 0,
      succeededToday: succeeded ?? 0,
      failed: failed ?? 0,
      dead: dead ?? 0,
    },
    activeEmails: [...emailSummary.entries()].map(([id, v]) => ({ id, ...v })),
  });
}

export async function POST(request: Request) {
  if (!authCheck(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let emailId: string | undefined;
  try {
    const body = await request.json() as { emailId?: string };
    emailId = body.emailId;
  } catch {
    // No body is fine — run the global worker
  }

  try {
    const result = await runQueueWorker(emailId ? { emailId } : {});
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker failed";
    console.error("[send-monitor] worker error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
