import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";
import { getQuotaUsageSnapshot, todayUTC } from "@/lib/dailyQuota";
import { getSesMaxSendRatePerSecond } from "@/lib/appSettings";
import { parseUuid } from "@/lib/ids";
import { isBlockedRecipientEmail } from "@/lib/blockList";
import { buildRecipientPersonalization, personalizeEmailContent } from "@/lib/personalization";
import { env } from "@/lib/env";
import type { Json } from "@/supabase/types";

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
  replyTo: z.string().min(1).max(320).optional(),
  to: z.string().min(1).max(320),
  toName: z.string().min(1).max(320).optional(),
  merge: z.record(z.string(), z.string()).optional(),
  subject: z.string().min(1).max(998).optional(),
  html: z.string().min(1).optional(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  campaigns: z.array(z.string()).optional(),
});

// 200 rows per invocation at the current SES rate. Lower SES rate settings
// automatically reduce this so a worker call stays inside Vercel's function
// window instead of timing out.
const WORKER_BATCH_SIZE = 200;
const WORKER_CONCURRENCY = 5; // must match emailProvider maxConnections
const WORKER_SEND_WINDOW_MS = 20_000;
const SES_RATE_SAFETY_FACTOR = 0.9;
const STUCK_PROCESSING_TTL_MS = 15 * 60 * 1000;
const GLOBAL_DRAIN_ELIGIBLE_EMAIL_STATUSES = ["queued", "sending", "sent"] as const;
const GLOBAL_DRAIN_HOLD_AT = "2999-12-31T23:59:59.000Z";

export type QueueWorkerResult = {
  ok: true;
  processed: number;
  succeeded: number;
  failed: number;
  reclaimed: number;
  sentToday: number;
  rolling24hSent: number;
  remaining: number;
  dailyCap: number;
  sesMaxSendRatePerSecond: number;
  effectiveSendRatePerSecond: number;
  message?: string;
};

type RunQueueWorkerOptions = {
  emailId?: string | null;
};

type EmailTemplate = {
  from_address: string;
  reply_to: string | null;
  subject: string;
  html: string;
  text: string | null;
  tags: string[] | null;
  campaigns: string[] | null;
};

type ClaimedQueueItem = {
  id: string;
  email_id: string | null;
  payload: unknown;
  list_id: string | null;
};

