import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { isoDaysAgo } from "@/lib/dateWindows";
import { SendsClient } from "./sends-client";

const PAGE_SIZE = 20;

// searchParams is a Promise in Next.js 15+.
export default async function PastSendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt((params.page as string) ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;

  const supabase = getSupabaseAdmin();

  type StatRow = {
    email_id: string;
    list_ids: string[] | null;
    sent: number;
    failed: number;
    pending: number;
    first_sent: string | null;
    last_queued_at: string | null;
  };

  // ── Try the email_send_stats VIEW (O(emails) query) ───────────────────────
  // If the migration hasn't been applied yet, fall back to a bounded direct
  // scan of mail_queue (last 90 days, max 5 000 rows) so the page still shows
  // historical data rather than a blocking advisory.
  const [{ count: totalCount }, { data: stats, error: statsError }] = await Promise.all([
    supabase
      .from("email_send_stats")
      .select("email_id", { count: "exact", head: true }),
    supabase
      .from("email_send_stats")
      .select("email_id, list_ids, sent, failed, pending, first_sent, last_queued_at")
      .order("last_queued_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1),
  ]);

  let viewMissing = false;
  let rows: StatRow[] = [];
  let total: number;

  if (statsError) {
    viewMissing = true;
    const ninetyDaysAgo = isoDaysAgo(90);
    const { data: rawRows } = await supabase
      .from("mail_queue")
      .select("email_id, list_id, status, send_date, created_at")
      .not("email_id", "is", null)
      .gte("created_at", ninetyDaysAgo)
      .limit(5000);

    const grouped = new Map<string, StatRow & { _last_queued: string }>();
    for (const row of rawRows ?? []) {
      if (!row.email_id) continue;
      const entry = grouped.get(row.email_id) ?? {
        email_id: row.email_id,
        list_ids: [] as string[],
        sent: 0,
        failed: 0,
        pending: 0,
        first_sent: null,
        last_queued_at: row.created_at,
        _last_queued: row.created_at ?? "",
      };
      if (row.list_id && !(entry.list_ids ?? []).includes(row.list_id)) {
        (entry.list_ids as string[]).push(row.list_id);
      }
      if (row.status === "succeeded") {
        entry.sent++;
        if (!entry.first_sent || (row.send_date && row.send_date < entry.first_sent)) {
          entry.first_sent = row.send_date;
        }
      } else if (row.status === "failed" || row.status === "dead") {
        entry.failed++;
      } else if (row.status === "pending" || row.status === "processing") {
        entry.pending++;
      }
      if (row.created_at && row.created_at > (entry._last_queued ?? "")) {
        entry._last_queued = row.created_at;
        entry.last_queued_at = row.created_at;
      }
      grouped.set(row.email_id, entry);
    }

    const allRows = [...grouped.values()]
      .sort((a, b) => ((b._last_queued ?? "") > (a._last_queued ?? "") ? 1 : -1));
    total = allRows.length;
    rows = allRows.slice(offset, offset + PAGE_SIZE).map((row) => ({
      email_id: row.email_id,
      list_ids: row.list_ids,
      sent: row.sent,
      failed: row.failed,
      pending: row.pending,
      first_sent: row.first_sent,
      last_queued_at: row.last_queued_at,
    }));
  } else {
    rows = (stats ?? []) as StatRow[];
    total = totalCount ?? 0;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (rows.length === 0 && page === 1) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
          No emails have been queued or sent yet.
        </div>
      </div>
    );
  }

  // Fetch email details and list details for this page only.
  const emailIds = rows.map((r) => r.email_id);
  const listIds = [
    ...new Set(rows.flatMap((r) => r.list_ids ?? []).filter(Boolean)),
  ];

  const [{ data: emails }, { data: lists }, { data: listMembers }] = await Promise.all([
    supabase
      .from("emails")
      .select("id, subject, from_address, html, status, created_at")
      .in("id", emailIds),
    listIds.length
      ? supabase.from("lists").select("id, name, address").in("id", listIds)
      : Promise.resolve({ data: [] as { id: string; name: string; address: string }[] }),
    listIds.length
      ? supabase
          .from("list_members")
          .select("list_id, email")
          .in("list_id", listIds)
          .eq("status", "active")
          .order("email", { ascending: true })
      : Promise.resolve({ data: [] as { list_id: string; email: string }[] }),
  ]);

  const emailDetails = new Map((emails ?? []).map((e) => [e.id, e]));

  // Build a map of list_id → sorted member emails
  const membersByList = new Map<string, string[]>();
  for (const m of listMembers ?? []) {
    if (!m.list_id) continue;
    const arr = membersByList.get(m.list_id) ?? [];
    arr.push(m.email);
    membersByList.set(m.list_id, arr);
  }

  const listDetails = new Map(
    (lists ?? []).map((l) => [
      l.id,
      { ...l, memberEmails: membersByList.get(l.id) ?? [] },
    ])
  );

  const sends = rows.map((row) => {
    const email = emailDetails.get(row.email_id);
    const sendLists = (row.list_ids ?? [])
      .map((lid) => listDetails.get(lid))
      .filter(Boolean) as { id: string; name: string; address: string; memberEmails: string[] }[];

    return {
      email_id: row.email_id,
      subject: email?.subject ?? "(untitled)",
      from_address: email?.from_address ?? "",
      status: email?.status ?? "unknown",
      sent: Number(row.sent),
      failed: Number(row.failed),
      pending: Number(row.pending),
      first_sent: row.first_sent,
      lists: sendLists,
      created_at: email?.created_at ?? null,
    };
  });

  return (
    <div className="space-y-6">
      <Header total={total} />
      {viewMissing && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span className="font-medium">Showing last 90 days (fallback).</span>{" "}
          Run{" "}
          <code className="rounded bg-amber-100 px-1">
            supabase/migrations/20260421_analytics_views.sql
          </code>{" "}
          for full history and better performance.
        </div>
      )}
      <SendsClient sends={sends} />
      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} />
      )}
    </div>
  );
}

function Header({ total }: { total?: number }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">History</p>
        <h2 className="text-2xl font-semibold text-slate-900">Past Sends</h2>
        <p className="text-sm text-slate-500">
          Emails queued or sent, with delivery stats and preview.
        </p>
      </div>
      {total !== undefined && (
        <p className="text-sm text-slate-400">{total.toLocaleString()} total</p>
      )}
    </header>
  );
}

function Pagination({ page, totalPages }: { page: number; totalPages: number }) {
  const prev = page > 1 ? page - 1 : null;
  const next = page < totalPages ? page + 1 : null;

  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {prev ? (
          <Link
            href={`?page=${prev}`}
            className="rounded-md border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-50"
          >
            ← Previous
          </Link>
        ) : (
          <span className="rounded-md border border-slate-200 px-3 py-1 text-slate-300">
            ← Previous
          </span>
        )}
        {next ? (
          <Link
            href={`?page=${next}`}
            className="rounded-md border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-50"
          >
            Next →
          </Link>
        ) : (
          <span className="rounded-md border border-slate-200 px-3 py-1 text-slate-300">
            Next →
          </span>
        )}
      </div>
    </div>
  );
}
