import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { saveDraftAction, sendTestAction } from "../actions";

type Props = {
  searchParams: Promise<{ id?: string }>;
};

export default async function ComposerPage({ searchParams }: Props) {
  const { id } = await searchParams;

  let draft: {
    id: string;
    from_address: string;
    subject: string;
    html: string;
    scheduled_at: string | null;
    campaigns: string[];
    tags: string[];
    recipients: string[];
  } | null = null;

  if (id) {
    const supabase = await createServerSupabaseClient();
    const [{ data: emailRow }, { data: recipientRows }] = await Promise.all([
      supabase
        .from("emails")
        .select("id, from_address, subject, html, scheduled_at, campaigns, tags")
        .eq("id", id)
        .single(),
      supabase
        .from("email_recipients")
        .select("recipient_address")
        .eq("email_id", id),
    ]);

    if (emailRow) {
      draft = {
        ...emailRow,
        recipients: recipientRows?.map((r) => r.recipient_address) ?? [],
      };
    }
  }

  const scheduledAtLocal = draft?.scheduled_at
    ? new Date(draft.scheduled_at).toISOString().slice(0, 16)
    : "";

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs uppercase tracking-wide text-slate-400">
          {draft ? "Editing Draft" : "Draft"}
        </p>
        <h2 className="text-2xl font-semibold text-slate-900">Compose Email</h2>
        <p className="text-sm text-slate-500">
          This mirrors the original Props composer and hooks into Supabase + Amazon SES.
        </p>
      </section>
      <form action={saveDraftAction} className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-6">
        {/* Pass the draft id so saveDraftAction updates instead of inserts */}
        {draft && <input type="hidden" name="id" value={draft.id} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            From
            <input
              name="from"
              required
              defaultValue={draft?.from_address ?? "Kmail <amol@sarva.co>"}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Scheduled send (optional)
            <input
              name="scheduledAt"
              type="datetime-local"
              defaultValue={scheduledAtLocal}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
        </div>
        <label className="text-sm font-medium text-slate-700">
          Subject
          <input
            name="subject"
            required
            defaultValue={draft?.subject ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Recipients
          <textarea
            name="recipients"
            required
            rows={3}
            defaultValue={draft?.recipients.join("\n") ?? ""}
            placeholder="listname@domain.com or comma/newline separated"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          HTML
          <textarea
            name="html"
            required
            rows={8}
            defaultValue={draft?.html ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Campaigns
            <input
              name="campaigns"
              placeholder="campaign-a,campaign-b"
              defaultValue={draft?.campaigns.join(",") ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Tags
            <input
              name="tags"
              placeholder="weekly,update"
              defaultValue={draft?.tags.join(",") ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            Save Draft
          </button>
          <button
            formAction={sendTestAction}
            className="rounded-md border border-slate-900 px-4 py-2 text-sm font-semibold text-slate-900"
          >
            Send Test
          </button>
        </div>
      </form>
    </div>
  );
}
