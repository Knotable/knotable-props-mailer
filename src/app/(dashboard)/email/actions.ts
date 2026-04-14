'use server';

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";

const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001";

type DraftPayload = {
    from: string;
    subject: string;
    html: string;
    recipients: string;
    scheduledAt?: string;
    campaigns?: string;
    tags?: string;
};

const parseRecipients = (input: string) =>
    input
    .split(/[,\n]/)
    .map((r) => r.trim())
    .filter(Boolean);

export async function saveDraftAction(formData: FormData) {
    const payload: DraftPayload = {
          from: String(formData.get("from")),
          subject: String(formData.get("subject")),
          html: String(formData.get("html")),
          recipients: String(formData.get("recipients")),
          scheduledAt: formData.get("scheduledAt") as string | undefined,
          campaigns: formData.get("campaigns") as string | undefined,
          tags: formData.get("tags") as string | undefined,
    };

  const supabase = getSupabaseAdmin();

  const { error } = await supabase.from("emails").insert({
        author_id: ADMIN_USER_ID,
        from_address: payload.from,
        subject: payload.subject,
        html: payload.html,
        text: payload.html.replace(/<[^>]+>/g, " "),
        status: "draft",
        scheduled_at: payload.scheduledAt ? new Date(payload.scheduledAt).toISOString() : null,
        campaigns: payload.campaigns?.split(",").map((c) => c.trim()).filter(Boolean) ?? [],
        tags: payload.tags?.split(",").map((t) => t.trim()).filter(Boolean) ?? [],
  });

  if (error) throw error;
    revalidatePath("/email/schedule");
}

export async function sendTestAction(formData: FormData) {
    const recipients = parseRecipients(String(formData.get("recipients")));
    if (!recipients.length) throw new Error("Need at least one recipient");
    await sendEmail({
          from: String(formData.get("from")),
          to: recipients,
          subject: String(formData.get("subject")),
          html: String(formData.get("html")),
          text: (formData.get("text") as string) || undefined,
          tags: (formData.get("tags") as string | null)?.split(",").map((t) => t.trim()).filter(Boolean),
          campaigns: (formData.get("campaigns") as string | null)?.split(",").map((c) => c.trim()).filter(Boolean),
          testMode: true,
    });
}
