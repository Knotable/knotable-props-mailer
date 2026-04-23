import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";
import { DAILY_SEND_LIMIT, getDailySentCount, todayUTC } from "@/lib/dailyQuota";

const MailQueuePayloadSchema = z.object({
  from: z.string().min(1).max(320),
  to: z.string().min(1).max(320),
  subject: z.string().min(1).max(998),
  html: z.string().min(1),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  campaigns: z.array(z.string()).optional(),
});

const WORKER_BATCH_SIZE = 50;
const STUCK_PROCESSING_TTL_MS = 15 * 60 * 1000;

export type QueueWorkerResult = {
  ok: true;
  processed: number;
  succeeded: number;
  failed: number;
  reclaimed: number;
  sentToday: number;
  remaining: number;
  dailyCap: number;
  message?: string;
};

type RunQueueWorkerOptions = {
  emailId?: string;
};

async function writeMetrics(opts: { queueDepth: number; processed: number; failed: number }) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("queue_metrics")
    .insert({
      queue_depth: opts.queueDepth,
      processed_count: opts.processed,
      failed_count: opts.failed,
      last_run_at: new Date().toISOString(),
    });

  if (error) {
    console.error("[queue worker] queue_metrics insert failed", error);
  }
}

async function reconcileEmailStatuses(emailIds: string[]) {
  if (emailIds.length === 0) return;

  const supabase = getSupabaseAdmin();
  const uniqueIds = [...new Set(emailIds)];
  const { data: rows, error } = await supabase
    .from("mail_queue")
    .select("email_id, status")
    .in("email_id", uniqueIds);

  if (error) {
    console.error("[queue worker] reconcile status query failed", error);
    return;
  }

  const byEmail = new Map<string, { pending: number; processing: number; dead: number; succeeded: number }>();
  for (const id of uniqueIds) {
    byEmail.set(id, { pending: 0, processing: 0, dead: 0, succeeded: 0 });
  }

  for (const row of rows ?? []) {
    if (!row.email_id) continue;
    const bucket = byEmail.get(row.email_id);
    if (!bucket) continue;
    if (row.status === "pending") bucket.pending += 1;
    if (row.status === "processing") bucket.processing += 1;
    if (row.status === "dead") bucket.dead += 1;
    if (row.status === "succeeded") bucket.succeeded += 1;
  }

  for (const [emailId, counts] of byEmail) {
    let status: "queued" | "sent" | "failed" | null = null;

    if (counts.pending > 0 || counts.processing > 0) {
      status = "queued";
    } else if (counts.dead > 0) {
      status = counts.succeeded > 0 ? "queued" : "failed";
    } else if (counts.succeeded > 0) {
      status = "sent";
    }

    if (!status) continue;
    const { error: updateError } = await supabase
      .from("emails")
      .update({ status })
      .eq("id", emailId);

    if (updateError) {
      console.error(`[queue worker] failed to update email ${emailId} status`, updateError);
    }
  }
}

export async function runQueueWorker(options: RunQueueWorkerOptions = {}): Promise<QueueWorkerResult> {
  const supabase = getSupabaseAdmin();
  const today = todayUTC();
  const now = new Date();

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

  const sentToday = await getDailySentCount(today);
  const remaining = Math.max(0, DAILY_SEND_LIMIT - sentToday);

  if (remaining === 0) {
    await writeMetrics({ queueDepth: 0, processed: 0, failed: 0 });
    return {
      ok: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
      reclaimed: reclaimedCount,
      sentToday,
      remaining,
      dailyCap: DAILY_SEND_LIMIT,
      message: `Daily cap of ${DAILY_SEND_LIMIT} reached. No sends this run.`,
    };
  }

  const limit = Math.min(remaining, WORKER_BATCH_SIZE);

  let fetchQuery = supabase
    .from("mail_queue")
    .select("id, email_id, payload, list_id")
    .eq("status", "pending")
    .lte("available_at", now.toISOString());

  if (options.emailId) {
    fetchQuery = fetchQuery.eq("email_id", options.emailId);
  }

  const { data: items, error: fetchError } = await fetchQuery
    .order("available_at", { ascending: true })
    .limit(limit);

  if (fetchError) {
    throw new Error(fetchError.message);
  }

  if (!items || items.length === 0) {
    const { count: pendingCount } = await supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");

    await writeMetrics({ queueDepth: pendingCount ?? 0, processed: 0, failed: 0 });
    return {
      ok: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
      reclaimed: reclaimedCount,
      sentToday,
      remaining,
      dailyCap: DAILY_SEND_LIMIT,
      message: "No pending items.",
    };
  }

  const ids = items.map((item) => item.id);
  await supabase
    .from("mail_queue")
    .update({ status: "processing", locked_at: now.toISOString() })
    .in("id", ids);

  let succeeded = 0;
  let failed = 0;
  const touchedEmailIds = items
    .map((item) => item.email_id)
    .filter((emailId): emailId is string => Boolean(emailId));

  for (const item of items) {
    const payloadParsed = MailQueuePayloadSchema.safeParse(item.payload);
    if (!payloadParsed.success) {
      console.error(`[queue worker] invalid payload for item ${item.id}:`, payloadParsed.error.issues);
      await supabase
        .from("mail_queue")
        .update({
          status: "dead",
          last_error: `Invalid payload: ${payloadParsed.error.issues[0]?.message ?? "schema error"}`,
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);
      failed++;
      continue;
    }

    const payload = payloadParsed.data;

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

  const { count: pendingAfter } = await supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  await writeMetrics({
    queueDepth: pendingAfter ?? 0,
    processed: items.length,
    failed,
  });

  await reconcileEmailStatuses(touchedEmailIds);

  return {
    ok: true,
    processed: items.length,
    succeeded,
    failed,
    reclaimed: reclaimedCount,
    sentToday: sentToday + succeeded,
    remaining: remaining - succeeded,
    dailyCap: DAILY_SEND_LIMIT,
  };
}
