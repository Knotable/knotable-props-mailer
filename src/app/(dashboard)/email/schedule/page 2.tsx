import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { ScheduleActions, TriggerQueueButton } from "./schedule-actions";

export default async function SchedulePage() {
  const supabase = await createServerSupabaseClient();

  // Show drafts and anything actively queued/sending. Exclude sent/failed/canceled.
  const { data: emails } = await supabase
    .from("emails")
    .select("id, subject, scheduled_at, status")
    .in("status", ["draft", "queued", "sending"])
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Queue</p>
          <h2 className="text-2xl font-semibold text-slate-900">Drafts &amp; Scheduled</h2>
          <p className="text-sm text-slate-500">
            Drafts you&apos;re working on, plus emails queued to send.
          </p>
        </div>
        {/* Manual queue trigger — works around the daily-only Hobby plan cron */}
        <TriggerQueueButton />
      </header>

      <div className="divide-y rounded-lg border border-slate-200">
        {emails?.length ? (
          emails.map((item) => {
            const isDraft = item.status === "draft";
            const isQueued = item.status === "queued" || item.status === "sending";

            // Format date as ISO string on the server; the client component can
            // display it however it likes — avoids hydration mismatches.
            const scheduledIso = item.scheduled_at ?? null;

            return (
              <div
                key={item.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                {/* Left: subject + status badge */}
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      isDraft
                        ? "bg-slate-100 text-slate-600"
                        : "bg-blue-100 text-blue-700"
                    }`}
                  >
                    {isDraft ? "Draft" : item.status === "sending" ? "Sending" : "Scheduled"}
                  </span>
                  <p className="truncate text-sm font-medium text-slate-800">
                    {item.subject || "(no subject)"}
                  </p>
                </div>

                {/* Middle: send time — rendered as static text to avoid hydration issues */}
                <div className="shrink-0 text-sm text-slate-500">
                  {scheduledIso
                    ? scheduledIso.replace("T", " ").slice(0, 16) + " UTC"
                    : isDraft
                    ? "Not scheduled"
                    : "Send ASAP"}
                </div>

                {/* Right: Edit link + client-side Cancel/Delete buttons */}
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href={`/email/composer?id=${item.id}`}
                    className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Edit
                  </Link>
                  <ScheduleActions
                    id={item.id}
                    subject={item.subject ?? ""}
                    isQueued={isQueued}
                  />
                </div>
              </div>
            );
          })
        ) : (
          <p className="p-6 text-sm text-slate-500">No drafts or scheduled emails.</p>
        )}
      </div>
    </div>
  );
}
