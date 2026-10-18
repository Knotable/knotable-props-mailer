import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// Reusable email templates. Stored in app_settings (one row per template,
// key "email_template:<id>") so no migration is needed. Built-in templates
// live in code; editing one saves a stored copy under the same id that then
// takes precedence, and deleting that copy restores the built-in.

export const TEMPLATE_KEY_PREFIX = "email_template:";
export * from "@/lib/emailTemplateCore";
import { BUILT_IN_TEMPLATES, type EmailTemplate, type TemplateSummary } from "@/lib/emailTemplateCore";

const isTemplateValue = (value: unknown): value is EmailTemplate =>
  Boolean(value && typeof value === "object" && typeof (value as EmailTemplate).id === "string" && typeof (value as EmailTemplate).body === "string");

async function loadStored(): Promise<EmailTemplate[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_settings")
    .select("value")
    .like("key", `${TEMPLATE_KEY_PREFIX}%`);
  if (error) throw new Error(`load templates: ${error.message}`);
  return ((data ?? []) as Array<{ value: unknown }>).map((row) => row.value).filter(isTemplateValue);
}

export async function listTemplates(): Promise<EmailTemplate[]> {
  const stored = await loadStored();
  const byId = new Map(stored.map((template) => [template.id, template]));
  const builtIns = BUILT_IN_TEMPLATES.map((template) => {
    const override = byId.get(template.id);
    return override ? { ...override, builtIn: true, overridden: true } : template;
  });
  const custom = stored.filter((template) => !BUILT_IN_TEMPLATES.some((builtIn) => builtIn.id === template.id));
  return [...builtIns, ...custom.sort((a, b) => a.name.localeCompare(b.name))];
}

export async function getTemplate(id: string): Promise<EmailTemplate | null> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("app_settings")
    .select("value")
    .eq("key", `${TEMPLATE_KEY_PREFIX}${id}`)
    .maybeSingle();
  if (error) throw new Error(`load template: ${error.message}`);
  const stored = (data as { value?: unknown } | null)?.value;
  const builtIn = BUILT_IN_TEMPLATES.find((template) => template.id === id);
  if (isTemplateValue(stored)) return builtIn ? { ...stored, builtIn: true, overridden: true } : stored;
  return builtIn ?? null;
}

export async function saveTemplate(
  id: string | null,
  value: Pick<EmailTemplate, "name" | "description" | "subject" | "format" | "body" | "fromAddress" | "replyTo">,
  extra: { sourceEmailId?: string | null } = {},
): Promise<EmailTemplate> {
  const existing = id ? await getTemplate(id) : null;
  if (id && !existing) throw new Error("Template not found.");
  const now = new Date().toISOString();
  const template: EmailTemplate = {
    id: existing?.id ?? randomUUID(),
    ...value,
    sourceEmailId: extra.sourceEmailId ?? existing?.sourceEmailId ?? null,
    builtIn: existing?.builtIn ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  delete template.overridden;
  const { error } = await getSupabaseAdmin()
    .from("app_settings")
    .upsert(
      { key: `${TEMPLATE_KEY_PREFIX}${template.id}`, value: template, description: `Email template: ${template.name}`, updated_at: now },
      { onConflict: "key" },
    );
  if (error) throw new Error(`save template: ${error.message}`);
  return template;
}

/** Deletes a custom template, or resets an edited built-in to its default. */
export async function deleteTemplate(id: string) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error("Template not found.");
  const { error } = await getSupabaseAdmin().from("app_settings").delete().eq("key", `${TEMPLATE_KEY_PREFIX}${id}`);
  if (error) throw new Error(`delete template: ${error.message}`);
}

export function summarize(template: EmailTemplate): TemplateSummary {
  const { id, name, description, format, subject, builtIn, overridden, updatedAt } = template;
  return { id, name, description, format, subject, builtIn, overridden, updatedAt };
}
