import { createServerAppClient } from "@/lib/authAccess";
import { ComposerForm } from "./composer-form";

type Props = {
  searchParams: Promise<{ id?: string; cloneId?: string }>;
};

export default async function ComposerPage({ searchParams }: Props) {
  const { id, cloneId } = await searchParams;
  const sourceId = cloneId ?? id;
  const templateMode = Boolean(cloneId);
  const supabase = await createServerAppClient();

  // Fetch draft if editing
  let draft: {
    id: string;
    from_address: string;
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
    .select("id, name, address")
    .order("name");

  if (sourceId) {
    const [{ data: emailRow }, { data: recipientRows }, { data: queueRow }] =
      await Promise.all([
        supabase
          .from("emails")
          .select("id, from_address, subject, html, scheduled_at, campaigns, tags")
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

  return (
    <ComposerForm
      draft={draft}
      lists={lists ?? []}
      templateMode={templateMode}
    />
  );
}
