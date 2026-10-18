"use server";

import { revalidatePath } from "next/cache";
import { requireCanSendAuthContext } from "@/lib/authAccess";
import { listTemplates, saveTemplate } from "@/lib/emailTemplates";
import { logAudit } from "@/lib/logger";
import { getAutopilotRecord, isActiveAutopilot } from "@/lib/sendAutopilot";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { replaceLink } from "@/lib/linkReplace";

// Swaps one link in a queued campaign's body (and optionally every template)
// without unqueueing its recipients. Refused while the campaign is actively
// sending. Because the content digest changes, any earlier approval no longer
// matches: the campaign must be approved again before it sends.
export async function replaceCampaignLinkAction(formData: FormData): Promise<{
  error?: string;
  campaignReplacements?: number;
  templatesUpdated?: number;
}> {
  try {
    const auth = await requireCanSendAuthContext();
    const emailId = String(formData.get("id") ?? "").trim();
    const find = String(formData.get("find") ?? "").trim();
    const replace = String(formData.get("replace") ?? "").trim();
    const alsoTemplates = String(formData.get("templates") ?? "") === "yes";
    if (!/^[0-9a-f-]{36}$/i.test(emailId)) return { error: "Invalid campaign id." };
    if (!/^https?:\/\/\S{6,}$/.test(find)) return { error: "The link to replace must be a full http(s) URL." };
    if (!/^https:\/\/\S{6,}$/.test(replace)) return { error: "The new link must be a full https URL." };
    if (find === replace) return { error: "The new link is the same as the old one." };

    const record = await getAutopilotRecord(emailId);
    if (record && (isActiveAutopilot(record) || record.state === "preparing")) {
      return { error: `The campaign is ${record.state}. Pause it first, then replace the link.` };
    }
    const supabase = getSupabaseAdmin();
    const { data: email, error } = await supabase.from("emails").select("html, text, status").eq("id", emailId).maybeSingle();
    if (error) return { error: error.message };
    if (!email) return { error: "Campaign not found." };
    if (email.status === "sent") return { error: "This campaign has already been sent." };

    const html = replaceLink(email.html ?? "", find, replace);
    const text = replaceLink(email.text ?? "", find, replace);
    if (html.count + text.count > 0) {
      const { error: updateError } = await supabase
        .from("emails")
        .update({ html: html.value, text: email.text == null ? null : text.value, updated_at: new Date().toISOString() })
        .eq("id", emailId);
      if (updateError) return { error: updateError.message };
    }

    let templatesUpdated = 0;
    if (alsoTemplates) {
      for (const template of await listTemplates()) {
        const body = replaceLink(template.body, find, replace);
        if (!body.count) continue;
        const { name, description, subject, format, fromAddress, replyTo } = template;
        await saveTemplate(template.id, { name, description, subject, format, fromAddress, replyTo, body: body.value });
        templatesUpdated += 1;
      }
    }

    logAudit({
      userId: auth.userId,
      action: "email.replace_link",
      entity: "emails",
      entityId: emailId,
      payload: { find, replace, campaignReplacements: html.count + text.count, templatesUpdated },
    }).catch(console.error);
    revalidatePath("/email/schedule");
    revalidatePath("/email/templates");
    return { campaignReplacements: html.count + text.count, templatesUpdated };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not replace the link." };
  }
}
