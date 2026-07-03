import { requireServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { applyBlockListAction, upsertListAction } from "./actions";
import { ImportMembersForm } from "./import-members-form";
import Link from "next/link";
import { BLOCKED_EMAIL_DOMAINS } from "@/lib/blockList";

export default async function ListsPage() {
  await requireServerAuthContext();
  const supabase = getSupabaseAdmin();
  const { data: lists } = await supabase
    .from("lists")
    .select("id, name, address, description, updated_at, list_members(count)")
    .order("updated_at", { ascending: false });

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Mailing Lists</p>
        <h2 className="text-2xl font-semibold text-slate-900">Manage Lists</h2>
        <p className="text-sm text-slate-500">Supabase-backed lists stay local; future work will push them to SES suppression lists.</p>
      </header>
      <form action={applyBlockListAction} className="rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-red-900">Block List</p>
            <p className="text-sm text-red-700">
              Globally suppresses {BLOCKED_EMAIL_DOMAINS.map((domain) => `*@${domain}`).join(", ")} from campaign queues.
            </p>
          </div>
          <button
            type="submit"
            className="shrink-0 rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
          >
            Apply block list
          </button>
        </div>
      </form>
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
          lists.map((list) => {
            const memberCount = (list.list_members as { count: number }[])?.[0]?.count ?? 0;
            return (
              <div key={list.id} className="space-y-3 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <Link
                      href={`/lists/${list.id}`}
                      className="text-sm font-semibold text-slate-900 hover:text-blue-600 hover:underline"
                    >
                      {list.name}
                    </Link>
                    <p className="text-xs text-slate-500">{list.address}</p>
                    {list.description && (
                      <p className="mt-0.5 text-xs text-slate-400">{list.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Link
                      href={`/lists/${list.id}`}
                      className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 hover:bg-blue-100 hover:text-blue-700"
                    >
                      {memberCount.toLocaleString()} member{memberCount !== 1 ? "s" : ""}
                    </Link>
                    <p className="text-xs text-slate-400">
                      Updated {list.updated_at ? new Date(list.updated_at).toLocaleString() : "—"}
                    </p>
                  </div>
                </div>
                <ImportMembersForm listId={list.id} />
              </div>
            );
          })
        ) : (
          <p className="p-6 text-sm text-slate-500">No lists yet.</p>
        )}
      </div>
    </div>
  );
}