type QueueItemResult =
  | { outcome: "succeeded"; id: string; sesMessageId: string }
  | { outcome: "failed" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function effectiveSesSendRate(maxRatePerSecond: number): number {
  if (!Number.isFinite(maxRatePerSecond) || maxRatePerSecond <= 0) return 1;
  return Math.max(1, Math.floor(maxRatePerSecond * SES_RATE_SAFETY_FACTOR));
}

function workerClaimLimit(remainingQuota: number, effectiveRatePerSecond: number): number {
  const maxByFunctionWindow = Math.max(1, Math.floor(effectiveRatePerSecond * (WORKER_SEND_WINDOW_MS / 1000)));
  return Math.max(1, Math.min(remainingQuota, WORKER_BATCH_SIZE, maxByFunctionWindow));
}

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

async function reconcileEmailStatusesIfDrained(emailIds: string[]) {
  if (emailIds.length === 0) return;

  const supabase = getSupabaseAdmin();
  const uniqueIds = [...new Set(emailIds)];
  const { count, error } = await supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .in("email_id", uniqueIds)
    .in("status", ["pending", "processing"]);

  if (error) {
    console.error("[queue worker] drain check failed", error);
    return;
  }

  if ((count ?? 0) > 0) return;
  await reconcileEmailStatuses(uniqueIds);
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

function appendOpenTrackingPixel(html: string, queueId: string): string {
  const baseUrl = env.appBaseUrl.replace(/\/+$/, "");
  const trackingUrl = `${baseUrl}/api/email/open/${encodeURIComponent(queueId)}`;
  if (html.includes(trackingUrl)) return html;

  const pixel = `<img src="${trackingUrl}" width="1" height="1" alt="" style="border:0;width:1px;height:1px;display:block;opacity:0;" aria-hidden="true" />`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${pixel}</body>`);
  }

  return `${html}\n${pixel}`;
}

async function loadTemplates(emailIds: string[]) {
  if (emailIds.length === 0) return new Map<string, EmailTemplate>();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("emails")
    .select("id, from_address, reply_to, subject, html, text, tags, campaigns, status")
    .in("id", [...new Set(emailIds)])
    .in("status", GLOBAL_DRAIN_ELIGIBLE_EMAIL_STATUSES);

  if (error) throw new Error(error.message);

  return new Map(
    (data ?? []).map((row) => [
      row.id,
      {
        from_address: row.from_address,
        reply_to: row.reply_to ?? null,
        subject: row.subject,
        html: row.html,
        text: row.text ?? null,
        tags: row.tags ?? [],
        campaigns: row.campaigns ?? [],
      },
    ]),
  );
}

export async function runQueueWorker(options: RunQueueWorkerOptions): Promise<QueueWorkerResult> {
  const emailId = options.emailId == null ? null : parseUuid(options.emailId);
  if (options.emailId != null && !emailId) throw new Error("runQueueWorker requires a valid emailId.");
  const isGlobalRun = !emailId;

  const supabase = getSupabaseAdmin();
  const today = todayUTC();
  const now = new Date();
  const [quota, sesMaxSendRatePerSecond] = await Promise.all([
    getQuotaUsageSnapshot(now),
    getSesMaxSendRatePerSecond(),
  ]);
  const effectiveSendRatePerSecond = effectiveSesSendRate(sesMaxSendRatePerSecond);

  const staleLockedBefore = new Date(now.getTime() - STUCK_PROCESSING_TTL_MS).toISOString();
  let reclaimQuery = supabase
    .from("mail_queue")
    .update({
      status: "pending",
      locked_at: null,
      updated_at: now.toISOString(),
    })
    .eq("status", "processing")
    .lt("locked_at", staleLockedBefore);
  if (emailId) reclaimQuery = reclaimQuery.eq("email_id", emailId);
  const { data: reclaimed } = await reclaimQuery.select("id");

  const reclaimedCount = reclaimed?.length ?? 0;
  if (reclaimedCount > 0) {
    console.info(`[queue worker] reclaimed ${reclaimedCount} stuck processing row(s)`);
  }

  const remaining = quota.remainingRolling24h;

  if (remaining === 0) {
    await writeMetrics({ queueDepth: 0, processed: 0, failed: 0 });
    return {
      ok: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
      reclaimed: reclaimedCount,
      sentToday: quota.acceptedTodayUtc,
      rolling24hSent: quota.rolling24hSent,
      remaining,
      dailyCap: quota.dailyCap,
      sesMaxSendRatePerSecond,
      effectiveSendRatePerSecond,
      message: `SES rolling 24-hour cap of ${quota.dailyCap} reached. No sends this run.`,
    };
  }

  const limit = workerClaimLimit(remaining, effectiveSendRatePerSecond);

  const { data: items, error: fetchError } = await (
    supabase as unknown as {
      rpc(
        fn: "claim_mail_queue_batch",
        args: { p_limit: number; p_email_id: string | null; p_now: string },
      ): Promise<{ data: ClaimedQueueItem[] | null; error: { message: string } | null }>;
    }
  ).rpc("claim_mail_queue_batch", {
    p_limit: limit,
    p_email_id: emailId,
    p_now: now.toISOString(),
  });

  if (fetchError) throw new Error(fetchError.message);

  if (!items || items.length === 0) {
    if (emailId) await reconcileEmailStatuses([emailId]);

    let pendingQuery = supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    if (emailId) pendingQuery = pendingQuery.eq("email_id", emailId);
    const { count: pendingCount } = await pendingQuery;

    await writeMetrics({ queueDepth: pendingCount ?? 0, processed: 0, failed: 0 });
    return {
      ok: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
      reclaimed: reclaimedCount,
      sentToday: quota.acceptedTodayUtc,
      rolling24hSent: quota.rolling24hSent,
      remaining,
      dailyCap: quota.dailyCap,
      sesMaxSendRatePerSecond,
      effectiveSendRatePerSecond,
      message: isGlobalRun ? "No eligible pending items." : "No pending items.",
    };
  }

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

  async function skipIneligible(itemId: string, message: string) {
    await supabase
      .from("mail_queue")
      .update({
        status: "pending",
        available_at: GLOBAL_DRAIN_HOLD_AT,
        locked_at: null,
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId);
  }

  async function cancelBlocked(itemId: string, message: string) {
    await supabase
      .from("mail_queue")
      .update({
        status: "canceled",
        locked_at: null,
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId);
  }

  /**
   * Process one queue item: validate payload, send via SES, write result back.
   * Returns "succeeded" | "failed" so the caller can tally counts.
   *
   * We fan these out with Promise.allSettled in WORKER_CONCURRENCY-sized
   * windows below, then pace each window under the configured SES send rate.
   */
  async function processItem(item: ClaimedQueueItem): Promise<QueueItemResult> {
    const payloadParsed = MailQueuePayloadSchema.safeParse(item.payload);
    if (!payloadParsed.success) {
      console.error(`[queue worker] invalid payload for item ${item.id}:`, payloadParsed.error.issues);
      await markDead(item.id, `Invalid payload: ${payloadParsed.error.issues[0]?.message ?? "schema error"}`);
      return { outcome: "failed" };
    }

    const payload = payloadParsed.data;
    if (isBlockedRecipientEmail(payload.to)) {
      await cancelBlocked(item.id, "Canceled by global Block List domain rule.");
      return { outcome: "failed" };
    }

    if (!item.email_id) {
      await skipIneligible(item.id, "Skipped by global queue worker because the row has no email_id.");
      return { outcome: "failed" };
    }

    const template = item.email_id ? templates.get(item.email_id) : undefined;
    if (!template) {
      await skipIneligible(
        item.id,
        "Skipped by queue worker because the email is not queued, sending, or sent.",
      );
      return { outcome: "failed" };
    }

    const from = payload.from ?? template?.from_address;
    const replyTo = payload.replyTo ?? template?.reply_to ?? undefined;
    const subject = payload.subject ?? template?.subject;
    const html = payload.html ?? template?.html;
    const text = payload.text ?? template?.text ?? undefined;

    if (!from || !subject || !html) {
      await markDead(item.id, "Missing email template fields for queued item");
      return { outcome: "failed" };
    }

    const personalized = personalizeEmailContent(
      { subject, html, text },
      buildRecipientPersonalization({
        email: payload.to,
        displayName: payload.toName,
        mergeData: payload.merge,
      }),
    );

    try {
      const result = await sendEmail({
        from,
        replyTo,
        to: [formatRecipientAddress(payload.to, payload.toName)],
        subject: personalized.subject,
        html: appendOpenTrackingPixel(personalized.html, item.id),
        text: personalized.text,
        tags: payload.tags ?? template?.tags ?? undefined,
        campaigns: payload.campaigns ?? template?.campaigns ?? undefined,
      });

      if (!result.sesMessageId) {
        throw new Error("sendMail returned no message ID — treat as unconfirmed");
      }

      return { outcome: "succeeded", id: item.id, sesMessageId: result.sesMessageId };
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

      return { outcome: "failed" };
    }
  }

  // Fan out sends in WORKER_CONCURRENCY-sized windows. Pace against elapsed
  // batch time so SMTP/DB latency counts toward the SES send-rate budget.
  const batchStartedAt = Date.now();
  let attemptedSends = 0;
  for (let i = 0; i < items.length; i += WORKER_CONCURRENCY) {
    const window = items.slice(i, i + WORKER_CONCURRENCY);
    const results = await Promise.allSettled(window.map(processItem));
    const successfulRows = results.flatMap((result) =>
      result.status === "fulfilled" && result.value.outcome === "succeeded"
        ? [{ id: result.value.id, ses_message_id: result.value.sesMessageId }]
        : [],
    );

    if (successfulRows.length > 0) {
      const { data: applied, error: applyError } = await (
        supabase as unknown as {
          rpc(
            fn: "mark_mail_queue_succeeded_batch",
            args: { p_results: Json; p_send_date: string; p_updated_at: string },
          ): Promise<{ data: number | null; error: { message: string } | null }>;
        }
      ).rpc("mark_mail_queue_succeeded_batch", {
          p_results: successfulRows,
          p_send_date: today,
          p_updated_at: new Date().toISOString(),
        });
      if (applyError) throw new Error(`Unable to persist SES acceptances: ${applyError.message}`);
      if (applied !== successfulRows.length) {
        throw new Error(
          `Persisted ${applied ?? 0} of ${successfulRows.length} SES acceptances; stopping before another batch.`,
        );
      }
      succeeded += successfulRows.length;
    }

    for (const result of results) {
      if (result.status === "rejected" || result.value.outcome === "failed") failed++;
    }
    attemptedSends += window.length;
    if (i + WORKER_CONCURRENCY < items.length) {
      const targetElapsedMs = Math.ceil((attemptedSends / effectiveSendRatePerSecond) * 1000);
      const actualElapsedMs = Date.now() - batchStartedAt;
      const sleepMs = targetElapsedMs - actualElapsedMs;
      if (sleepMs > 0) await sleep(sleepMs);
    }
  }

  await writeMetrics({
    queueDepth: 0,
    processed: items.length,
    failed,
  });

  if (items.length < limit) {
    await reconcileEmailStatusesIfDrained(touchedEmailIds);
  }

  return {
    ok: true,
    processed: items.length,
    succeeded,
    failed,
    reclaimed: reclaimedCount,
    sentToday: quota.acceptedTodayUtc + succeeded,
    rolling24hSent: quota.rolling24hSent + succeeded,
    remaining: remaining - succeeded,
    dailyCap: quota.dailyCap,
    sesMaxSendRatePerSecond,
    effectiveSendRatePerSecond,
    message: isGlobalRun
      ? "Global drain processed eligible queued/sending/sent campaigns only."
      : undefined,
  };
}
