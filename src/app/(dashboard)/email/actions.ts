'use server';

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";
import { DAILY_SEND_LIMIT, getDailySentCount, buildSendSchedule, todayUTC } from "@/lib/dailyQuota";
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
  excludeRecipients: z.string().optional(),
  offset: z.string().optional(),
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
const QUEUE_RELEASE_CHUNK_SIZE = 200;
const QUEUE_RELEASE_SELECT_PAGE_SIZE = 1_000;
const QUEUE_CREATE_PAGE_SIZE = 1_000;
const QUEUE_WARNING_SAMPLE_LIMIT = 500;

// Throws if there is no authenticated session — middleware should have already
// caught unauthenticated requests, but this is a second line of defence for
// direct server-action calls.
async function requireAuthUserId(): Promise<string> {
  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");
  return auth.userId;
}

// Returns the full auth context (including isBypass flag).
async function requireAuthContext() {
  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");
  return auth;
}

// Verifies email ownership. In bypass mode we skip the author_id filter
// because the bypass itself proves identity — the author_id may differ if
// the profile was recreated after the email was drafted.
async function assertEmailOwned(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
  userId: string,
  isBypass: boolean,
): Promise<boolean> {
  // In bypass mode we only check the email exists — author_id may differ if
  // the profile was recreated after the email was drafted.
  // Note: must reassign `query` for the conditional filter to take effect.
  let query = supabase.from("emails").select("id").eq("id", emailId);
  if (!isBypass) query = query.eq("author_id", userId);
  const { data } = await query.maybeSingle();
  return !!data;
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
const QUEUE_HOLD_AT = "2999-12-31T23:59:59.000Z";

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

function toActionErrorMessage(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return fallback;
}

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
  queuedRecipients: number;
  remainingRecipients: number;
  daysNeeded: number;
  schedule: { date: string; count: number }[];
  nextOffset?: number;
  hasMore?: boolean;
};
export type QueueCampaignConfirm = {
  ok: false;
  requiresConfirmation: true;
  duplicateCount: number;
  recentlySentCount: number;
  sampledDuplicateCount: number;
  sampledRecentlySentCount: number;
  warningSampleLimit: number;
  warningGroups: {
    key: string;
    emailId: string | null;
    subject: string | null;
    date: string;
    receivedAt: string | null;
    recipientAddresses: string[];
    exactRecipientAddresses: string[];
    otherRecentRecipientAddresses: string[];
  }[];
  listName?: string;
};
export type QueueCampaignResult = QueueCampaignOk | QueueCampaignConfirm;

const normalizeEmailAddress = (value: string | null | undefined) =>
  value?.trim().toLowerCase() ?? "";

type WarningAccumulator = {
  key: string;
  emailId: string | null;
  subject: string | null;
  date: string;
  receivedAt: string | null;
  recipientAddresses: Set<string>;
  exactRecipientAddresses: Set<string>;
  otherRecentRecipientAddresses: Set<string>;
};

async function countActiveListMembers(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  listId: string,
) {
  const { count, error } = await supabase
    .from("list_members")
    .select("id", { count: "exact", head: true })
    .eq("list_id", listId)
    .eq("status", "active");

  if (error) throw error;
  return count ?? 0;
}

async function loadActiveListMemberPage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  listId: string,
  offset: number,
) {
  const { data, error } = await supabase
    .from("list_members")
    .select("email, metadata")
    .eq("list_id", listId)
    .eq("status", "active")
    .order("email", { ascending: true })
    .range(offset, offset + QUEUE_CREATE_PAGE_SIZE - 1);

  if (error) throw error;
  return data ?? [];
}

