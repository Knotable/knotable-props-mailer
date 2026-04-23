import { createServerAppClient } from "@/lib/authAccess";
import { ComposerForm } from "./composer-form";

type Props = {
  searchParams: Promise<{ id?: string }>;
};

export default async function ComposerPage({ searchParams }: Props) {
  const { id } = await searchParams;
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

  if (id) {
    const [{ data: emailRow }, { data: recipientRows }, { data: queueRow }] =
      await Promise.all([
        supabase
          .from("emails")
          .select("id, from_address, subject, html, scheduled_at, campaigns, tags")
          .eq("id", id)
          .single(),
        supabase
          .from("email_recipients")
          .select("recipient_address")
          .eq("email_id", id),
        // Check if this draft was already queued to a list
        supabase
          .from("mail_queue")
          .select("list_id")
          .eq("email_id", id)
          .not("list_id", "is", null)
          .limit(1)
          .maybeSingle(),
      ]);

    if (emailRow) {
      draft = {
        ...emailRow,
        recipients: recipientRows?.map((r) => r.recipient_address) ?? [],
        list_id: (queueRow?.list_id as string | null) ?? null,
      };
    }
  }

  // Fetch available lists for the picker
  const { data: lists } = await supabase
    .from("lists")
    .select("id, name, address")
    .order("name");

  return (
    <ComposerForm
      draft={draft}
      lists={lists ?? []}
    />
  );
}
