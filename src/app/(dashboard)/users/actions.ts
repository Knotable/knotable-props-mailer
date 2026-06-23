'use server';

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ALLOWED_EMAIL, requireAdminAuthContext } from "@/lib/authAccess";
import { logAudit } from "@/lib/logger";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const UpdateUserAccessSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["admin", "user"]),
  canSend: z.boolean(),
});

export async function updateUserAccessAction(formData: FormData) {
  const auth = await requireAdminAuthContext();
  const parsed = UpdateUserAccessSchema.safeParse({
    id: formData.get("id"),
    role: formData.get("role"),
    canSend: formData.get("canSend") === "on",
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid user access update");
  }

  const supabase = getSupabaseAdmin();
  const { data: target, error: targetError } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (targetError) throw targetError;
  if (!target) throw new Error("User not found");

  const isOwner = target.email.trim().toLowerCase() === ALLOWED_EMAIL.trim().toLowerCase();
  const nextRole = isOwner ? "admin" : parsed.data.role;
  const nextCanSend = isOwner ? true : parsed.data.canSend;

  const { error } = await supabase
    .from("profiles")
    .update({ role: nextRole, can_send: nextCanSend })
    .eq("id", parsed.data.id);
  if (error) throw error;

  logAudit({
    userId: auth.userId,
    action: "user.access_update",
    entity: "profiles",
    entityId: parsed.data.id,
    payload: {
      email: target.email,
      role: nextRole,
      canSend: nextCanSend,
    },
  }).catch(console.error);

  revalidatePath("/users");
}
