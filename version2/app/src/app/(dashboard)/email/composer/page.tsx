import { saveDraftAction, sendTestAction } from "../actions";

export default function ComposerPage() {
  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs uppercase tracking-wide text-slate-400">Draft</p>
        <h2 className="text-2xl font-semibold text-slate-900">Compose Email</h2>
        <p className="text-sm text-slate-500">This mirrors the original Props composer and hooks into Supabase + Mailgun.</p>
      </section>
      <form action={saveDraftAction} className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            From
            <input name="from" required defaultValue="Kmail <noreply@knotable.com>" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Scheduled send (optional)
            <input name="scheduledAt" type="datetime-local" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
          </label>
        </div>
        <label className="text-sm font-medium text-slate-700">
          Subject
          <input name="subject" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Recipients
          <textarea
            name="recipients"
            required
            rows={3}
            placeholder="listname@domain.com or comma/newline separated"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          HTML
          <textarea name="html" required rows={8} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Campaigns
            <input name="campaigns" placeholder="campaign-a,campaign-b" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Tags
            <input name="tags" placeholder="weekly,update" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
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
