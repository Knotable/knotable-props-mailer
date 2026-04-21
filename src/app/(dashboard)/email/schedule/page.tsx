import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { cancelEmailAction, deleteEmailAction } from "../actions";

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
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Queue</p>
        <h2 className="text-2xl font-semibold text-slate-900">Drafts &amp; Scheduled</h2>
        <p className="text-sm text-slate-500">Drafts you&apos;re working on, plus emails queued to send.</p>
      </header>

      <div className="divide-y rounded-lg border border-slate-200">
        {emails?.length ? (
          emails.map((item) => {
            const isDraft = item.status === "draft";
            const isQueued = item.status === "queued" || item.status === "sending";

            return (
              <div
                key={item.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                {/* Left: subject + status badge */}
                <div className="flex items-center gap-3 min-w-0">
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

                {/* Middle: send time */}
                <div className="shrink-0 text-sm text-slate-500">
                  {item.scheduled_at
                    ? new Date(item.scheduled_at).toLocaleString()
                    : isDraft
                    ? "Not scheduled"
                    : "Send ASAP"}
                </div>

                {/* Right: action buttons */}
                <div className="flex shrink-0 gap-2">
                  <Link
                    href={`/email/composer?id=${item.id}`}
                    className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Edit
                  </Link>

                  {/* Cancel (queued only) — removes from queue, marks canceled */}
                  {isQueued && (
                    <form action={cancelEmailAction}>
                      <input type="hidden" name="id" value={item.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-orange-200 px-3 py-1 text-xs font-medium text-orange-600 hover:bg-orange-50"
                      >
                        Cancel
                      </button>
                    </form>
                  )}

                  {/* Delete — removes entirely */}
                  <form
                    action={deleteEmailAction}
                    onSubmit={(e) => {
                      if (!confirm(`Delete "${item.subject || "this draft"}"?`)) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="id" value={item.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </form>
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