function listMemberToName(metadata: Json | null | undefined) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;

  const record = metadata as Record<string, unknown>;
  for (const key of ["toName", "display_name", "displayName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const name = typeof record.name === "string" ? record.name.trim() : "";
  const rank =
    typeof record.rank === "number" || typeof record.rank === "string"
      ? String(record.rank).trim()
      : "";

  if (name && rank) return `${name} #${rank}`;
  return name || undefined;
}

function queueDedupeHash(emailId: string, recipientEmail: string) {
  return createHash("sha256")
    .update(`${emailId}:${normalizeEmailAddress(recipientEmail)}`)
    .digest("hex");
}

async function buildQueueWarningSummary(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
  listId: string,
) {
  const thirtyDaysAgoDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [{ data: exactRows, count: exactCount }, { data: recentRows, count: recentCount }] = await Promise.all([
    supabase
      .from("mail_queue")
      .select("id, email_id, campaign_label, payload, send_date, created_at, updated_at", { count: "exact" })
      .eq("email_id", emailId)
      .eq("list_id", listId)
      .eq("status", "succeeded")
      .order("updated_at", { ascending: false })
      .limit(QUEUE_WARNING_SAMPLE_LIMIT),
    supabase
      .from("mail_queue")
      .select("id, email_id, campaign_label, payload, send_date, created_at, updated_at", { count: "exact" })
      .eq("list_id", listId)
      .eq("status", "succeeded")
      .neq("email_id", emailId)
      .gte("send_date", thirtyDaysAgoDate)
      .order("send_date", { ascending: false })
      .limit(QUEUE_WARNING_SAMPLE_LIMIT),
  ]);

  const relatedEmailIds = [...new Set(
    [...(exactRows ?? []), ...(recentRows ?? [])]
      .map((row) => row.email_id)
      .filter((value): value is string => Boolean(value)),
  )];

  const emailSubjects = new Map<string, string | null>();
  if (relatedEmailIds.length > 0) {
    const { data: emailRows } = await supabase
      .from("emails")
      .select("id, subject")
      .in("id", relatedEmailIds);

    for (const row of emailRows ?? []) {
      emailSubjects.set(row.id, row.subject ?? null);
    }
  }

  const seenRowIds = new Set<string>();
  const groups = new Map<string, WarningAccumulator>();
  const duplicateRecipients = new Set<string>();
  const recentRecipients = new Set<string>();

  const addRow = (
    row: {
      id: string;
      email_id: string | null;
      campaign_label: string | null;
      payload: Json;
      send_date: string | null;
      created_at: string | null;
      updated_at: string | null;
    },
    source: "exact" | "recent",
  ) => {
    if (seenRowIds.has(row.id)) return;
    seenRowIds.add(row.id);

    const recipient = normalizeEmailAddress((row.payload as { to?: string } | null)?.to);
    if (!recipient) return;

    const receivedAt = row.updated_at ?? row.created_at;
    const date = row.send_date ?? row.created_at?.slice(0, 10) ?? "unknown";
    const clusterKey = [
      row.email_id ?? "unknown-email",
      row.send_date ?? "unknown-date",
      row.campaign_label ?? "no-campaign",
    ].join(":");
    const existing = groups.get(clusterKey) ?? {
      key: clusterKey,
      emailId: row.email_id,
      subject: row.email_id ? (emailSubjects.get(row.email_id) ?? null) : null,
      date,
      receivedAt,
      recipientAddresses: new Set<string>(),
      exactRecipientAddresses: new Set<string>(),
      otherRecentRecipientAddresses: new Set<string>(),
    };

    if (receivedAt && (!existing.receivedAt || receivedAt < existing.receivedAt)) {
      existing.receivedAt = receivedAt;
    }

    existing.recipientAddresses.add(recipient);

    if (row.email_id === emailId) {
      existing.exactRecipientAddresses.add(recipient);
      duplicateRecipients.add(recipient);
    } else if (source === "recent") {
      existing.otherRecentRecipientAddresses.add(recipient);
      recentRecipients.add(recipient);
    }

    groups.set(clusterKey, existing);
  };

  for (const row of exactRows ?? []) addRow(row, "exact");
  for (const row of recentRows ?? []) addRow(row, "recent");

  return {
    duplicateCount: exactCount ?? duplicateRecipients.size,
    recentlySentCount: recentCount ?? recentRecipients.size,
    sampledDuplicateCount: duplicateRecipients.size,
    sampledRecentlySentCount: recentRecipients.size,
    warningSampleLimit: QUEUE_WARNING_SAMPLE_LIMIT,
    warningGroups: [...groups.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((group) => ({
        key: group.key,
        emailId: group.emailId,
        subject: group.subject,
        date: group.date,
        receivedAt: group.receivedAt,
        recipientAddresses: [...group.recipientAddresses].sort(),
        exactRecipientAddresses: [...group.exactRecipientAddresses].sort(),
        otherRecentRecipientAddresses: [...group.otherRecentRecipientAddresses].sort(),
      })),
  };
}

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
  try {
    const userId = await requireAuthUserId();
    const parsed = QueueCampaignSchema.safeParse({
      emailId: formData.get("emailId"),
      listId: formData.get("listId"),
      skipDuplicateCheck: formData.get("skipDuplicateCheck") ?? undefined,
      excludeRecipients: formData.get("excludeRecipients") ?? undefined,
      offset: formData.get("offset") ?? undefined,
    });
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

    const supabase = getSupabaseAdmin();
    const { emailId, listId } = parsed.data;
    const skipDuplicateCheck = parsed.data.skipDuplicateCheck === "true";
    const offset = Math.max(0, Number.parseInt(parsed.data.offset ?? "0", 10) || 0);
    const excludedRecipients = (() => {
      if (!parsed.data.excludeRecipients) return new Set<string>();
      try {
        const parsedJson = JSON.parse(parsed.data.excludeRecipients) as unknown;
        if (!Array.isArray(parsedJson)) return new Set<string>();
        return new Set(
          parsedJson
            .map((value) => normalizeEmailAddress(typeof value === "string" ? value : ""))
            .filter(Boolean),
        );
      } catch {
        return new Set<string>();
      }
    })();

  // Load the email draft — also verify ownership so one user can't queue
  // another user's draft (defense-in-depth; RLS covers the DB layer).
  const { data: email, error: emailError } = await supabase
    .from("emails")
    .select("from_address, subject, html, text, tags, campaigns, scheduled_at")
    .eq("id", emailId)
    .eq("author_id", userId)
    .single();
  if (emailError || !email) throw new Error("Email draft not found");

  // Hard guard on the first batch only: follow-up batches are the same
  // intentional queue-build operation and must be allowed to append.
  if (offset === 0) {
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
  }

  const totalActiveMembers = await countActiveListMembers(supabase, listId);
  if (totalActiveMembers === 0) throw new Error("List has no active members");

  // ── Pre-flight duplicate / recent-contact check ─────────────────────────
  if (!skipDuplicateCheck && offset === 0) {
    const warningSummary = await buildQueueWarningSummary(
      supabase,
      emailId,
      listId,
    );

    if (warningSummary.duplicateCount > 0 || warningSummary.recentlySentCount > 0) {
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
        payload: {
          listId,
          duplicateCount: warningSummary.duplicateCount,
          recentlySentCount: warningSummary.recentlySentCount,
          warningGroups: warningSummary.warningGroups.map((group) => ({
            date: group.date,
            recipients: group.recipientAddresses.length,
            exactRecipients: group.exactRecipientAddresses.length,
            otherRecentRecipients: group.otherRecentRecipientAddresses.length,
          })),
        },
      }).catch(console.error);

      return {
        ok: false,
        requiresConfirmation: true,
        duplicateCount: warningSummary.duplicateCount,
        recentlySentCount: warningSummary.recentlySentCount,
        sampledDuplicateCount: warningSummary.sampledDuplicateCount,
        sampledRecentlySentCount: warningSummary.sampledRecentlySentCount,
        warningSampleLimit: warningSummary.warningSampleLimit,
        warningGroups: warningSummary.warningGroups,
        listName: listRow?.name,
      };
    }
  }

  const memberPage = await loadActiveListMemberPage(supabase, listId, offset);
  const membersToQueue = memberPage.filter(
    (member) => !excludedRecipients.has(normalizeEmailAddress(member.email)),
  );

  if (membersToQueue.length === 0) {
    throw new Error("All recipients were excluded. Nothing to queue.");
  }

  const today = todayUTC();
  const alreadySentToday = await getDailySentCount(today);
  const estimatedTotal = Math.max(0, totalActiveMembers - excludedRecipients.size);
  const schedule = buildSendSchedule(estimatedTotal, alreadySentToday, today);
  const campaignLabel = `${emailId}:${today}`;

  // Prebuild the queue, but keep everything on hold until the operator hits
  // "Send Now" for this email.
  const queueRows: {
    email_id: string;
    list_id: string;
    payload: Json;
    status: "pending";
    available_at: string;
    send_date: string | null;
    campaign_label: string;
    dedupe_hash: string;
  }[] = [];

  for (const member of membersToQueue) {
    queueRows.push({
      email_id: emailId,
      list_id: listId,
      payload: {
        to: member.email,
        toName: listMemberToName(member.metadata),
        tags: email.tags ?? [],
        campaigns: email.campaigns ?? [],
      },
      status: "pending",
      available_at: QUEUE_HOLD_AT,
      send_date: null,
      campaign_label: campaignLabel,
      dedupe_hash: queueDedupeHash(emailId, member.email),
    });
  }

  // Upsert in batches of 500 to stay within Supabase payload limits.
  const CHUNK = 500;
  for (let i = 0; i < queueRows.length; i += CHUNK) {
    const { error } = await supabase
      .from("mail_queue")
      .upsert(queueRows.slice(i, i + CHUNK), {
        onConflict: "dedupe_hash",
        ignoreDuplicates: true,
      });
    if (error) throw error;
  }

  await supabase
    .from("emails")
    .update({ status: "queued" })
    .eq("id", emailId);

  const nextOffset = offset + memberPage.length;
  const hasMore = memberPage.length === QUEUE_CREATE_PAGE_SIZE && nextOffset < totalActiveMembers;
  const queuedRecipients = Math.min(nextOffset, totalActiveMembers);
  const remainingRecipients = Math.max(0, totalActiveMembers - queuedRecipients);

  logAudit({
    userId,
    action: "campaign.queued",
    entity: "emails",
    entityId: emailId,
    payload: {
      listId,
      totalRecipients: estimatedTotal,
      queuedThisBatch: membersToQueue.length,
      queuedRecipients,
      remainingRecipients,
      daysNeeded: schedule.length,
      startDate: today,
      mode: "queued_for_manual_send",
    },
  }).catch(console.error);

  revalidatePath("/email/schedule");
  return {
    ok: true as const,
    totalRecipients: estimatedTotal,
    queuedRecipients,
    remainingRecipients,
    daysNeeded: schedule.length,
    schedule: schedule.map((s) => ({ date: s.date, count: s.count })),
    nextOffset: hasMore ? nextOffset : undefined,
    hasMore,
  };
  } catch (err) {
    throw new Error(toActionErrorMessage(err, "Unable to queue this campaign. Please verify the list and try again."));
  }
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
export async function triggerQueueAction(emailId?: string): Promise<{ processed: number; succeeded: number; failed: number; message: string }> {
  await requireAuthUserId();
  const data = await runQueueWorker({ emailId });
  revalidatePath("/email/schedule");
  revalidatePath("/email/sends");
  return {
    processed: data.processed ?? 0,
    succeeded: data.succeeded ?? 0,
    failed: data.failed ?? 0,
    message: data.message ?? `Processed ${data.processed ?? 0} items`,
  };
}

