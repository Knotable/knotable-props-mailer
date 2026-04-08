import { createServerSupabaseClient } from "@/lib/supabaseServer";

export default async function SchedulePage() {
  const supabase = await createServerSupabaseClient();
  const { data: emails } = await supabase
    .from("emails")
    .select("id, subject, scheduled_at, status")
    .order("scheduled_at", { ascending: true })
    .limit(25);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Queue</p>
        <h2 className="text-2xl font-semibold text-slate-900">Scheduled Sends</h2>
        <p className="text-sm text-slate-500">Connected to Supabase `emails` table.</p>
      </header>
      <div className="divide-y rounded-lg border border-slate-200">
        {emails?.length ? (
          emails.map((item) => (
            <div key={item.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-800">{item.subject}</p>
                <p className="text-xs text-slate-500">Status: {item.status}</p>
              </div>
              <div className="text-sm text-slate-600">
                {item.scheduled_at ? new Date(item.scheduled_at).toLocaleString() : "Send ASAP"}
              </div>
              <div className="flex gap-2">
                <button className="rounded-md border border-slate-200 px-3 py-1 text-xs">Pause</button>
                <button className="rounded-md border border-red-200 px-3 py-1 text-xs text-red-600">Cancel</button>
              </div>
            </div>
          ))
        ) : (
          <p className="p-6 text-sm text-slate-500">No queued emails yet.</p>
        )}
      </div>
    </div>
  );
}
