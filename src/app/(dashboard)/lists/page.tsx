import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { importMembersAction, upsertListAction } from "./actions";

export default async function ListsPage() {
  const supabase = await createServerSupabaseClient();
  const { data: lists } = await supabase.from("lists").select("id, name, address, description, updated_at").order("updated_at", { ascending: false });

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Mailing Lists</p>
        <h2 className="text-2xl font-semibold text-slate-900">Manage Lists</h2>
        <p className="text-sm text-slate-500">Supabase-backed lists stay local; future work will push them to SES suppression lists.</p>
      </header>
      <form action={upsertListAction} className="rounded-lg border border-slate-200 bg-slate-50 p-6">
        <p className="text-sm font-medium text-slate-700">Create or update list</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-600">
            Name
            <input name="name" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm font-medium text-slate-600">
            Address
            <input name="address" required placeholder="weekly@knotable.com" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
          </label>
        </div>
        <label className="mt-3 block text-sm font-medium text-slate-600">
          Description
          <input name="description" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <button type="submit" className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
          Save list
        </button>
      </form>
      <div className="divide-y rounded-xl border border-slate-200">
        {lists?.length ? (
          lists.map((list) => (
            <div key={list.id} className="space-y-3 p-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{list.name}</p>
                  <p className="text-xs text-slate-500">{list.address}</p>
                </div>
                <p className="text-xs text-slate-400">Updated {list.updated_at ? new Date(list.updated_at).toLocaleString() : "--"}</p>
              </div>
              <form action={importMembersAction} className="space-y-2 rounded-lg border border-dashed border-slate-300 p-3">
                <input type="hidden" name="listId" value={list.id} />
                <label className="text-sm font-medium text-slate-700">
                  Paste members (CSV or newline)
                  <textarea name="members" rows={3} placeholder="address@example.com" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
                </label>
                <button className="rounded-md border border-slate-200 px-3 py-1 text-xs">Import / Upsert</button>
              </form>
            </div>
          ))
        ) : (
          <p className="p-6 text-sm text-slate-500">No lists yet.</p>
        )}
      </div>
    </div>
  );
}
