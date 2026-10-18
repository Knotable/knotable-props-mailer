"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireServerAuthContext } from "@/lib/authAccess";
import { deleteTemplate, normalizeTemplateInput, saveTemplate } from "@/lib/emailTemplates";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type TemplateFormState = { error?: string };

const field = (formData: FormData, name: string) => formData.get(name) ?? undefined;

export async function saveTemplateAction(_prev: TemplateFormState, formData: FormData): Promise<TemplateFormState> {
  await requireServerAuthContext();
  const id = String(formData.get("id") ?? "").trim() || null;
  const parsed = normalizeTemplateInput({
    name: field(formData, "name"),
    description: field(formData, "description"),
    subject: field(formData, "subject"),
    format: field(formData, "format"),
    body: field(formData, "body"),
    fromAddress: field(formData, "fromAddress"),
    replyTo: field(formData, "replyTo"),
  });
  if ("error" in parsed) return { error: parsed.error };
  let savedId: string;
  try {
    savedId = (await saveTemplate(id, parsed.value)).id;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not save the template." };
  }
  revalidatePath("/email/templates");
  revalidatePath("/email/composer");
  redirect(`/email/templates?saved=${encodeURIComponent(savedId)}`);
}

export async function deleteTemplateAction(formData: FormData) {
  await requireServerAuthContext();
  await deleteTemplate(String(formData.get("id") ?? ""));
  revalidatePath("/email/templates");
  revalidatePath("/email/composer");
  redirect("/email/templates?deleted=1");
}

/** Copies a past campaign's subject, sender and HTML into a new template. */
export async function templateFromCampaign(emailId: string, name?: string) {
  if (!/^[0-9a-f-]{36}$/i.test(emailId)) return { error: "Choose a campaign." };
  const { data: email, error } = await getSupabaseAdmin()
    .from("emails")
    .select("subject, html, from_address, reply_to, created_at")
    .eq("id", emailId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!email?.html) return { error: "That campaign has no HTML body." };
  const parsed = normalizeTemplateInput({
    name: name?.trim() || email.subject,
    description: `From the campaign "${email.subject}" (${String(email.created_at ?? "").slice(0, 10)}).`,
    subject: email.subject,
    format: "html",
    body: email.html,
    fromAddress: email.from_address,
    replyTo: email.reply_to,
  });
  if ("error" in parsed) return { error: parsed.error };
  const template = await saveTemplate(null, parsed.value, { sourceEmailId: emailId });
  return { id: template.id, name: template.name };
}

export async function templateFromCampaignAction(formData: FormData) {
  await requireServerAuthContext();
  const result = await templateFromCampaign(String(formData.get("emailId") ?? ""), String(formData.get("name") ?? ""));
  if ("error" in result) redirect(`/email/templates?error=${encodeURIComponent(result.error ?? "Could not save the template.")}`);
  revalidatePath("/email/templates");
  revalidatePath("/email/composer");
  redirect(`/email/templates/${result.id}`);
}
