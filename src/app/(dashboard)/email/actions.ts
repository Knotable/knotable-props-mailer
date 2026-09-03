'use server';

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServerAuthContext, requireCanSendAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";
import { getQuotaUsageSnapshot, buildSendSchedule, todayUTC } from "@/lib/dailyQuota";
import { logAudit } from "@/lib/logger";
import { describeQueueReleasePreflight, isQueueReleaseConfirmed } from "@/lib/queueReleaseGuard";
import { runQueueWorker } from "@/lib/queueWorker";
import { isBlockedRecipientEmail } from "@/lib/blockList";
import { buildRecipientPersonalization, personalizeEmailContent } from "@/lib/personalization";
import { parseOneTimeAudienceCsv } from "@/lib/client/oneTimeAudience";
import { assertSendReadySubject } from "@/lib/subjectReadiness";
import type { Json } from "@/supabase/types";

/**
 * Stable deduplication hash for a queue row.
 * SHA-256(emailId:recipientEmail) — fits in a text column, unique per
 * (campaign, recipient) pair. The DB enforces uniqueness with
 * mail_queue_dedupe_hash_unique_idx, so queue creation can be safely retried.
 */
function makeDedupeHash(emailId: string, recipientEmail: string): string {
  return createHash("sha256")
    .update(`${emailId}:${recipientEmail.toLowerCase().trim()}`)
    .digest("hex");
}

function makeSenderCopyDedupeHash(emailId: string, senderEmail: string): string {
  return createHash("sha256")
    .update(`${emailId}:sender-copy:${senderEmail.toLowerCase().trim()}`)
    .digest("hex");
}

const SaveDraftSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  from: z.string().min(1).max(320),
  replyTo: z.string().max(320).optional().nullable(),
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

const ImportOneTimeAudienceSchema = z.object({
  name: z.string().min(1).max(200),
  sourceFilename: z.string().max(500).optional().nullable(),
});

const SendTestSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  from: z.string().min(1).max(320),
  replyTo: z.string().max(320).optional().nullable(),
  subject: z.string().min(1).max(998),
  html: z.string().min(1).max(5_000_000),
  recipients: z.string().min(1).max(200_000),
  text: z.string().max(5_000_000).optional().nullable(),
  tags: z.string().max(2000).optional().nullable(),
  campaigns: z.string().max(2000).optional().nullable(),
});

const EmailIdSchema = z.object({ id: z.string().uuid() });
const RequeueDeadSchema = z.object({ emailId: z.string().uuid() });
const QUEUE_CREATE_PAGE_SIZE = 1_000;
const QUEUE_WARNING_SAMPLE_LIMIT = 500;
const ONE_TIME_AUDIENCE_ADDRESS_DOMAIN = "props.sarva.co";
const ONE_TIME_AUDIENCE_MEMBER_CHUNK_SIZE = 500;

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

// Verifies a shared email exists. Mail records are intentionally collaborative
// across accounts; send permission is enforced separately.
async function assertEmailOwned(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
  _userId: string,
  _isBypass: boolean,
): Promise<boolean> {
  const { data } = await supabase.from("emails").select("id").eq("id", emailId).maybeSingle();
  return !!data;
}

