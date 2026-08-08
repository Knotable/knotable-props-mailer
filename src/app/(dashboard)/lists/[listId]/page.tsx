import { requireServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import Link from "next/link";
import { notFound } from "next/navigation";
import { suppressListMemberAction } from "../actions";

const PAGE_SIZE = 50;

function MemberStatusBadge({ status }: { status: string | null }) {
  const styles: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    blocked: "bg-red-100 text-red-700",
    unsubscribed: "bg-slate-100 text-slate-500",
    bounced: "bg-red-100 text-red-700",
    complained: "bg-orange-100 text-orange-700",
  };
  const label = status ?? "unknown";
  const cls = styles[label] ?? "bg-slate-100 text-slate-500";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function DeliveryBadge({ status, event }: { status: string | null | undefined; event: string | null | undefined }) {
  const raw = status ?? event ?? null;
  if (!raw) return <span className="text-xs text-slate-400">—</span>;

  const styles: Record<string, string> = {
    sent: "bg-blue-100 text-blue-700",
    delivered: "bg-green-100 text-green-700",
    bounced: "bg-red-100 text-red-700",
    complained: "bg-orange-100 text-orange-700",
    pending: "bg-yellow-100 text-yellow-700",
    failed: "bg-red-100 text-red-700",
    opened: "bg-purple-100 text-purple-700",
    clicked: "bg-indigo-100 text-indigo-700",
  };
  const cls = styles[raw] ?? "bg-slate-100 text-slate-500";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {raw}
    </span>
  );
}

type EmailActivity = {
  status: string;
  last_event: string | null;
  updated_at: string | null;
  subject: string | null;
  sent_at: string | null;
};

