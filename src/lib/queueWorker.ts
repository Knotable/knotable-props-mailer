import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";
import { DAILY_SEND_LIMIT, getDailySentCount, todayUTC } from "@/lib/dailyQuota";

/**
 * Extract the SMTP numeric response code from a nodemailer error.
 *
 * nodemailer attaches `responseCode` (number) and/or `response` (string
 * like "550 5.1.1 The email account does not exist") to SMTP errors.
 * We fall back to scanning the message string for a leading 3-digit code.
 */
function smtpResponseCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const err = error as Record<string, unknown>;
  if (typeof err["responseCode"] === "number") return err["responseCode"];
  // nodemailer sometimes puts the code in `response`
  const response = typeof err["response"] === "string" ? err["response"] : null;
  if (response) {
    const match = response.match(/^(\d{3})\b/);
    if (match) return parseInt(match[1], 10);
  }
  // Last resort: scan the message itself
  const msg = typeof err["message"] === "string" ? err["message"] : null;
  if (msg) {
    const match = msg.match(/\b(5\d{2}|4\d{2})\b/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Returns true for SMTP 5xx codes that indicate a permanent, unrecoverable
 * failure for this specific recipient — no point retrying.
 *
 * Common permanent SES codes:
 *   550  Mailbox does not exist / policy rejection
 *   551  User not local
 *   552  Mailbox full (treat as permanent — SES uses this for suppressed addresses)
 *   553  Mailbox name invalid
 *   554  Transaction failed / message rejected (SES reputation block)
 *
 * We do NOT treat 421 / 450 / 451 / 452 (transient) as permanent.
 */
function isPermanentSmtpFailure(error: unknown): boolean {
  const code = smtpResponseCode(error);
  if (code === null) return false;
  // 550–554 are universally permanent; 552 is debatable but SES uses it for
  // suppression list hits which we should treat as permanent.
  return code >= 550 && code <= 554;
}

const MailQueuePayloadSchema = z.object({
  from: z.string().min(1).max(320).optional(),
  to: z.string().min(1).max(320),
  toName: z.string().min(1).max(320).optional(),
  subject: z.string().min(1).max(998).optional(),
  html: z.string().min(1).optional(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  campaigns: z.array(z.string()).optional(),
});

// 200 rows per invocation. With 5 nodemailer pool connections sending in
// parallel (Promise.allSettled below), we sustain ~14 msgs/sec — the SES
// SMTP rate limit. 200 items ÷ 14/sec ≈ 14 seconds, well within the 30s
// monitor loop and Vercel's 30s hobby / 60s pro function timeout.
const WORKER_BATCH_SIZE = 200;
const WORKER_CONCURRENCY = 5; // must match emailProvider maxConnections
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

type EmailTemplate = {
  from_address: string;
  subject: string;
  html: string;
  text: string | null;
  tags: string[] | null;
  campaigns: string[] | null;
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

  const byEmail = new Map<
    string,
    { pending: number; processing: number; failed: number; dead: number; succeeded: number; canceled: number }
  >();
  for (const id of uniqueIds) {
    byEmail.set(id, { pending: 0, processing: 0, failed: 0, dead: 0, succeeded: 0, canceled: 0 });
  }

  for (const row of rows ?? []) {
    if (!row.email_id) continue;
    const bucket = byEmail.get(row.email_id);
    if (!bucket) continue;
    if (row.status === "pending") bucket.pending += 1;
    if (row.status === "processing") bucket.processing += 1;
    if (row.status === "failed") bucket.failed += 1;
    if (row.status === "dead") bucket.dead += 1;
    if (row.status === "succeeded") bucket.succeeded += 1;
    if (row.status === "canceled") bucket.canceled += 1;
  }

  for (const [emailId, counts] of byEmail) {
    let status: "queued" | "sent" | "failed" | null = null;

    if (counts.pending > 0 || counts.processing > 0) {
      // Still work in flight — keep as queued regardless of other statuses.
      status = "queued";
    } else if (counts.succeeded > 0) {
      // The campaign drained. Permanent recipient failures remain visible on
      // mail_queue rows, but they should not make the whole campaign look stuck.
      status = "sent";
    } else if (counts.failed > 0 || counts.dead > 0) {
      // Nothing was accepted by SES and all remaining rows are terminal.
      status = "failed";
    }
    // If only canceled rows remain (pure cancel before any sends), skip —
    // cancelEmailAction already set emails.status = 'draft'.

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

function formatRecipientAddress(email: string, displayName: string | undefined): string {
  const name = displayName
    ?.replace(/[\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) return email;

  const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escapedName}" <${email}>`;
}

async function loadTemplates(emailIds: string[]) {
  if (emailIds.length === 0) return new Map<string, EmailTemplate>();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("emails")
    .select("id, from_address, subject, html, text, tags, campaigns")
    .in("id", [...new Set(emailIds)]);

  if (error) throw new Error(error.message);

  return new Map(
    (data ?? []).map((row) => [
      row.id,
      {
        from_address: row.from_address,
        subject: row.subject,
        html: row.html,
        text: row.text ?? null,
        tags: row.tags ?? [],
        campaigns: row.campaigns ?? [],
      },
    ]),
  );
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

  if (fetchError) throw new Error(fetchError.message);

  if (!items || items.length === 0) {
    if (options.emailId) {
      await reconcileEmailStatuses([options.emailId]);
    }

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

  const touchedEmailIds = items
    .map((item) => item.email_id)
    .filter((emailId): emailId is string => Boolean(emailId));
  const templates = await loadTemplates(touchedEmailIds);

  let succeeded = 0;
  let failed = 0;

  async function markDead(itemId: string, message: string) {
    await supabase
      .from("mail_queue")
      .update({
        status: "dead",
        last_error: message,
        locked_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId);
  }

  /**
   * Process one queue item: validate payload, send via SES, write result back.
   * Returns "succeeded" | "failed" so the caller can tally counts.
   *
   * We fan these out with Promise.allSettled in WORKER_CONCURRENCY-sized
   * windows below, saturating the nodemailer connection pool at ~14 msg/sec.
   */
  async function processItem(item: (typeof items)[number]): Promise<"succeeded" | "failed"> {
    const payloadParsed = MailQueuePayloadSchema.safeParse(item.payload);
    if (!payloadParsed.success) {
      console.error(`[queue worker] invalid payload for item ${item.id}:`, payloadParsed.error.issues);
      await markDead(item.id, `Invalid payload: ${payloadParsed.error.issues[0]?.message ?? "schema error"}`);
      return "failed";
    }

    const payload = payloadParsed.data;
    const template = item.email_id ? templates.get(item.email_id) : undefined;
    const from = payload.from ?? template?.from_address;
    const subject = payload.subject ?? template?.subject;
    const html = payload.html ?? template?.html;
    const text = payload.text ?? template?.text ?? undefined;

    if (!from || !subject || !html) {
      await markDead(item.id, "Missing email template fields for queued item");
      return "failed";
    }

    try {
      const result = await sendEmail({
        from,
        to: [formatRecipientAddress(payload.to, payload.toName)],
        subject,
        html,
        text,
        tags: payload.tags ?? template?.tags ?? undefined,
        campaigns: payload.campaigns ?? template?.campaigns ?? undefined,
      });

      if (!result.sesMessageId) {
        throw new Error("sendMail returned no message ID — treat as unconfirmed");
      }

      // TODO: ses_message_id column does not yet exist in mail_queue.
      // Migration needed: ALTER TABLE mail_queue ADD COLUMN ses_message_id text;
      //                   CREATE INDEX ON mail_queue(ses_message_id);
      // Until then, Supabase silently ignores the unknown field.
      // Once added, this links SES delivery/bounce webhooks back to queue rows.
      await supabase
        .from("mail_queue")
        .update({
          status: "succeeded",
          send_date: today,
          ses_message_id: result.sesMessageId,
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      return "succeeded";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = smtpResponseCode(error);
      const permanent = isPermanentSmtpFailure(error);
      console.error(
        `[queue worker] send failed for ${item.id} (smtp=${code ?? "unknown"}, permanent=${permanent}):`,
        message,
      );

      if (permanent) {
        // Dead-letter immediately — retrying a permanent SMTP failure wastes
        // quota and contributes to SES reputation degradation.
        await supabase
          .from("mail_queue")
          .update({
            status: "dead",
            attempts: 999, // sentinel: indicates permanent failure, not retry exhaustion
            last_error: `Permanent SMTP ${code}: ${message}`,
            locked_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.id);
      } else {
        // Transient failure — exponential backoff up to max_attempts.
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
      }

      return "failed";
    }
  }

  // Fan out sends in WORKER_CONCURRENCY-sized windows.
  // This saturates the nodemailer pool (maxConnections=5) without overwhelming
  // it, and lets us hit the 14 msg/sec SES SMTP rate limit.
  for (let i = 0; i < items.length; i += WORKER_CONCURRENCY) {
    const window = items.slice(i, i + WORKER_CONCURRENCY);
    const results = await Promise.allSettled(window.map(processItem));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value === "succeeded") succeeded++;
      else failed++;
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