type DraftPayload = {
  from: string;
  replyTo?: string;
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
    replyTo: formData.get("replyTo") || null,
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
    replyTo: parsed.data.replyTo?.trim() || undefined,
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
    reply_to: payload.replyTo ?? null,
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
      .eq("id", id);
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
export type QueueCampaignError = {
  ok: false;
  requiresConfirmation: false;
  error: string;
};
export type QueueCampaignResult = QueueCampaignOk | QueueCampaignConfirm | QueueCampaignError;

const normalizeEmailAddress = (value: string | null | undefined) =>
  value?.trim().toLowerCase() ?? "";

function extractEmailAddress(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;

  const angleMatch = trimmed.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/);
  const candidate = (angleMatch?.[1] ?? trimmed).trim().toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

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
  for (const key of ["toName", "display_name", "displayName", "full_name", "fullName"]) {
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

function jsonRecord(value: Json | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function listMemberToMergeData(metadata: Json | null | undefined): Record<string, string> {
  const record = jsonRecord(metadata);
  const directMerge = jsonRecord(record.merge as Json | null | undefined);
  const mergeData = jsonRecord(record.merge_data as Json | null | undefined);
  const source = Object.keys(directMerge).length > 0 ? directMerge : mergeData;
  const entries = Object.entries(source).flatMap(([key, value]) => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return [];
    const text = String(value).trim();
    if (!key.trim() || !text) return [];
    return [[key, text]];
  });

  const name = listMemberToName(metadata);
  if (name && !entries.some(([key]) => key === "name")) entries.push(["name", name]);

  const firstName = typeof record.first_name === "string"
    ? record.first_name.trim()
    : typeof record.firstName === "string"
      ? record.firstName.trim()
      : "";
  if (firstName && !entries.some(([key]) => key === "first_name")) entries.push(["first_name", firstName]);

  return Object.fromEntries(entries);
}

export async function importOneTimeAudienceAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const parsed = ImportOneTimeAudienceSchema.safeParse({
    name: String(formData.get("name") ?? "").trim(),
    sourceFilename: formData.get("sourceFilename") ? String(formData.get("sourceFilename")).trim() : null,
  });
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid audience name" };
  }

  const uploadedFile = formData.get("csvFile");
  const rawFromFile = uploadedFile instanceof File && uploadedFile.size > 0
    ? await uploadedFile.text()
    : "";
  const raw = rawFromFile || String(formData.get("csv") ?? "");
  const parsedCsv = parseOneTimeAudienceCsv(raw);
  if (parsedCsv.errors.length > 0) {
    return { ok: false as const, error: parsedCsv.errors[0] };
  }
  if (parsedCsv.members.length === 0) {
    return { ok: false as const, error: "CSV did not contain any valid recipients." };
  }

  const supabase = getSupabaseAdmin();
  const audienceId = randomUUID();
  const address = `one-time-${audienceId}@${ONE_TIME_AUDIENCE_ADDRESS_DOMAIN}`;
  const sourceFilename = uploadedFile instanceof File && uploadedFile.name
    ? uploadedFile.name
    : parsed.data.sourceFilename || null;
  const descriptionParts = [
    "One-time CSV audience.",
    "Schema-debt: this is stored in lists/list_members until dedicated audience tables exist.",
    sourceFilename ? `Source file: ${sourceFilename}.` : null,
    `Imported ${parsedCsv.members.length} valid recipient(s).`,
  ].filter(Boolean);

  const list = {
    id: audienceId,
    name: parsed.data.name,
    address,
    access_level: "one_time_csv",
  };

  const { error: listError } = await supabase
    .from("lists")
    .insert({
      id: list.id,
      owner_id: userId,
      name: list.name,
      address: list.address,
      description: descriptionParts.join(" "),
      access_level: list.access_level,
    });
  if (listError) return { ok: false as const, error: listError.message };

  for (let i = 0; i < parsedCsv.members.length; i += ONE_TIME_AUDIENCE_MEMBER_CHUNK_SIZE) {
    const rows = parsedCsv.members
      .slice(i, i + ONE_TIME_AUDIENCE_MEMBER_CHUNK_SIZE)
      .map((member) => {
        const blocked = isBlockedRecipientEmail(member.email);
        const metadata = {
          name: member.name,
          display_name: member.name,
          first_name: member.firstName,
          one_time_audience: true,
          source_filename: sourceFilename,
          source_row: member.sourceRow,
          merge: member.mergeData,
        } satisfies Json;

        return {
          list_id: list.id,
          email: member.email,
          status: blocked ? "blocked" : "active",
          source: blocked ? "block_list" : "one_time_csv",
          unsubscribed_at: blocked ? new Date().toISOString() : null,
          metadata,
        };
      });

    const { error } = await supabase.from("list_members").insert(rows);
    if (error) {
      await supabase.from("lists").delete().eq("id", list.id);
      return { ok: false as const, error: error.message };
    }
  }

  logAudit({
    userId,
    action: "one_time_audience.import",
    entity: "lists",
    entityId: list.id,
    payload: {
      submitted: parsedCsv.submitted,
      imported: parsedCsv.members.length,
      skippedInvalid: parsedCsv.skippedInvalid,
      skippedDuplicate: parsedCsv.skippedDuplicate,
      sourceFilename,
      headers: parsedCsv.headers,
    },
  }).catch(console.error);

  revalidatePath("/email/composer");
  revalidatePath("/lists");

  return {
    ok: true as const,
    list,
    submitted: parsedCsv.submitted,
    imported: parsedCsv.members.length,
    skippedInvalid: parsedCsv.skippedInvalid,
    skippedDuplicate: parsedCsv.skippedDuplicate,
    headers: parsedCsv.headers,
    sample: parsedCsv.members.slice(0, 5),
  };
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
 * Queue a campaign send to a mailing list. Rows stay held until the operator
 * releases the campaign; release uses the configured SES rolling 24h cap.
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
    const auth = await requireCanSendAuthContext();
    const userId = auth.userId;
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
    .select("from_address, reply_to, subject, html, text, tags, campaigns, scheduled_at")
    .eq("id", emailId)
    .eq("author_id", userId)
    .single();
  if (emailError || !email) throw new Error("Email draft not found");
  assertSendReadySubject(email.subject);

  // Resume-safe queueing: retries may start again at offset 0 after a tab or
  // network failure. The dedupe_hash upsert below makes repeated pages
  // idempotent, so do not block when partially queued rows already exist.
  if (offset === 0) {
    const { count: existingCount } = await supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", emailId)
      .eq("list_id", listId)
      .in("status", ["pending", "processing"]);

    if (existingCount && existingCount > 0) {
      console.info(`[queue] resuming ${existingCount} existing pending row(s) for email ${emailId} list ${listId}`);
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
    (member) =>
      !excludedRecipients.has(normalizeEmailAddress(member.email)) &&
      !isBlockedRecipientEmail(member.email),
  );

  if (membersToQueue.length === 0) {
    throw new Error("All recipients were excluded. Nothing to queue.");
  }

  const today = todayUTC();
  const quota = await getQuotaUsageSnapshot();
  const estimatedTotal = Math.max(0, totalActiveMembers - excludedRecipients.size);
  const schedule = buildSendSchedule(estimatedTotal, quota.rolling24hSent, today, quota.dailyCap);
  const campaignLabel = `${emailId}:${today}`;

  // Prebuild the queue, but keep everything on hold until the operator hits
  // "Send Now" for this email.
  const queueRows: {
    email_id: string;
    list_id: string | null;
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
        merge: listMemberToMergeData(member.metadata),
        tags: email.tags ?? [],
        campaigns: email.campaigns ?? [],
      },
      status: "pending",
      available_at: QUEUE_HOLD_AT,
      send_date: null,
      campaign_label: campaignLabel,
      dedupe_hash: makeDedupeHash(emailId, member.email),
    });
  }

  if (offset === 0) {
    const senderEmail = extractEmailAddress(email.from_address);
    if (senderEmail && !isBlockedRecipientEmail(senderEmail)) {
      queueRows.push({
        email_id: emailId,
        list_id: null,
        payload: {
          to: senderEmail,
          subject: `[SENDER COPY] ${email.subject}`,
          tags: email.tags ?? [],
          campaigns: [...(email.campaigns ?? []), "sender-copy"],
        },
        status: "pending",
        available_at: QUEUE_HOLD_AT,
        send_date: null,
        campaign_label: campaignLabel,
        dedupe_hash: makeSenderCopyDedupeHash(emailId, senderEmail),
      });
    }
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
    return {
      ok: false,
      requiresConfirmation: false,
      error: toActionErrorMessage(err, "Unable to queue this campaign. Please verify the list and try again."),
    };
  }
}

