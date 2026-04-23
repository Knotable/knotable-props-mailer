import Link from "next/link";
import { createServerAppClient } from "@/lib/authAccess";
import { ScheduleActions } from "./schedule-actions";

export default async function SchedulePage() {
  const supabase = await createServerAppClient();

  const { data: emails } = await supabase
    .from("emails")
    .select("id, subject, status, updated_at")
    .in("status", ["draft", "queued", "sending"])
    .order("updated_at", { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Queue</p>
          <h2 className="text-2xl font-semibold text-slate-900">Drafts &amp; Queued</h2>
          <p className="text-sm text-slate-500">
            Drafts you&apos;re working on, plus emails held for manual send.
          </p>
        </div>
      </header>

      <div className="divide-y rounded-lg border border-slate-200">
        {emails?.length ? (
          emails.map((item) => {
            const isDraft = item.status === "draft";
            const updatedIso = item.updated_at ?? null;

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
                    {isDraft ? "Draft" : item.status === "sending" ? "Sending" : "Queued"}
                  </span>
                  <p className="truncate text-sm font-medium text-slate-800">
                    {item.subject || "(no subject)"}
                  </p>
                </div>

                <div className="shrink-0 text-sm text-slate-500">
                  {isDraft
                    ? updatedIso
                      ? `Updated ${updatedIso.replace("T", " ").slice(0, 16)} UTC`
                      : "Draft only"
                    : "Queued for manual send"}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {!isDraft && (
                    <Link
                      href={`/api/email/preview/${item.id}`}
                      target="_blank"
                      className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Preview
                    </Link>
                  )}
                  {isDraft && (
                    <Link
                      href={`/email/composer?id=${item.id}`}
                      className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Edit
                    </Link>
                  )}
                  <ScheduleActions
                    id={item.id}
                    subject={item.subject ?? ""}
                    status={item.status}
                  />
                </div>
              </div>
            );
          })
        ) : (
          <p className="p-6 text-sm text-slate-500">No drafts or queued emails.</p>
        )}
      </div>
    </div>
  );
}
