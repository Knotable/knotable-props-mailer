import { requireServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getTemplate, listTemplates, summarize, templateHtml } from "@/lib/emailTemplates";
import { ComposerForm } from "./composer-form";

// Bulk queue cleanup (unqueue/delete on large campaigns) runs in bounded
// batches for up to ~40 s; give these server actions room to finish.
export const maxDuration = 60;

type Props = {
  searchParams: Promise<{ id?: string; cloneId?: string; template?: string }>;
};

export default async function ComposerPage({ searchParams }: Props) {
  const { id, cloneId, template: templateId } = await searchParams;
  const startTemplate = !id && !cloneId && templateId ? await getTemplate(templateId).catch(() => null) : null;
  const sourceId = cloneId ?? id;
  const templateMode = Boolean(cloneId) || Boolean(startTemplate);
  const templates = (await listTemplates().catch(() => [])).map(summarize);
  const auth = await requireServerAuthContext();
  const supabase = getSupabaseAdmin();

  // Fetch draft if editing
  let draft: {
    id: string;
    from_address: string;
    reply_to: string | null;
    subject: string;
    html: string;
    scheduled_at: string | null;
    campaigns: string[];
    tags: string[];
    recipients: string[];
    list_id: string | null;
  } | null = null;

  // Fetch available lists for the picker (needed for list detection below too)
  const { data: lists } = await supabase
    .from("lists")
    .select("id, name, address, access_level")
    .order("name");

  if (sourceId) {
    const [{ data: emailRow }, { data: recipientRows }, { data: queueRow }] =
      await Promise.all([
        supabase
          .from("emails")
          .select("id, from_address, reply_to, subject, html, scheduled_at, campaigns, tags")
          .eq("id", sourceId)
          .single(),
        supabase
          .from("email_recipients")
          .select("recipient_address")
          .eq("email_id", sourceId),
        // Check if this draft was already queued to a list
        supabase
          .from("mail_queue")
          .select("list_id")
          .eq("email_id", sourceId)
          .not("list_id", "is", null)
          .limit(1)
          .maybeSingle(),
      ]);

    if (emailRow) {
      const recipients = recipientRows?.map((r) => r.recipient_address) ?? [];

      // Prefer the list_id from a queued row; fall back to matching a recipient
      // address against known list addresses (handles drafts not yet queued).
      let resolvedListId: string | null = (queueRow?.list_id as string | null) ?? null;
      if (!resolvedListId && recipients.length === 1) {
        const matchedList = lists?.find(
          (l) => l.address.toLowerCase() === recipients[0].toLowerCase(),
        );
        if (matchedList) resolvedListId = matchedList.id;
      }

      draft = {
        ...emailRow,
        recipients,
        list_id: resolvedListId,
      };
    }
  }

  if (startTemplate) {
    draft = {
      id: `template:${startTemplate.id}`,
      from_address: startTemplate.fromAddress || "Amol Sarva <amol@lifex.vc>",
      reply_to: startTemplate.replyTo || "amol@lifex.vc",
      subject: startTemplate.subject,
      html: templateHtml(startTemplate),
      scheduled_at: null,
      campaigns: [],
      tags: [],
      recipients: [],
      list_id: null,
    };
  }

  return (
    <ComposerForm
      key={startTemplate ? `template:${startTemplate.id}` : (sourceId ?? "new")}
      templates={templates}
      activeTemplateId={startTemplate?.id ?? null}
      draft={draft}
      lists={lists ?? []}
      templateMode={templateMode}
      userEmail={auth.email}
      canSend={auth.canSend}
    />
  );
}
