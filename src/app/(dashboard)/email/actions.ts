'use server';

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/emailProvider";
import { getDailySentCount, buildSendSchedule, todayUTC } from "@/lib/dailyQuota";
import type { Json } from "@/supabase/types";

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

/**
 * Queue a campaign send to a mailing list, automatically splitting across
 * multiple days if the list is larger than the 45k daily cap.
 *
 * formData fields:
 *   emailId    – UUID of the draft email to send
 *   listId     – UUID of the list whose active members are the recipients
 */
export async function queueCampaignAction(formData: FormData) {
  const supabase   = getSupabaseAdmin();
  const emailId    = String(formData.get("emailId"));
  const listId     = String(formData.get("listId"));

  // Load the email draft.
  const { data: email, error: emailError } = await supabase
    .from("emails")
    .select("from_address, subject, html, text, tags, campaigns")
    .eq("id", emailId)
    .single();
  if (emailError || !email) throw new Error("Email draft not found");

  // Load active list members.
  const { data: members, error: membersError } = await supabase
    .from("list_members")
    .select("email")
    .eq("list_id", listId)
    .eq("status", "active");
  if (membersError) throw membersError;
  if (!members || members.length === 0) throw new Error("List has no active members");

  // Work out the multi-day schedule.
  const today         = todayUTC();
  const sentToday     = await getDailySentCount(today);
  const schedule      = buildSendSchedule(members.length, sentToday, today);
  const campaignLabel = `${emailId}:${today}`;

  // Build mail_queue rows, assigning each recipient to the right calendar day.
  const queueRows: {
    email_id: string;
    payload: Json;
    status: "pending" | "processing" | "succeeded" | "failed" | "dead";
    available_at: string;
    send_date: string | null;
    campaign_label: string;
  }[] = [];

  let memberIndex = 0;
  for (const slot of schedule) {
    // available_at: start of that UTC day (00:05 to avoid midnight edge cases).
    const availableAt = slot.date === today
      ? new Date().toISOString()                       // send today's batch now
      : `${slot.date}T00:05:00.000Z`;                 // future batches at midnight+5

    for (let i = 0; i < slot.count; i++) {
      const member = members[memberIndex++];
      queueRows.push({
        email_id:       emailId,
        payload: {
          from:      email.from_address,
          to:        member.email,
          subject:   email.subject,
          html:      email.html,
          text:      email.text ?? undefined,
          tags:      email.tags ?? [],
          campaigns: email.campaigns ?? [],
        },
        status:         "pending",
        available_at:   availableAt,
        send_date:      null,        // filled in by the worker on actual send
        campaign_label: campaignLabel,
      });
    }
  }

  // Upsert in batches of 500 to stay within Supabase payload limits.
  const CHUNK = 500;
  for (let i = 0; i < queueRows.length; i += CHUNK) {
    const { error } = await supabase
      .from("mail_queue")
      .insert(queueRows.slice(i, i + CHUNK));
    if (error) throw error;
  }

  // Mark the email as queued.
  await supabase
    .from("emails")
    .update({ status: "queued" })
    .eq("id", emailId);

  revalidatePath("/email/schedule");

  return {
    totalRecipients: members.length,
    daysNeeded:      schedule.length,
    schedule:        schedule.map((s) => ({ date: s.date, count: s.count })),
  };
}

export async function sendTestAction(formData: FormData) {
        const recipients = parseRecipients(String(formData.get("recipients")));
        if (!recipients.length) throw new Error("Need at least one recipient");
        // Send individually so recipients never see each other in the To field
        await Promise.all(
                recipients.map((recipient) =>
                        sendEmail({
                                from: String(formData.get("from")),
                                to: [recipient],
                                subject: String(formData.get("subject")),
                                html: String(formData.get("html")),
                                text: (formData.get("text") as string) || undefined,
                                tags: (formData.get("tags") as string | null)?.split(",").map((t) => t.trim()).filter(Boolean),
                                campaigns: (formData.get("campaigns") as string | null)?.split(",").map((c) => c.trim()).filter(Boolean),
                                testMode: true,
                        })
                )
        );
}
