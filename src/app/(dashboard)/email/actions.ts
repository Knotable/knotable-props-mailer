'use server';

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";
import { getDailySentCount, buildSendSchedule, todayUTC } from "@/lib/dailyQuota";
import { logAudit } from "@/lib/logger";
import { runQueueWorker } from "@/lib/queueWorker";
import type { Json } from "@/supabase/types";

const SaveDraftSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  from: z.string().min(1).max(320),
  subject: z.string().min(1).max(998),
  html: z.string().min(1).max(5_000_000),
  recipients: z.string().max(200_000),
  scheduledAt: z.string().max(32).optional().nullable(),
  campaigns: z.string().max(2000).optional().nullable(),
  tags: z.string().max(2000).optional().nullable(),
});

const QueueCampaignSchema = z.object({
  emailId: z.string().uuid(),
  listId: z.string().uuid(),
  skipDuplicateCheck: z.string().optional(),
});

const SendTestSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  from: z.string().min(1).max(320),
  subject: z.string().min(1).max(998),
  html: z.string().min(1).max(5_000_000),
  recipients: z.string().min(1).max(200_000),
  text: z.string().max(5_000_000).optional().nullable(),
  tags: z.string().max(2000).optional().nullable(),
  campaigns: z.string().max(2000).optional().nullable(),
});

const EmailIdSchema = z.object({ id: z.string().uuid() });
const RequeueDeadSchema = z.object({ emailId: z.string().uuid() });

// Throws if there is no authenticated session — middleware should have already
// caught unauthenticated requests, but this is a second line of defence for
// direct server-action calls.
async function requireAuthUserId(): Promise<string> {
  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");
  return auth.userId;
}

