'use server';

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { logAudit } from "@/lib/logger";
import type { Json } from "@/supabase/types";
import {
  blockedMemberMetadata,
  isBlockedRecipientEmail,
} from "@/lib/blockList";

async function requireAuthUserId(): Promise<string> {
  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");
  return auth.userId;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMPORT_MEMBERS_CHUNK_SIZE = 500;
const OWNER_ALWAYS_INCLUDE_EMAIL = "a@sarva.co";

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields.map((field) => field.trim());
}

function cleanImportedName(value: string, email: string): string | null {
  const cleaned = value
    .trim()
    .replace(/["']+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\(via Google (?:Sheets|Slides|Docs)\)\s*/gi, "")
    .replace(/\s*\([^)]*@[^)]*\)\s*/g, "")
    .replace(/[\s*#]+$/g, "")
    .trim();

  if (!cleaned || cleaned.toLowerCase() === email.toLowerCase()) return null;
  return cleaned;
}

function parseMemberRows(input: string) {
  const submitted = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
  const seen = new Set<string>();
  let skippedInvalid = 0;
  let skippedDuplicate = 0;
  const members = input
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];

      const fields = trimmed.includes("\t")
        ? trimmed.split("\t").map((field) => field.trim())
        : parseCsvLine(trimmed);

      let emailField: string | undefined;
      for (let i = fields.length - 1; i >= 0; i--) {
        if (EMAIL_RE.test(fields[i].replace(/["']+$/g, "").toLowerCase())) {
          emailField = fields[i];
          break;
        }
      }
      if (!emailField) {
        return trimmed
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .map((email) => ({ email, metadata: {} as Json }));
      }

      const email = emailField.replace(/["']+$/g, "").toLowerCase();
      const rank = fields[0] && /^\d+$/.test(fields[0]) ? Number(fields[0]) : null;
      const rawName = fields.length >= 3 ? fields[1] : "";
      const name = rawName ? cleanImportedName(rawName, email) : null;
      const displayName = name && rank !== null ? `${name} (rank: ${rank})` : name;
      const metadata: Record<string, Json> = {};

      if (rank !== null) metadata.rank = rank;
      if (name) metadata.name = name;
      if (displayName) metadata.display_name = displayName;

      return [{ email, metadata: metadata as Json }];
    })
    .flatMap((member) => {
      if (!EMAIL_RE.test(member.email)) {
        skippedInvalid += 1;
        return [];
      }
      if (seen.has(member.email)) {
        skippedDuplicate += 1;
        return [];
      }
      seen.add(member.email);
      return [member];
    });

  return {
    members,
    skippedInvalid,
    skippedDuplicate,
    submitted,
  };
}

const UpsertListSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default(""),
});

const ImportMembersSchema = z.object({
  listId: z.string().uuid(),
  members: z.string().max(20_000_000).optional().default(""),
});

const SuppressListMemberSchema = z.object({
  listId: z.string().uuid(),
  memberId: z.string().uuid(),
});

async function upsertOwnerAlwaysIncludeMember(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  listId: string,
) {
  const { error } = await supabase.from("list_members").upsert(
    {
      list_id: listId,
      email: OWNER_ALWAYS_INCLUDE_EMAIL,
      status: "active",
      source: "always_include_owner",
      unsubscribed_at: null,
      metadata: {
        name: "Amol Sarva",
        display_name: "Amol Sarva",
        always_include_owner: true,
      } satisfies Json,
    },
    { onConflict: "list_id,email" },
  );
  if (error) throw error;
}

export async function upsertListAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const supabase = getSupabaseAdmin();

  const parsed = UpsertListSchema.safeParse({
    name: String(formData.get("name")).trim(),
    address: String(formData.get("address")).trim().toLowerCase(),
    description: String(formData.get("description")).trim(),
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

  const { name, address, description } = parsed.data;

  // If a list with this address already exists, verify the requesting user
  // owns it before allowing the update — prevents one user from hijacking
  // another user's list by submitting the same address.
  const { data: existing } = await supabase
    .from("lists")
    .select("id, owner_id")
    .eq("address", address)
    .maybeSingle();

  if (existing && existing.owner_id !== userId) {
    throw new Error("A list with this address already exists");
  }

  const { data: upsertedList, error } = await supabase.from("lists").upsert(
    { owner_id: userId, name, address, description },
    { onConflict: "address" },
  ).select("id").single();
  if (error) throw error;
  if (upsertedList?.id) await upsertOwnerAlwaysIncludeMember(supabase, upsertedList.id);

  logAudit({
    userId,
    action: "list.upsert",
    entity: "lists",
    payload: { name, address },
  }).catch(console.error);

  revalidatePath("/lists");
}

export async function importMembersAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const supabase = getSupabaseAdmin();

  const parsed = ImportMembersSchema.safeParse({
    listId: formData.get("listId"),
    members: formData.get("members"),
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

  const listId = parsed.data.listId;
  const uploadedFile = formData.get("membersFile");
  const rawFromFile =
    uploadedFile instanceof File && uploadedFile.size > 0
      ? await uploadedFile.text()
      : "";
  const raw = rawFromFile || parsed.data.members;

  // Verify the requesting user owns the target list.
  const { data: list } = await supabase
    .from("lists")
    .select("id")
    .eq("id", listId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (!list) throw new Error("List not found");

  const { members, skippedInvalid, skippedDuplicate, submitted } = parseMemberRows(raw);
  if (!members.length) throw new Error("No members provided");

  const ownerMember = {
    email: OWNER_ALWAYS_INCLUDE_EMAIL,
    metadata: {
      name: "Amol Sarva",
      display_name: "Amol Sarva",
      always_include_owner: true,
    } as Json,
  };
  const importMembers = members.some((member) => member.email === OWNER_ALWAYS_INCLUDE_EMAIL)
    ? members
    : [...members, ownerMember];

  for (let i = 0; i < importMembers.length; i += IMPORT_MEMBERS_CHUNK_SIZE) {
    const rows = importMembers
      .slice(i, i + IMPORT_MEMBERS_CHUNK_SIZE)
      .map((member) => {
        const blocked = isBlockedRecipientEmail(member.email);
        return {
          list_id: listId,
          email: member.email,
          status: blocked ? "blocked" : "active",
          source: blocked ? "block_list" : "manual",
          unsubscribed_at: blocked ? new Date().toISOString() : null,
          metadata: blocked ? blockedMemberMetadata(member.metadata) : member.metadata,
        };
      });
    const { error } = await supabase
      .from("list_members")
      .upsert(rows, { onConflict: "list_id,email" });
    if (error) throw error;
  }

  logAudit({
    userId,
    action: "list.import_members",
    entity: "lists",
    entityId: listId,
    payload: {
      submitted,
      upserted: importMembers.length,
      skippedInvalid,
      skippedDuplicate,
      chunks: Math.ceil(importMembers.length / IMPORT_MEMBERS_CHUNK_SIZE),
    },
  }).catch(console.error);

  revalidatePath("/lists");
  revalidatePath(`/lists/${listId}`);
  return {
    submitted,
    upserted: importMembers.length,
    skippedInvalid,
    skippedDuplicate,
  };
}

export async function suppressListMemberAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const supabase = getSupabaseAdmin();
  const parsed = SuppressListMemberSchema.safeParse({
    listId: formData.get("listId"),
    memberId: formData.get("memberId"),
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

  const { listId, memberId } = parsed.data;
  const { data: list } = await supabase
    .from("lists")
    .select("id")
    .eq("id", listId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (!list) throw new Error("List not found");

  const { data: member, error: memberError } = await supabase
    .from("list_members")
    .select("id, email, metadata")
    .eq("id", memberId)
    .eq("list_id", listId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new Error("List member not found");
  if (member.email.toLowerCase() === OWNER_ALWAYS_INCLUDE_EMAIL) {
    throw new Error("The list owner address cannot be suppressed");
  }

  const suppressedAt = new Date().toISOString();
  const existingMetadata =
    member.metadata && typeof member.metadata === "object" && !Array.isArray(member.metadata)
      ? member.metadata as Record<string, Json>
      : {};
  const { error: suppressError } = await supabase
    .from("list_members")
    .update({
      status: "blocked",
      source: "manual_suppression",
      unsubscribed_at: suppressedAt,
      metadata: {
        ...existingMetadata,
        suppressed_at: suppressedAt,
        suppression_reason: "manual_list_suppression",
      } satisfies Json,
    })
    .eq("id", memberId)
    .eq("list_id", listId);
  if (suppressError) throw suppressError;

  // Stop this list membership's unsent work without touching successful history.
  const { count: canceledQueueRows, error: queueError } = await supabase
    .from("mail_queue")
    .update(
      {
        status: "canceled",
        locked_at: null,
        last_error: "Canceled after manual list suppression.",
        updated_at: suppressedAt,
      },
      { count: "exact" },
    )
    .eq("list_id", listId)
    .in("status", ["pending", "processing"])
    .filter("payload->>to", "eq", member.email.toLowerCase());
  if (queueError) throw queueError;

  logAudit({
    userId,
    action: "list.suppress_member",
    entity: "list_members",
    entityId: memberId,
    payload: {
      listId,
      email: member.email,
      canceledQueueRows: canceledQueueRows ?? 0,
    },
  }).catch(console.error);

  revalidatePath("/lists");
  revalidatePath(`/lists/${listId}`);
}
