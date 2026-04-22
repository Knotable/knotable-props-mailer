'use server';

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { logAudit } from "@/lib/logger";

async function requireAuthUserId(): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) throw new Error("Unauthorized");
  return user.id;
}

const parseEmails = (input: string) =>
  input
    .split(/[\n,]/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

export async function upsertListAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const supabase = getSupabaseAdmin();

  const name = String(formData.get("name")).trim().slice(0, 200);
  const address = String(formData.get("address")).trim().toLowerCase().slice(0, 200);
  const description = String(formData.get("description")).trim().slice(0, 1000);

  if (!name) throw new Error("List name is required");
  if (!address) throw new Error("List address is required");

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

  const listId = String(formData.get("listId"));
  const raw = String(formData.get("members"));

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
