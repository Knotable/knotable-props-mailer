'use server';

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { logAudit } from "@/lib/logger";

async function requireAuthUserId(): Promise<string> {
  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");
  return auth.userId;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMPORT_MEMBERS_CHUNK_SIZE = 500;

function parseEmailImport(input: string) {
  const tokens = input
    .split(/[\n,]/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  const seen = new Set<string>();
  const emails: string[] = [];
  let skippedInvalid = 0;
  let skippedDuplicate = 0;

  for (const token of tokens) {
    if (!EMAIL_RE.test(token)) {
      skippedInvalid += 1;
      continue;
    }
    if (seen.has(token)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(token);
    emails.push(token);
  }

  return {
    emails,
    skippedInvalid,
    skippedDuplicate,
    submitted: tokens.length,
  };
}

const UpsertListSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default(""),
});

const ImportMembersSchema = z.object({
  listId: z.string().uuid(),
  members: z.string().min(1).max(20_000_000),
});

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

  const { error } = await supabase.from("lists").upsert(
    { owner_id: userId, name, address, description },
    { onConflict: "address" },
  );
  if (error) throw error;

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
  const raw = parsed.data.members;

  // Verify the requesting user owns the target list.
  const { data: list } = await supabase
    .from("lists")
    .select("id")
    .eq("id", listId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (!list) throw new Error("List not found");

  const { emails, skippedInvalid, skippedDuplicate, submitted } = parseEmailImport(raw);
  if (!emails.length) throw new Error("No members provided");

  for (let i = 0; i < emails.length; i += IMPORT_MEMBERS_CHUNK_SIZE) {
    const rows = emails
      .slice(i, i + IMPORT_MEMBERS_CHUNK_SIZE)
      .map((email) => ({ list_id: listId, email, status: "active" }));
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
      upserted: emails.length,
      skippedInvalid,
      skippedDuplicate,
      chunks: Math.ceil(emails.length / IMPORT_MEMBERS_CHUNK_SIZE),
    },
  }).catch(console.error);

  revalidatePath("/lists");
  revalidatePath(`/lists/${listId}`);
  return {
    submitted,
    upserted: emails.length,
    skippedInvalid,
    skippedDuplicate,
  };
}