export async function sendTestAction(formData: FormData): Promise<{ sent: number; error?: string }> {
  try {
    const auth = await requireCanSendAuthContext();
    const userId = auth.userId;

    const parsed = SendTestSchema.safeParse({
      id: formData.get("id") || null,
      from: formData.get("from"),
      replyTo: formData.get("replyTo") || null,
      subject: formData.get("subject"),
      html: formData.get("html"),
      recipients: formData.get("recipients"),
      text: formData.get("text") || null,
      tags: formData.get("tags") || null,
      campaigns: formData.get("campaigns") || null,
    });
    if (!parsed.success) return { sent: 0, error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const id = parsed.data.id ?? null;
    const from = parsed.data.from;
    const replyTo = parsed.data.replyTo?.trim() || undefined;
    const subject = parsed.data.subject;
    const html = parsed.data.html;
    const text = parsed.data.text ?? undefined;
    const tags = parsed.data.tags?.split(",").map((t) => t.trim()).filter(Boolean);
    const campaigns = parsed.data.campaigns?.split(",").map((c) => c.trim()).filter(Boolean);

    const recipients = parseRecipients(parsed.data.recipients);
    if (!recipients.length) return { sent: 0, error: "Need at least one valid recipient email address" };

    // Send individually so recipients never see each other.
    const results = await Promise.allSettled(
      recipients.map(async (recipient) => {
        const personalized = personalizeEmailContent(
          { subject, html, text },
          buildRecipientPersonalization({ email: recipient }),
        );
        const result = await sendEmail({
          from,
          replyTo,
          to: [recipient],
          subject: personalized.subject,
          html: personalized.html,
          text: personalized.text,
          tags,
          campaigns,
          testMode: true,
        });
        return { recipient, sesMessageId: result.sesMessageId, subject: personalized.subject };
      }),
    );

    const succeeded = results.filter(
      (r): r is PromiseFulfilledResult<{ recipient: string; sesMessageId: string | null; subject: string }> =>
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
        payload: { from, replyTo, to: value.recipient, subject: value.subject } as Json,
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
      return {
        sent: succeeded.length,
        error:
          failed.length === recipients.length
            ? `Send failed: ${firstMsg}`
            : `${succeeded.length} sent, ${failed.length} failed — ${firstMsg}`,
      };
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
  } catch (err) {
    return { sent: 0, error: toActionErrorMessage(err, "Test send failed.") };
  }
}

// ── Manually trigger the queue worker ───────────────────────────────────────
export async function triggerQueueAction(emailId: string): Promise<{ processed: number; succeeded: number; failed: number; message: string }> {
  await requireCanSendAuthContext();
  const parsed = EmailIdSchema.safeParse({ id: emailId });
  if (!parsed.success) throw new Error("Invalid email id");

  const data = await runQueueWorker({ emailId: parsed.data.id });
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
  const quota = await getQuotaUsageSnapshot();

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

  const terminalFailures = failed + dead;
  const total = pending + processing + succeeded + failed + dead + canceled;
  const resolved = succeeded + failed + dead + canceled;
  const dailySendLimit = quota.dailyCap;
  const isDrained = total > 0 && pending === 0 && processing === 0;
  const displayStatus =
    total === 0
      ? emailStatus ?? "No queue rows"
      : pending > 0 || processing > 0
        ? "Sending"
        : succeeded > 0 && terminalFailures > 0
          ? "Complete with permanent failures"
          : succeeded > 0
            ? "Complete"
            : terminalFailures > 0
              ? "Failed"
              : canceled > 0
                ? "Canceled"
                : emailStatus ?? "Unknown";
  const statusDetail =
    total === 0
      ? "No queue rows exist for this email."
      : pending > 0 || processing > 0
        ? `${pending + processing} recipient${pending + processing === 1 ? "" : "s"} still waiting or sending.`
        : terminalFailures > 0
          ? `${succeeded.toLocaleString()} accepted by SES; ${terminalFailures.toLocaleString()} recipient${terminalFailures === 1 ? "" : "s"} permanently failed.`
          : `${succeeded.toLocaleString()} recipient${succeeded === 1 ? "" : "s"} accepted by SES.`;

  return {
    emailId: emailId ?? null,
    subject,
    emailStatus,
    displayStatus,
    statusDetail,
    date: today,
    dailyCap: dailySendLimit,
    sentToday: quota.acceptedTodayUtc,
    rolling24hSent: quota.rolling24hSent,
    remainingToday: quota.remainingRolling24h,
    total,
    resolved,
    terminalFailures,
    isDrained,
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

export async function getRecipientSendLogAction(emailId: string, limit = 200) {
  await requireAuthUserId();
  const parsed = EmailIdSchema.safeParse({ id: emailId });
  if (!parsed.success) throw new Error("Invalid email id");

  const supabase = getSupabaseAdmin();
  const safeLimit = Math.min(Math.max(limit, 1), 2_000);

  const { data, error } = await supabase
    .from("mail_queue")
    .select("recipient_email, status, attempt_count, max_attempts, available_at, updated_at, last_error")
    .eq("email_id", parsed.data.id)
    .order("updated_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    recipientEmail: row.recipient_email,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  }));
}

export async function sendQueuedEmailAction(formData: FormData): Promise<{
  released?: number;
  dueNow?: number;
  scheduledFuture?: number;
  pendingDueBefore?: number;
  pendingHeldBefore?: number;
  processingBefore?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  remainingQueued?: number;
  error?: string;
}> {
  try {
    const auth = await requireCanSendAuthContext();

    const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
    if (!parsed.success) return { error: "Invalid email id" };

    const { id } = parsed.data;
    const supabase = getSupabaseAdmin();

    if (!(await assertEmailOwned(supabase, id, auth.userId, auth.isBypass))) {
      return { error: "Email not found" };
    }
    const userId = auth.userId;

    const nowIso = new Date().toISOString();
    const [{ data: emailRow, error: emailError }, { data: summaryRows, error: summaryError }] = await Promise.all([
      supabase.from("emails").select("status, subject").eq("id", id).maybeSingle(),
      supabase.rpc("get_queue_campaign_summaries", {
        p_email_ids: [id],
        p_now: nowIso,
      }),
    ]);

    if (emailError) return { error: emailError.message };
    if (summaryError) return { error: summaryError.message };

    if (emailRow?.status !== "queued" && emailRow?.status !== "sending") {
      return { error: "Only queued or sending emails can be released." };
    }
    try {
      assertSendReadySubject(emailRow.subject ?? "");
    } catch (error) {
      return { error: toActionErrorMessage(error, "Subject is not send-ready.") };
    }

    const preflight = (summaryRows ?? []).reduce(
      (counts, row) => ({
        pendingDue: counts.pendingDue + Number(row.pending_due ?? 0),
        pendingHeld: counts.pendingHeld + Number(row.pending_held ?? 0),
        processing: counts.processing + Number(row.processing ?? 0),
      }),
      { pendingDue: 0, pendingHeld: 0, processing: 0 },
    );

    if (preflight.pendingDue + preflight.pendingHeld + preflight.processing === 0) {
      return { error: "No queued recipients are ready for this email." };
    }

    // A row reaches processing before SES acceptance is durably checkpointed.
    // A second worker here could therefore create duplicate deliveries. Never
    // make a campaign look newly released while such a claim is unresolved.
    if (preflight.processing > 0) {
      return {
        error: `${preflight.processing} processing recipient${preflight.processing === 1 ? " is" : "s are"} unresolved. Reconcile SES acceptance before releasing another worker.`,
      };
    }

    if (!isQueueReleaseConfirmed(id, formData.get("releaseConfirmation"))) {
      return {
        error: `Release confirmation required for ${describeQueueReleasePreflight(preflight)}.`,
      };
    }

    const quota = await getQuotaUsageSnapshot();
    if (quota.remainingRolling24h === 0) {
      return { error: `SES rolling 24-hour cap of ${quota.dailyCap.toLocaleString()} reached. Nothing can be sent right now.` };
    }

    const { error: resumeError } = await supabase
      .from("emails")
      .update({ status: "sending" })
      .eq("id", id);
    if (resumeError) return { error: resumeError.message };
    const remainingQueued = preflight.pendingDue + preflight.pendingHeld;

    logAudit({
      userId,
      action: "campaign.send_now",
      entity: "emails",
      entityId: id,
      payload: {
        released: 0,
        dueNow: preflight.pendingDue,
        scheduledFuture: preflight.pendingHeld,
        pendingDueBefore: preflight.pendingDue,
        pendingHeldBefore: preflight.pendingHeld,
        processingBefore: preflight.processing,
        processed: 0,
        succeeded: 0,
        failed: 0,
        remainingQueued,
        mode: "incremental_background_resume",
      },
    }).catch(console.error);

    revalidatePath("/email/schedule");
    revalidatePath("/email/sends");

    return {
      released: 0,
      dueNow: preflight.pendingDue,
      scheduledFuture: preflight.pendingHeld,
      processed: 0,
      succeeded: 0,
      failed: 0,
      remainingQueued,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to send email" };
  }
}

export async function sendQueuedEmailAndRedirectAction(formData: FormData): Promise<void> {
  const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) {
    redirect("/email/schedule?sendError=Invalid%20email%20id");
  }

  const result = await sendQueuedEmailAction(formData);
  if (result.error) {
    redirect(`/email/schedule?sendError=${encodeURIComponent(result.error)}`);
  }

  redirect(`/email/monitor?emailId=${parsed.data.id}`);
}

// Pause a campaign without canceling or rewriting its queue rows. Completed
// deliveries stay succeeded, pending rows keep their exact retry/hold state,
// and the parent status prevents workers from claiming more. Rows already
// claimed by a worker are allowed to finish.
export async function pauseQueuedEmailAction(
  formData: FormData,
): Promise<{ paused: number; processing: number; error?: string }> {
  try {
    const auth = await requireCanSendAuthContext();
    const parsed = EmailIdSchema.safeParse({ id: formData.get("id") });
    if (!parsed.success) return { paused: 0, processing: 0, error: "Invalid email id" };

    const { id } = parsed.data;
    const supabase = getSupabaseAdmin();
    if (!(await assertEmailOwned(supabase, id, auth.userId, auth.isBypass))) {
      return { paused: 0, processing: 0, error: "Email not found" };
    }

    // Claiming is restricted to parent campaigns in `sending`, so this one-row
    // state transition stops new work without rewriting thousands of queue rows.
    const { error: emailError } = await supabase
      .from("emails")
      .update({ status: "queued" })
      .eq("id", id);
    if (emailError) return { paused: 0, processing: 0, error: emailError.message };

    const { data: summaryRows, error: summaryError } = await supabase.rpc(
      "get_queue_campaign_summaries",
      { p_email_ids: [id], p_now: new Date().toISOString() },
    );
    if (summaryError) return { paused: 0, processing: 0, error: summaryError.message };
    const paused = (summaryRows ?? []).reduce(
      (total, row) => total + Number(row.pending_due ?? 0) + Number(row.pending_held ?? 0),
      0,
    );
    const processing = (summaryRows ?? []).reduce(
      (total, row) => total + Number(row.processing ?? 0),
      0,
    );

    logAudit({
      userId: auth.userId,
      action: "campaign.paused",
      entity: "emails",
      entityId: id,
      payload: { paused, processing },
    }).catch(console.error);

    revalidatePath("/email/schedule");
    revalidatePath("/email/monitor");
    return { paused, processing };
  } catch (err) {
    return {
      paused: 0,
      processing: 0,
      error: toActionErrorMessage(err, "Unable to pause this campaign."),
    };
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
  const auth = await requireCanSendAuthContext();
  const userId = auth.userId;

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