type DraftPayload = {
  from: string;
  subject: string;
  html: string;
  recipients: string;
  scheduledAt?: string;
  campaigns?: string;
  tags?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const parseRecipients = (input: string) =>
  input
    .split(/[,\n]/)
    .map((r) => r.trim())
    .filter((r) => EMAIL_RE.test(r));

const normalizeScheduledAt = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export async function saveDraftAction(formData: FormData) {
  const userId = await requireAuthUserId();

  const parsed = SaveDraftSchema.safeParse({
    id: formData.get("id") || null,
    from: formData.get("from"),
    subject: formData.get("subject"),
    html: formData.get("html"),
    recipients: formData.get("recipients") ?? "",
    scheduledAt: formData.get("scheduledAt") || null,
    campaigns: formData.get("campaigns") || null,
    tags: formData.get("tags") || null,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

  const id = parsed.data.id ?? null;
  const payload: DraftPayload = {
    from: parsed.data.from,
    subject: parsed.data.subject,
    html: parsed.data.html,
    recipients: parsed.data.recipients,
    scheduledAt: parsed.data.scheduledAt ?? undefined,
    campaigns: parsed.data.campaigns ?? undefined,
    tags: parsed.data.tags ?? undefined,
  };

  const supabase = getSupabaseAdmin();

  const emailFields = {
    from_address: payload.from,
    subject: payload.subject,
    html: payload.html,
    text: payload.html.replace(/<[^>]+>/g, " "),
    status: "draft" as const,
    scheduled_at: normalizeScheduledAt(payload.scheduledAt),
    campaigns: payload.campaigns?.split(",").map((c) => c.trim()).filter(Boolean) ?? [],
    tags: payload.tags?.split(",").map((t) => t.trim()).filter(Boolean) ?? [],
  };

  let emailId: string;

  if (id) {
    const { error } = await supabase
      .from("emails")
      .update(emailFields)
      .eq("id", id)
      .eq("author_id", userId);
    if (error) throw error;
    emailId = id;

    // Snapshot existing recipients before deleting so we can roll back on
    // insert failure — avoids leaving the draft with no recipients.
    const { data: existing } = await supabase
      .from("email_recipients")
      .select("recipient_address, status, metadata")
      .eq("email_id", emailId);

    const { error: delError } = await supabase
      .from("email_recipients")
      .delete()
      .eq("email_id", emailId);
    if (delError) throw delError;

    const recipientRows = parseRecipients(payload.recipients).map((addr) => ({
      email_id: emailId,
      recipient_address: addr,
    }));

    if (recipientRows.length) {
      const { error: recipientError } = await supabase
        .from("email_recipients")
        .insert(recipientRows);

      if (recipientError) {
        // Rollback: restore the recipients that were there before.
        if (existing && existing.length > 0) {
          const rollback = existing.map((r) => ({
            email_id: emailId,
            recipient_address: r.recipient_address,
            status: r.status,
            metadata: r.metadata,
          }));
          await supabase.from("email_recipients").insert(rollback).catch(console.error);
        }
        throw recipientError;
      }
    }
  } else {
    const { data: emailRow, error } = await supabase
      .from("emails")
      .insert({ author_id: userId, ...emailFields })
      .select("id")
      .single();
    if (error) throw error;
    emailId = emailRow.id;

    const recipientRows = parseRecipients(payload.recipients).map((addr) => ({
      email_id: emailId,
      recipient_address: addr,
    }));

    if (recipientRows.length) {
      const { error: recipientError } = await supabase
        .from("email_recipients")
        .insert(recipientRows);
      if (recipientError) throw recipientError;
    }
  }

  logAudit({
    userId,
    action: id ? "draft.update" : "draft.create",
    entity: "emails",
    entityId: emailId,
    payload: { subject: payload.subject },
  }).catch(console.error);

  revalidatePath("/email/schedule");
  revalidatePath("/email/composer");
  return { id: emailId };
}

// ── Return types for queueCampaignAction ───────────────────────────────────
// ok:true  — campaign was queued successfully
// ok:false — pre-flight check found duplicates or recent sends; caller must
//            confirm before proceeding (pass skipDuplicateCheck=true)
export type QueueCampaignOk = {
  ok: true;
  totalRecipients: number;
  daysNeeded: number;
  schedule: { date: string; count: number }[];
};
export type QueueCampaignConfirm = {
  ok: false;
  requiresConfirmation: true;
  // > 0  →  this exact email was already succeeded-sent to some of these people
  duplicateCount: number;
  // > 0  →  *any* email was sent to this list in the last 30 days
  recentlySentCount: number;
  sampleAddresses: string[];  // up to 8 examples of duplicated addresses
  listName?: string;
};
export type QueueCampaignResult = QueueCampaignOk | QueueCampaignConfirm;

/**
 * Queue a campaign send to a mailing list, automatically splitting across
 * multiple days if the list is larger than the 45k daily cap.
 *
 * Pre-flight duplicate check (skipped when skipDuplicateCheck=true):
 *  1. Blocks if this exact email_id was already sent succeeded to any member
 *     of this list — catches accidental re-sends of the same draft.
 *  2. Warns if any email was sent to this list in the last 30 days — surface
 *     recent contact so the operator can decide intentionally.
 * Returns QueueCampaignConfirm (ok:false) instead of throwing, so the UI can
 * show the count + sample and ask for explicit authorization.
 *
 * Honors the email's scheduled_at if it's in the future.
 * Idempotent: throws if pending/processing rows already exist for this email.
 */
export async function queueCampaignAction(formData: FormData): Promise<QueueCampaignResult> {
  const userId = await requireAuthUserId();

  const parsed = QueueCampaignSchema.safeParse({
    emailId: formData.get("emailId"),
    listId: formData.get("listId"),
    skipDuplicateCheck: formData.get("skipDuplicateCheck") ?? undefined,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

  const supabase = getSupabaseAdmin();
  const { emailId, listId } = parsed.data;
  const skipDuplicateCheck = parsed.data.skipDuplicateCheck === "true";

  // Load the email draft — also verify ownership so one user can't queue
  // another user's draft (defense-in-depth; RLS covers the DB layer).
  const { data: email, error: emailError } = await supabase
    .from("emails")
    .select("from_address, subject, html, text, tags, campaigns, scheduled_at")
    .eq("id", emailId)
    .eq("author_id", userId)
    .single();
  if (emailError || !email) throw new Error("Email draft not found");

  // Hard guard: can't queue if a run is already in flight.
  const { count: existingCount } = await supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("email_id", emailId)
    .in("status", ["pending", "processing"]);

  if (existingCount && existingCount > 0) {
    throw new Error(
      `This email already has ${existingCount} pending queue item(s). ` +
      "Cancel the existing campaign before re-queuing.",
    );
  }

  // ── Pre-flight duplicate / recent-contact check ─────────────────────────
  if (!skipDuplicateCheck) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Check 1 (hard): same email already sent to someone on this list, ever.
    const { count: duplicateCount } = await supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", emailId)
      .eq("list_id", listId)
      .eq("status", "succeeded");

    // Check 2 (soft): any email sent to this list in the last 30 days.
    const { count: recentlySentCount } = await supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("list_id", listId)
      .eq("status", "succeeded")
      .gte("created_at", thirtyDaysAgo);

    if ((duplicateCount ?? 0) > 0 || (recentlySentCount ?? 0) > 0) {
      // Fetch a sample of addresses that would be duplicated.
      let sampleAddresses: string[] = [];
      if ((duplicateCount ?? 0) > 0) {
        const { data: sampleRows } = await supabase
          .from("mail_queue")
          .select("payload")
          .eq("email_id", emailId)
          .eq("list_id", listId)
          .eq("status", "succeeded")
          .limit(8);
        sampleAddresses = (sampleRows ?? [])
          .map((r) => (r.payload as { to?: string })?.to ?? "")
          .filter(Boolean);
      }

      // Fetch the list name for the confirmation dialog.
      const { data: listRow } = await supabase
        .from("lists")
        .select("name")
        .eq("id", listId)
        .maybeSingle();

      logAudit({
        userId,
        action: "campaign.duplicate_check_triggered",
        entity: "emails",
        entityId: emailId,
        payload: { listId, duplicateCount, recentlySentCount },
      }).catch(console.error);

      return {
        ok: false,
        requiresConfirmation: true,
        duplicateCount: duplicateCount ?? 0,
        recentlySentCount: recentlySentCount ?? 0,
        sampleAddresses,
        listName: listRow?.name,
      };
    }
  }

  // Load active list members — paginate to bypass PostgREST's 1000-row default cap.
  const PAGE = 1000;
  const members: { email: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: memberPage, error: pageError } = await supabase
      .from("list_members")
      .select("email")
      .eq("list_id", listId)
      .eq("status", "active")
      .range(from, from + PAGE - 1);
    if (pageError) throw pageError;
    if (!memberPage || memberPage.length === 0) break;
    members.push(...memberPage);
    if (memberPage.length < PAGE) break;
  }
  if (members.length === 0) throw new Error("List has no active members");

  // Determine the start date, respecting scheduled_at if it's in the future.
  const today = todayUTC();
  const scheduledDate = email.scheduled_at
    ? email.scheduled_at.slice(0, 10)
    : null;
  const startDate = scheduledDate && scheduledDate > today ? scheduledDate : today;

  // For a future start date today's already-sent count is irrelevant (0).
  const alreadySentOnStartDate = startDate === today ? await getDailySentCount(today) : 0;
  const schedule = buildSendSchedule(members.length, alreadySentOnStartDate, startDate);
  const campaignLabel = `${emailId}:${startDate}`;

  // Build mail_queue rows, assigning each recipient to the right calendar day.
  const queueRows: {
    email_id: string;
    list_id: string;
    payload: Json;
    status: "pending";
    available_at: string;
    send_date: string | null;
    campaign_label: string;
  }[] = [];

  let memberIndex = 0;
  for (const slot of schedule) {
    let availableAt: string;

    if (slot.date === today) {
      // Today's batch: send now, but if a specific time was scheduled use that.
      if (email.scheduled_at && email.scheduled_at > new Date().toISOString()) {
        availableAt = email.scheduled_at;
      } else {
        availableAt = new Date().toISOString();
      }
    } else if (slot.date === scheduledDate && email.scheduled_at) {
      // First day of a future campaign: honor the scheduled time.
      availableAt = email.scheduled_at;
    } else {
      // Subsequent days: midnight + 5 min UTC.
      availableAt = `${slot.date}T00:05:00.000Z`;
    }

    for (let i = 0; i < slot.count; i++) {
      const member = members[memberIndex++];
      queueRows.push({
        email_id: emailId,
        list_id: listId,
        payload: {
          from: email.from_address,
          to: member.email,
          subject: email.subject,
          html: email.html,
          text: email.text ?? undefined,
          tags: email.tags ?? [],
          campaigns: email.campaigns ?? [],
        },
        status: "pending",
        available_at: availableAt,
        send_date: null,
        campaign_label: campaignLabel,
      });
    }
  }

  // Upsert in batches of 500 to stay within Supabase payload limits.
  const CHUNK = 500;
  for (let i = 0; i < queueRows.length; i += CHUNK) {
    const { error } = await supabase
      .from("mail_queue")
      .insert(queueRows.slice(i, i + CHUNK));
    if (error) throw error;
  }

  await supabase
    .from("emails")
    .update({ status: "queued" })
    .eq("id", emailId);

  logAudit({
    userId,
    action: "campaign.queued",
    entity: "emails",
    entityId: emailId,
    payload: {
      listId,
      totalRecipients: members.length,
      daysNeeded: schedule.length,
      startDate,
    },
  }).catch(console.error);

  revalidatePath("/email/schedule");

  return {
    ok: true as const,
    totalRecipients: members.length,
    daysNeeded: schedule.length,
    schedule: schedule.map((s) => ({ date: s.date, count: s.count })),
  };
}

export async function sendTestAction(formData: FormData) {
  const userId = await requireAuthUserId();

  const parsed = SendTestSchema.safeParse({
    id: formData.get("id") || null,
    from: formData.get("from"),
    subject: formData.get("subject"),
    html: formData.get("html"),
    recipients: formData.get("recipients"),
    text: formData.get("text") || null,
    tags: formData.get("tags") || null,
    campaigns: formData.get("campaigns") || null,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

  const id = parsed.data.id ?? null;
  const from = parsed.data.from;
  const subject = parsed.data.subject;
  const html = parsed.data.html;
  const text = parsed.data.text ?? undefined;
  const tags = parsed.data.tags?.split(",").map((t) => t.trim()).filter(Boolean);
  const campaigns = parsed.data.campaigns?.split(",").map((c) => c.trim()).filter(Boolean);

  const recipients = parseRecipients(parsed.data.recipients);
  if (!recipients.length) throw new Error("Need at least one valid recipient email address");

  // Send individually so recipients never see each other.
  const results = await Promise.allSettled(
    recipients.map(async (recipient) => {
      const result = await sendEmail({ from, to: [recipient], subject, html, text, tags, campaigns, testMode: true });
      return { recipient, sesMessageId: result.sesMessageId };
    })
  );

  const succeeded = results.filter(
    (r): r is PromiseFulfilledResult<{ recipient: string; sesMessageId: string | null }> =>
      r.status === "fulfilled",
  );
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  // Log successful sends to mail_queue so they appear in Past Sends.
  if (id && succeeded.length > 0) {
    const supabase = getSupabaseAdmin();
    const today = todayUTC();
    const queueRows = succeeded.map(({ value }) => ({
      email_id: id,
      list_id: null as string | null,
      payload: { from, to: value.recipient, subject } as Json,
      status: "succeeded" as const,
      available_at: new Date().toISOString(),
      send_date: today,
      ses_message_id: value.sesMessageId ?? null,
      campaign_label: `test:${id}:${today}`,
    }));
    const { error: qErr } = await supabase.from("mail_queue").insert(queueRows);
    if (qErr) console.error("[sendTestAction] mail_queue insert error", qErr);
  }

  // Check failures BEFORE updating email status — only mark sent when all succeed.
  if (failed.length > 0) {
    const firstMsg = failed[0].reason instanceof Error
      ? failed[0].reason.message
      : String(failed[0].reason);
    throw new Error(
      failed.length === recipients.length
        ? `Send failed: ${firstMsg}`
        : `${succeeded.length} sent, ${failed.length} failed — ${firstMsg}`,
    );
  }

  // All succeeded — mark the draft as sent.
  if (id) {
    const supabase = getSupabaseAdmin();
    await supabase.from("emails").update({ status: "sent" }).eq("id", id);
    revalidatePath("/email/sends");

    logAudit({
      userId,
      action: "email.test_sent",
      entity: "emails",
      entityId: id,
      payload: { recipients, sent: succeeded.length },
    }).catch(console.error);
  }

  return { sent: succeeded.length };
}

// ── Manually trigger the queue worker ───────────────────────────────────────
export async function triggerQueueAction(): Promise<{ processed: number; succeeded: number; failed: number; message: string }> {
  await requireAuthUserId();
  const data = await runQueueWorker();
  revalidatePath("/email/schedule");
  revalidatePath("/email/sends");
  return {
    processed: data.processed ?? 0,
    succeeded: data.succeeded ?? 0,
    failed: data.failed ?? 0,
    message: data.message ?? `Processed ${data.processed ?? 0} items`,
  };
}

// ── Requeue dead (permanently failed) items for one email ───────────────────
// Resets up to 500 dead queue rows back to pending so the worker retries them.
export async function requeueDeadAction(formData: FormData) {
  const userId = await requireAuthUserId();

  const parsed = RequeueDeadSchema.safeParse({ emailId: formData.get("emailId") });
  if (!parsed.success) throw new Error("Invalid emailId");
  const { emailId } = parsed.data;

  const supabase = getSupabaseAdmin();

  const { data: dead } = await supabase
    .from("mail_queue")
    .select("id")
    .eq("email_id", emailId)
    .eq("status", "dead")
    .limit(500);

  if (!dead || dead.length === 0) throw new Error("No dead items found for this email");

  const ids = dead.map((r) => r.id);
  const { error } = await supabase
    .from("mail_queue")
    .update({
      status: "pending",
      attempts: 0,
      last_error: null,
      locked_at: null,
      available_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);

  if (error) throw error;

  logAudit({
    userId,
    action: "campaign.requeue_dead",
    entity: "emails",
    entityId: emailId,
    payload: { count: ids.length },
  }).catch(console.error);

  revalidatePath("/email/sends");
  revalidatePath("/email/schedule");
  return { requeued: ids.length };
}

// ── Cancel a queued email ────────────────────────────────────────────────────
export async function cancelEmailAction(formData: FormData) {
  const userId = await requireAuthUserId();

  const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) throw new Error("Invalid email id");
  const { id } = parsed.data;
  const supabase = getSupabaseAdmin();

  // Verify ownership before touching queue rows.
  const { data: owned } = await supabase
    .from("emails")
    .select("id")
    .eq("id", id)
    .eq("author_id", userId)
    .maybeSingle();
  if (!owned) throw new Error("Email not found");

  await supabase
    .from("mail_queue")
    .delete()
    .eq("email_id", id)
    .in("status", ["pending", "processing"]);

  const { error } = await supabase
    .from("emails")
    .update({ status: "canceled" })
    .eq("id", id);
  if (error) throw error;

  logAudit({
    userId,
    action: "email.canceled",
    entity: "emails",
    entityId: id,
  }).catch(console.error);

  revalidatePath("/email/schedule");
}

// ── Delete a draft or canceled email ────────────────────────────────────────
export async function deleteEmailAction(formData: FormData) {
  const userId = await requireAuthUserId();

  const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) throw new Error("Invalid email id");
  const { id } = parsed.data;
  const supabase = getSupabaseAdmin();

  // Verify ownership before cascading deletes.
  const { data: owned } = await supabase
    .from("emails")
    .select("id")
    .eq("id", id)
    .eq("author_id", userId)
    .maybeSingle();
  if (!owned) throw new Error("Email not found");

  await supabase.from("mail_queue").delete().eq("email_id", id);
  await supabase.from("email_recipients").delete().eq("email_id", id);

  const { error } = await supabase.from("emails").delete().eq("id", id);
  if (error) throw error;

  logAudit({
    userId,
    action: "email.deleted",
    entity: "emails",
    entityId: id,
  }).catch(console.error);

  revalidatePath("/email/schedule");
}