export default async function ListDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ listId: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { listId } = await params;
  const { page: pageStr, q: rawQuery } = await searchParams;
  const query = rawQuery?.trim().slice(0, 200) ?? "";
  const parsedPage = Number.parseInt(pageStr ?? "1", 10);
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  await requireServerAuthContext();
  const supabase = getSupabaseAdmin();

  // Fetch list details + total member count
  const { data: list } = await supabase
    .from("lists")
    .select("id, name, address, description, updated_at, list_members(count)")
    .eq("id", listId)
    .single();

  if (!list) notFound();

  const totalCount = (list.list_members as { count: number }[])?.[0]?.count ?? 0;
  let matchingCountQuery = supabase
    .from("list_members")
    .select("id", { count: "exact", head: true })
    .eq("list_id", listId);
  if (query) matchingCountQuery = matchingCountQuery.like("email", `${query.toLowerCase()}%`);

  // Fetch paginated members
  let membersQuery = supabase
    .from("list_members")
    .select("id, email, status, source, subscribed_at, unsubscribed_at")
    .eq("list_id", listId)
    .order("subscribed_at", { ascending: false });
  if (query) membersQuery = membersQuery.like("email", `${query.toLowerCase()}%`);
  const [{ count: filteredCount }, { data: members }] = await Promise.all([
    matchingCountQuery,
    membersQuery.range(offset, offset + PAGE_SIZE - 1),
  ]);
  const matchingCount = filteredCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(matchingCount / PAGE_SIZE));

  const pageHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (targetPage > 1) params.set("page", String(targetPage));
    const suffix = params.toString();
    return `/lists/${listId}${suffix ? `?${suffix}` : ""}`;
  };

  // Fetch most recent email activity for each member on this page
  const memberEmails = members?.map((m) => m.email) ?? [];
  const recipientMap: Record<string, EmailActivity> = {};

  if (memberEmails.length > 0) {
    const { data: recipients } = await supabase
      .from("email_recipients")
      .select("recipient_address, status, last_event, updated_at, emails(subject, sent_at)")
      .in("recipient_address", memberEmails)
      .order("updated_at", { ascending: false });

    if (recipients) {
      for (const r of recipients) {
        // Keep only the most-recent record per email address
        if (!recipientMap[r.recipient_address]) {
          const emailRow = Array.isArray(r.emails) ? r.emails[0] : r.emails;
          recipientMap[r.recipient_address] = {
            status: r.status,
            last_event: r.last_event,
            updated_at: r.updated_at,
            subject: (emailRow as { subject?: string } | null)?.subject ?? null,
            sent_at: (emailRow as { sent_at?: string } | null)?.sent_at ?? null,
          };
        }
      }
    }
  }

  // Stats summary
  const activeCount = members?.filter((m) => m.status === "active").length ?? 0;
  const bouncedCount = Object.values(recipientMap).filter(
    (r) => r.status === "bounced" || r.last_event === "bounced"
  ).length;
  const deliveredCount = Object.values(recipientMap).filter(
    (r) => r.status === "sent" || r.status === "delivered"
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href="/lists" className="text-xs text-slate-400 hover:text-slate-600">
            ← Back to Lists
          </Link>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">{list.name}</h2>
          <p className="text-sm text-slate-500">{list.address}</p>
          {list.description && (
            <p className="mt-0.5 text-sm text-slate-400">{list.description}</p>
          )}
        </div>
        <div className="flex gap-4 sm:text-right">
          <div>
            <p className="text-2xl font-bold text-slate-900">{totalCount.toLocaleString()}</p>
            <p className="text-xs text-slate-500">total members</p>
          </div>
          {page === 1 && members && members.length > 0 && (
            <>
              <div>
                <p className="text-2xl font-bold text-green-600">{activeCount}</p>
                <p className="text-xs text-slate-500">active (this page)</p>
              </div>
              {bouncedCount > 0 && (
                <div>
                  <p className="text-2xl font-bold text-red-500">{bouncedCount}</p>
                  <p className="text-xs text-slate-500">bounced (this page)</p>
                </div>
              )}
              {deliveredCount > 0 && (
                <div>
                  <p className="text-2xl font-bold text-blue-600">{deliveredCount}</p>
                  <p className="text-xs text-slate-500">delivered (this page)</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <form method="get" className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm font-medium text-slate-700">
          Search members
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Email starts with…"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
          />
        </label>
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
          Search
        </button>
        {query && (
          <Link href={`/lists/${listId}`} className="rounded-md border border-slate-300 px-4 py-2 text-center text-sm font-semibold text-slate-600 hover:bg-white">
            Clear
          </Link>
        )}
        {query && (
          <p className="pb-2 text-sm text-slate-500 sm:ml-2">
            {matchingCount.toLocaleString()} match{matchingCount === 1 ? "" : "es"}
          </p>
        )}
      </form>

      {/* Member table */}
      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  Email
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  Subscription
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  Subscribed
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  Last Email
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  Delivery
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members?.length ? (
                members.map((member) => {
                  const activity = recipientMap[member.email];
                  return (
                    <tr key={member.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {member.email}
                      </td>
                      <td className="px-4 py-3">
                        <MemberStatusBadge status={member.status} />
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {member.subscribed_at
                          ? new Date(member.subscribed_at).toLocaleDateString(undefined, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {activity?.sent_at ? (
                          <span>
                            <span className="block">
                              {new Date(activity.sent_at).toLocaleDateString(undefined, {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                            {activity.subject && (
                              <span
                                className="block max-w-[200px] truncate text-slate-400"
                                title={activity.subject}
                              >
                                {activity.subject}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-slate-400">Never</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <DeliveryBadge
                          status={activity?.status}
                          event={activity?.last_event}
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
                        {member.status === "active" && member.email.toLowerCase() !== "a@sarva.co" ? (
                          <form action={suppressListMemberAction}>
                            <input type="hidden" name="listId" value={listId} />
                            <input type="hidden" name="memberId" value={member.id} />
                            <button
                              type="submit"
                              className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
                              title={`Suppress ${member.email} from this list and cancel its unsent queue rows`}
                            >
                              Suppress
                            </button>
                          </form>
                        ) : (
                          <span className="text-xs text-slate-400">
                            {member.email.toLowerCase() === "a@sarva.co" ? "Owner" : "Suppressed"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">
                    {query ? `No members match “${query}”.` : "No members yet. Import members from the Lists page."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            Showing {(offset + 1).toLocaleString()}–
            {Math.min(offset + PAGE_SIZE, matchingCount).toLocaleString()} of{" "}
            {matchingCount.toLocaleString()} {query ? "matching " : ""}members
          </p>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={pageHref(page - 1)}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                ← Previous
              </Link>
            )}
            <span className="flex items-center px-3 text-sm text-slate-500">
              Page {page} of {totalPages}
            </span>
            {page < totalPages && (
              <Link
                href={pageHref(page + 1)}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