export async function getQueueSnapshotAction(emailId?: string) {
  await requireAuthUserId();
  const supabase = getSupabaseAdmin();
  const today = todayUTC();
  const nowIso = new Date().toISOString();
  const sentToday = await getDailySentCount(today);

  const statusCount = async (status: string) => {
    let query = supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    if (emailId) query = query.eq("email_id", emailId);
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  };

  let pendingDueQuery = supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .lte("available_at", nowIso);
  let pendingHeldQuery = supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .gt("available_at", nowIso);

  if (emailId) {
    pendingDueQuery = pendingDueQuery.eq("email_id", emailId);
    pendingHeldQuery = pendingHeldQuery.eq("email_id", emailId);
  }

  const [
    pending,
    processing,
    succeeded,
    failed,
    dead,
    canceled,
    { count: pendingDue },
    { count: pendingHeld },
  ] = await Promise.all([
    statusCount("pending"),
    statusCount("processing"),
    statusCount("succeeded"),
    statusCount("failed"),
    statusCount("dead"),
    statusCount("canceled"),
    pendingDueQuery,
    pendingHeldQuery,
  ]);

  let subject: string | null = null;
  let emailStatus: string | null = null;
  if (emailId) {
    const { data } = await supabase
      .from("emails")
      .select("subject, status")
      .eq("id", emailId)
      .maybeSingle();
    subject = data?.subject ?? null;
    emailStatus = data?.status ?? null;
  }

  return {
    emailId: emailId ?? null,
    subject,
    emailStatus,
    date: today,
    dailyCap: DAILY_SEND_LIMIT,
    sentToday,
    remainingToday: Math.max(0, DAILY_SEND_LIMIT - sentToday),
    pending,
    pendingDue: pendingDue ?? 0,
    pendingHeld: pendingHeld ?? 0,
    processing,
    succeeded,
    failed,
    dead,
    canceled,
  };
}

