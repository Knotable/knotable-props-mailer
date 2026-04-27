/**
 * GET /api/email/report?emailId=<uuid>
 *
 * Returns a send-report summary for one email: queue outcome counts
 * (succeeded, dead, canceled, pending, etc.) plus SES delivery-event
 * counts (delivered, bounced, complained, opened, clicked).
 *
 * Also returns the first 100 unsent recipients — i.e. those whose queue
 * rows are in status 'canceled' or 'dead' — so you can quickly see who
 * to target in a re-send without having to diff the full list yourself.
 *
 * Auth: same CRON_SECRET Bearer token as /api/email/queue, so you can
 * call it from scripts or the check-queue-logs tool without a browser
 * session.
 *
 * Example:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     https://your-app.vercel.app/api/email/report?emailId=<uuid>
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[send-report] CRON_SECRET is not set");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return unauthorizedResponse();
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  const { searchParams } = new URL(request.url);
  const emailId = searchParams.get("emailId");
  if (!emailId || !/^[0-9a-f-]{36}$/i.test(emailId)) {
    return NextResponse.json({ error: "emailId (UUID) is required" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  // ── Pull the view row ─────────────────────────────────────────────────────
  const { data: report, error: reportError } = await supabase
    .from("email_send_report")
    .select("*")
    .eq("email_id", emailId)
    .maybeSingle();

  if (reportError) {
    console.error("[send-report] view query failed", reportError);
    return NextResponse.json({ error: reportError.message }, { status: 500 });
  }

  if (!report) {
    // Could be a real email with no queue rows yet, or an unknown ID.
    const { data: emailRow } = await supabase
      .from("emails")
      .select("id, subject, status")
      .eq("id", emailId)
      .maybeSingle();

    if (!emailRow) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    return NextResponse.json({
      emailId,
      subject: emailRow.subject,
      emailStatus: emailRow.status,
      report: null,
      message: "No queue rows found for this email — it may not have been queued yet.",
      unsentRecipients: [],
    });
  }

  // ── Email metadata ────────────────────────────────────────────────────────
  const { data: emailRow } = await supabase
    .from("emails")
    .select("subject, status, from_address, created_at")
    .eq("id", emailId)
    .maybeSingle();

  // ── Unsent recipients (canceled + dead, up to 100) ────────────────────────
  // "Unsent" means the row never reached SES successfully.
  // Callers can use this list to build a targeted re-send.
  const { data: unsentRows } = await supabase
    .from("mail_queue")
    .select("id, status, last_error, attempts, payload")
    .eq("email_id", emailId)
    .in("status", ["canceled", "dead"])
    .order("created_at", { ascending: true })
    .limit(100);

  const unsentRecipients = (unsentRows ?? []).map((row) => ({
    queueId: row.id,
    status: row.status,
    recipient: (row.payload as { to?: string } | null)?.to ?? null,
    attempts: row.attempts,
    lastError: row.last_error ?? null,
  }));

  // ── Compose response ──────────────────────────────────────────────────────
  return NextResponse.json({
    emailId,
    subject: emailRow?.subject ?? null,
    emailStatus: emailRow?.status ?? null,
    fromAddress: emailRow?.from_address ?? null,
    createdAt: emailRow?.created_at ?? null,

    // Queue outcome counts
    totalQueued: report.total_queued,
    succeeded: report.succeeded,
    dead: report.dead,
    permanentFailures: report.permanent_failures,
    pending: report.pending,
    processing: report.processing,
    canceled: report.canceled,

    // SES delivery event counts
    delivered: report.delivered,
    bounced: report.bounced,
    complained: report.complained,
    opened: report.opened,
    clicked: report.clicked,

    // Timeline
    firstQueuedAt: report.first_queued_at,
    lastUpdatedAt: report.last_updated_at,
    firstSendDate: report.first_send_date,
    lastSendDate: report.last_send_date,

    // First 100 unsent recipients for targeted re-send
    unsentRecipients,
    unsentRecipientsNote:
      Number(report.canceled) + Number(report.dead) > 100
        ? `Showing first 100 of ${Number(report.canceled) + Number(report.dead)} unsent recipients. Query mail_queue directly for the full set.`
        : null,
  });
}
