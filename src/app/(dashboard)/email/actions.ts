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
        const id = formData.get("id") as string | null;
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

    const emailFields = {
                from_address: payload.from,
                subject: payload.subject,
                html: payload.html,
                text: payload.html.replace(/<[^>]+>/g, " "),
                status: "draft" as const,
                scheduled_at: payload.scheduledAt ? new Date(payload.scheduledAt).toISOString() : null,
                campaigns: payload.campaigns?.split(",").map((c) => c.trim()).filter(Boolean) ?? [],
                tags: payload.tags?.split(",").map((t) => t.trim()).filter(Boolean) ?? [],
    };

    let emailId: string;

    if (id) {
        // Update existing draft
        const { error } = await supabase
            .from("emails")
            .update(emailFields)
            .eq("id", id);
        if (error) throw error;
        emailId = id;

        // Replace recipients: delete old ones, insert new
        const { error: delError } = await supabase
            .from("email_recipients")
            .delete()
            .eq("email_id", emailId);
        if (delError) throw delError;
    } else {
        // Insert new draft
        const { data: emailRow, error } = await supabase.from("emails").insert({
            author_id: ADMIN_USER_ID,
            ...emailFields,
        }).select("id").single();
        if (error) throw error;
        emailId = emailRow.id;
    }

    const recipientRows = parseRecipients(payload.recipients).map((addr) => ({
                email_id: emailId,
                recipient_address: addr,
    }));

    if (recipientRows.length) {
        const { error: recipientError } = await supabase
            .from("email_recipients")
            .insert(recipientRows);
        if (recipientError) throw recipientError;
    }

    revalidatePath("/email/schedule");
    revalidatePath("/email/composer");
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
