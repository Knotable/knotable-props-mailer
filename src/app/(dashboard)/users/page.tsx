import { requireAdminAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { updateUserAccessAction } from "./actions";

export default async function UsersPage() {
  await requireAdminAuthContext();
  const supabase = getSupabaseAdmin();
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, email, role, can_send, created_at")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Admin</p>
        <h2 className="text-2xl font-semibold text-slate-900">Users</h2>
        <p className="text-sm text-slate-500">
          New accounts can draft and review shared mail by default. Enable sending only for trusted accounts.
        </p>
      </header>
      <table className="w-full table-auto text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-500">
            <th className="pb-2">Email</th>
            <th className="pb-2">Role</th>
            <th className="pb-2">Can send</th>
            <th className="pb-2">Created</th>
            <th className="pb-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {profiles?.length ? (
            profiles.map((user) => (
              <tr key={user.id}>
                <td className="py-3 font-medium text-slate-800">{user.email}</td>
                <td className="py-3 text-slate-500">
                  <form id={`user-access-${user.id}`} action={updateUserAccessAction}>
                    <input type="hidden" name="id" value={user.id} />
                    <select
                      name="role"
                      defaultValue={user.role === "admin" ? "admin" : "user"}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </form>
                </td>
                <td className="py-3 text-slate-500">
                  <label className="inline-flex items-center gap-2">
                    <input
                      form={`user-access-${user.id}`}
                      name="canSend"
                      type="checkbox"
                      defaultChecked={Boolean((user as { can_send?: boolean | null }).can_send)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    <span className="text-xs text-slate-500">SES send access</span>
                  </label>
                </td>
                <td className="py-3 text-slate-500">{user.created_at ? new Date(user.created_at).toLocaleString() : "--"}</td>
                <td className="py-3 text-right">
                  <button
                    form={`user-access-${user.id}`}
                    className="rounded-md bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700"
                  >
                    Save
                  </button>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={5} className="py-6 text-center text-sm text-slate-500">
                No users yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
