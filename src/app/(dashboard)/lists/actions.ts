'use server';

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { logAudit } from "@/lib/logger";

async function requireAuthUserId(): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) throw new Error("Unauthorized");
  return user.id;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const parseEmails = (input: string) =>
  input
    .split(/[\n,]/)
    .map((v) => v.trim().toLowerCase())
    .filter((v) => EMAIL_RE.test(v));

const UpsertListSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default(""),
});

const ImportMembersSchema = z.object({
  listId: z.string().uuid(),
  members: z.string().min(1).max(5_000_000),
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

  const emails = parseEmails(raw).slice(0, 10_000);
  if (!emails.length) throw new Error("No members provided");

  const rows = emails.map((email) => ({ list_id: listId, email, status: "active" }));
  const { error } = await supabase
    .from("list_members")
    .upsert(rows, { onConflict: "list_id,email" });
  if (error) throw error;

  logAudit({
    userId,
    action: "list.import_members",
    entity: "lists",
    entityId: listId,
    payload: { count: emails.length },
  }).catch(console.error);

  revalidatePath("/lists");
}
