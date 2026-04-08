import { createServerSupabaseClient } from "@/lib/supabaseServer";

export default async function UsersPage() {
  const supabase = await createServerSupabaseClient();
  const { data: profiles } = await supabase.from("profiles").select("email, role, created_at");

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Admin</p>
        <h2 className="text-2xl font-semibold text-slate-900">Users</h2>
        <p className="text-sm text-slate-500">Supabase Auth is the source of truth; this table mirrors `profiles`.</p>
      </header>
      <table className="w-full table-auto text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-500">
            <th className="pb-2">Email</th>
            <th className="pb-2">Role</th>
            <th className="pb-2">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {profiles?.length ? (
            profiles.map((user) => (
              <tr key={user.email}>
                <td className="py-3 font-medium text-slate-800">{user.email}</td>
                <td className="py-3 text-slate-500">{user.role}</td>
                <td className="py-3 text-slate-500">{user.created_at ? new Date(user.created_at).toLocaleString() : "--"}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3} className="py-6 text-center text-sm text-slate-500">
                No users yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