export async function sendQueuedEmailAction(formData: FormData): Promise<{
  released?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  remainingQueued?: number;
  error?: string;
}> {
  try {
    const auth = await requireAuthContext();

    const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
    if (!parsed.success) return { error: "Invalid email id" };

    const { id } = parsed.data;
    const supabase = getSupabaseAdmin();

    if (!(await assertEmailOwned(supabase, id, auth.userId, auth.isBypass))) {
      return { error: "Email not found" };
    }
    const userId = auth.userId;

    const sentToday = await getDailySentCount();
    const remainingToday = Math.max(0, DAILY_SEND_LIMIT - sentToday);
    if (remainingToday === 0) {
      return { error: `Daily cap of ${DAILY_SEND_LIMIT.toLocaleString()} reached. Nothing can be sent right now.` };
    }

    const nowIso = new Date().toISOString();
    const { count: dueBefore } = await supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", id)
      .eq("status", "pending")
      .lte("available_at", nowIso);

    let releasedCount = 0;

    while (releasedCount < remainingToday) {
      const { data: queuedRows, error: queuedError } = await supabase
        .from("mail_queue")
        .select("id")
        .eq("email_id", id)
        .eq("status", "pending")
        .gt("available_at", nowIso)
        .order("created_at", { ascending: true })
        .limit(Math.min(QUEUE_RELEASE_SELECT_PAGE_SIZE, remainingToday - releasedCount));
      if (queuedError) return { error: queuedError.message };
      if (!queuedRows?.length) break;

      const queueIds = queuedRows.map((row) => row.id);

      for (let i = 0; i < queueIds.length; i += QUEUE_RELEASE_CHUNK_SIZE) {
        const chunk = queueIds.slice(i, i + QUEUE_RELEASE_CHUNK_SIZE);
        const { error: releaseError } = await supabase
          .from("mail_queue")
          .update({ available_at: nowIso, updated_at: nowIso })
          .in("id", chunk);
        if (releaseError) return { error: releaseError.message };
      }

      releasedCount += queueIds.length;
      if (queuedRows.length < QUEUE_RELEASE_SELECT_PAGE_SIZE) break;
    }

    if (releasedCount === 0 && (dueBefore ?? 0) === 0) {
      return { error: "No queued recipients are ready for this email." };
    }

    await supabase
      .from("emails")
      .update({ status: "sending" })
      .eq("id", id);

    const result = await runQueueWorker({ emailId: id });

    const { count: remainingQueued } = await supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", id)
      .in("status", ["pending", "processing"]);

    logAudit({
      userId,
      action: "campaign.send_now",
      entity: "emails",
      entityId: id,
      payload: {
        released: releasedCount,
        processed: result.processed,
        succeeded: result.succeeded,
        failed: result.failed,
        remainingQueued: remainingQueued ?? 0,
      },
    }).catch(console.error);

    revalidatePath("/email/schedule");
    revalidatePath("/email/sends");

    return {
      released: releasedCount,
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      remainingQueued: remainingQueued ?? 0,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to send email" };
  }
}

export async function editQueuedEmailAction(
  formData: FormData,
): Promise<{ href?: string; error?: string }> {
  try {
    const auth = await requireAuthContext();

    const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
    if (!parsed.success) return { error: "Invalid email id" };
    const { id } = parsed.data;
    const supabase = getSupabaseAdmin();

    if (!(await assertEmailOwned(supabase, id, auth.userId, auth.isBypass))) {
      return { error: "Email not found" };
    }
    const userId = auth.userId;

    // Soft-cancel unsent rows so we preserve a record of who wasn't sent to.
    // 'processing' rows are also canceled here — the stuck-lock reclaim won't
    // touch canceled rows, so they won't resurface after the edit.
    const nowIso = new Date().toISOString();
    await supabase
      .from("mail_queue")
      .update({ status: "canceled", locked_at: null, updated_at: nowIso })
      .eq("email_id", id)
      .in("status", ["pending", "processing"]);

    const { error } = await supabase
      .from("emails")
      .update({ status: "draft", scheduled_at: null })
      .eq("id", id);
    if (error) return { error: error.message };

    logAudit({
      userId,
      action: "email.edit_from_queue",
      entity: "emails",
      entityId: id,
    }).catch(console.error);

    revalidatePath("/email/schedule");
    revalidatePath("/email/composer");
    return { href: `/email/composer?id=${id}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to edit email" };
  }
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
export async function cancelEmailAction(formData: FormData): Promise<{ error?: string }> {
  try {
    const auth = await requireAuthContext();

    const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
    if (!parsed.success) return { error: "Invalid email id" };
    const { id } = parsed.data;
    const supabase = getSupabaseAdmin();

    // Verify ownership before touching queue rows.
    if (!(await assertEmailOwned(supabase, id, auth.userId, auth.isBypass))) {
      return { error: "Email not found" };
    }
    const userId = auth.userId;

    // Soft-cancel unsent rows so the record of who wasn't reached is preserved.
    // A subsequent re-queue can use mail_queue WHERE status='canceled' to find
    // exactly who needs to be retried.
    const nowIso = new Date().toISOString();
    await supabase
      .from("mail_queue")
      .update({ status: "canceled", locked_at: null, updated_at: nowIso })
      .eq("email_id", id)
      .in("status", ["pending", "processing"]);

    const { error } = await supabase
      .from("emails")
      .update({ status: "draft", scheduled_at: null })
      .eq("id", id);
    if (error) return { error: error.message };

    logAudit({
      userId,
      action: "email.unqueued",
      entity: "emails",
      entityId: id,
    }).catch(console.error);

    revalidatePath("/email/schedule");
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to cancel email" };
  }
}

// ── Delete a draft or canceled email ────────────────────────────────────────
export async function deleteEmailAction(formData: FormData): Promise<{ error?: string }> {
  try {
    const auth = await requireAuthContext();

    const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
    if (!parsed.success) return { error: "Invalid email id" };
    const { id } = parsed.data;
    const supabase = getSupabaseAdmin();

    // Verify ownership before cascading deletes.
    if (!(await assertEmailOwned(supabase, id, auth.userId, auth.isBypass))) {
      return { error: "Email not found" };
    }
    const userId = auth.userId;

    await supabase.from("mail_queue").delete().eq("email_id", id);
    await supabase.from("email_recipients").delete().eq("email_id", id);

    const { error } = await supabase.from("emails").delete().eq("id", id);
    if (error) return { error: error.message };

    logAudit({
      userId,
      action: "email.deleted",
      entity: "emails",
      entityId: id,
    }).catch(console.error);

    revalidatePath("/email/schedule");
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to delete email" };
  }
}
