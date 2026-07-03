'use server';

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ensureUserProfile, requireServerAuthContext } from "@/lib/authAccess";
import { env } from "@/lib/env";
import { logAudit, logError } from "@/lib/logger";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

const normalizeEmail = (value: string) => value.trim().toLowerCase();

const UpdateEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

const UpdatePasswordSchema = z
  .object({
    currentPassword: z.string().optional(),
    password: z.string().min(8),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "password-mismatch",
  });

function accountUrl(path = "") {
  return `${env.appBaseUrl.replace(/\/$/, "")}/account${path}`;
}

function redirectToAccount(params: Record<string, string>) {
  const search = new URLSearchParams(params);
  redirect(`/account?${search.toString()}`);
}

async function requireAccountSession() {
  const auth = await requireServerAuthContext();
  if (auth.isBypass) {
    redirectToAccount({ error: "bypass-session" });
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user?.id || user.id !== auth.userId || !user.email) {
    redirectToAccount({ error: "auth-session" });
  }

  return { auth, supabase, user };
}

async function redirectWithLoggedError({
  action,
  userId,
  message,
  error,
}: {
  action: "email" | "password";
  userId: string;
  message: string;
  error: { message?: string; status?: number } | Error;
}) {
  const trace = await logError({
    message,
    source: "account",
    userId,
    payload: {
      action,
      errorMessage: error.message,
      errorStatus: "status" in error ? error.status : undefined,
    },
  });

  redirectToAccount({ error: `${action}-update`, trace });
}

export async function updateAccountEmailAction(formData: FormData) {
  const { auth, supabase, user } = await requireAccountSession();
  const parsed = UpdateEmailSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    redirectToAccount({ error: "invalid-email" });
  }

  const nextEmail = parsed.data.email;
  const currentEmail = normalizeEmail(user.email);
  if (nextEmail === currentEmail) {
    redirectToAccount({ error: "email-unchanged" });
  }

  const { data, error } = await supabase.auth.updateUser(
    { email: nextEmail },
    { emailRedirectTo: accountUrl("?email=confirmed") },
  );

  if (error) {
    await redirectWithLoggedError({
      action: "email",
      userId: auth.userId,
      message: "Account email update failed",
      error,
    });
  }

  const updatedEmail = data.user?.email ? normalizeEmail(data.user.email) : null;
  if (updatedEmail === nextEmail) {
    await ensureUserProfile(auth.userId, nextEmail);
    logAudit({
      userId: auth.userId,
      action: "account.email_update",
      entity: "profiles",
      entityId: auth.userId,
      payload: { previousEmail: currentEmail, nextEmail },
    }).catch(console.error);
    revalidatePath("/account");
    redirectToAccount({ email: "updated" });
  }

  logAudit({
    userId: auth.userId,
    action: "account.email_change_requested",
    entity: "profiles",
    entityId: auth.userId,
    payload: { previousEmail: currentEmail, nextEmail },
  }).catch(console.error);

  revalidatePath("/account");
  redirectToAccount({ email: "confirmation-sent", pending: nextEmail });
}

export async function updateAccountPasswordAction(formData: FormData) {
  const { auth, supabase } = await requireAccountSession();
  const parsed = UpdatePasswordSchema.safeParse({
    currentPassword: String(formData.get("currentPassword") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const error =
      issue?.message === "password-mismatch" ? "password-mismatch" : "weak-password";
    redirectToAccount({ error });
  }

  const currentPassword = parsed.data.currentPassword?.trim();
  const attributes = currentPassword
    ? { password: parsed.data.password, current_password: currentPassword }
    : { password: parsed.data.password };
  const { error } = await supabase.auth.updateUser(attributes);

  if (error) {
    await redirectWithLoggedError({
      action: "password",
      userId: auth.userId,
      message: "Account password update failed",
      error,
    });
  }

  logAudit({
    userId: auth.userId,
    action: "account.password_update",
    entity: "profiles",
    entityId: auth.userId,
  }).catch(console.error);

  redirectToAccount({ password: "updated" });
}
