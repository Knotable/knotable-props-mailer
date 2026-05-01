import Link from "next/link";
import { createServerAppClient } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ScheduleActions, ProcessQueueButton } from "./schedule-actions";
import { RecipientBadges } from "./recipient-badges";

export default async function SchedulePage() {
  // Auth-gated client for the emails query (respects RLS)
  const supabase = await createServerAppClient();
  // Admin client for joining tables that aren't in the auth schema types
  const admin = getSupabaseAdmin();

  const { data: emails } = await supabase
    .from("emails")
    .select("id, subject, status, updated_at")
    .in("status", ["draft", "queued", "sending"])
    .order("updated_at", { ascending: false })
    .limit(50);

  const emailIds = (emails ?? []).map((e) => e.id);

  // Fetch the list associations for all queued/sending emails from mail_queue.
  // Drafts won't have queue rows yet, so they'll just have no lists shown.
  const { data: queueRows } = emailIds.length
    ? await admin
        .from("mail_queue")
        .select("email_id, list_id")
        .in("email_id", emailIds)
        .not("list_id", "is", null)
    : { data: [] as { email_id: string; list_id: string }[] };

  // Unique list IDs across all emails
  const listIds = [...new Set((queueRows ?? []).map((r) => r.list_id).filter(Boolean) as string[])];

  const [{ data: lists }, listCounts, { data: sampleMembers }] = await Promise.all([
    listIds.length
      ? admin.from("lists").select("id, name, address").in("id", listIds)
      : Promise.resolve({ data: [] as { id: string; name: string; address: string }[] }),
    Promise.all(
      listIds.map(async (listId) => {
        const { count } = await admin
          .from("list_members")
          .select("id", { count: "exact", head: true })
          .eq("list_id", listId)
          .eq("status", "active");
        return [listId, count ?? 0] as const;
      }),
    ),
    listIds.length
      ? admin
          .from("list_members")
          .select("list_id, email")
          .in("list_id", listIds)
          .eq("status", "active")
          .order("email", { ascending: true })
          .limit(50)
      : Promise.resolve({ data: [] as { list_id: string; email: string }[] }),
  ]);

  // Build list_id → {name, address, memberCount, sampleEmails}
  const countByList = new Map(listCounts);
  const membersByList = new Map<string, string[]>();
  for (const m of sampleMembers ?? []) {
    if (!m.list_id) continue;
    const arr = membersByList.get(m.list_id) ?? [];
    arr.push(m.email);
    membersByList.set(m.list_id, arr);
  }
  const listMap = new Map(
    (lists ?? []).map((l) => [
      l.id,
      {
        id: l.id,
        name: l.name,
        address: l.address,
        memberCount: countByList.get(l.id) ?? 0,
        sampleEmails: membersByList.get(l.id) ?? [],
      },
    ])
  );

  // Build email_id → lists[]
  const listsByEmail = new Map<string, { id: string; name: string; address: string; memberCount: number; sampleEmails: string[] }[]>();
  for (const row of queueRows ?? []) {
    if (!row.email_id || !row.list_id) continue;
    const list = listMap.get(row.list_id);
    if (!list) continue;
    const arr = listsByEmail.get(row.email_id) ?? [];
    if (!arr.find((l) => l.id === list.id)) arr.push(list);
    listsByEmail.set(row.email_id, arr);
  }

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
        <ProcessQueueButton />
      </header>

      <div className="divide-y rounded-lg border border-slate-200">
        {emails?.length ? (
          emails.map((item) => {
            const isDraft = item.status === "draft";
            const updatedIso = item.updated_at ?? null;
            const itemLists = listsByEmail.get(item.id) ?? [];

            return (
              <div
                key={item.id}
                className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0 space-y-2">
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
                    <p className="min-w-0 truncate text-sm font-medium text-slate-800 sm:text-base">
                      {item.subject || "(no subject)"}
                    </p>
                  </div>

                  <div className="text-sm text-slate-500">
                    {isDraft
                      ? updatedIso
                        ? `Updated ${updatedIso.replace("T", " ").slice(0, 16)} UTC`
                        : "Draft only"
                      : "Queued for manual send"}
                  </div>

                  {itemLists.length > 0 && (
                    <RecipientBadges lists={itemLists} />
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:justify-self-end">
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
