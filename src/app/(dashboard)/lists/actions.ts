'use server';

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

const FALLBACK_USER_ID = "00000000-0000-0000-0000-000000000001";

async function getAuthUserId(): Promise<string> {
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? FALLBACK_USER_ID;
  } catch {
    return FALLBACK_USER_ID;
  }
}

const parseEmails = (input: string) =>
  input
    .split(/[\n,]/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

export async function upsertListAction(formData: FormData) {
  const supabase = getSupabaseAdmin();
  const ownerId = await getAuthUserId();

  const name        = String(formData.get("name"));
  const address     = String(formData.get("address"));
  const description = String(formData.get("description"));

  const { error } = await supabase.from("lists").upsert(
    { owner_id: ownerId, name, address, description },
    { onConflict: "address" },
  );
  if (error) throw error;
  revalidatePath("/lists");
}

export async function importMembersAction(formData: FormData) {
  const supabase = getSupabaseAdmin();
  const listId = String(formData.get("listId"));
  const raw    = String(formData.get("members"));
  const emails = parseEmails(raw).slice(0, 10_000);
  if (!emails.length) throw new Error("No members provided");

  const rows = emails.map((email) => ({ list_id: listId, email, status: "active" }));
  const { error } = await supabase
    .from("list_members")
    .upsert(rows, { onConflict: "list_id,email" });
  if (error) throw error;
  revalidatePath("/lists");
}
