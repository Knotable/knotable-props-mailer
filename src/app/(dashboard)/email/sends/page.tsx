import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
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

  // ── Use the email_send_stats VIEW for O(emails) instead of O(queue rows) ────
  // If the migration hasn't been applied yet, fall back to a note.
  type StatRow = {
    email_id: string;
    list_ids: string[] | null;
    sent: number;
    failed: number;
    pending: number;
    first_sent: string | null;
    last_queued_at: string | null;
  };

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

  if (statsError) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          <p className="font-medium">Migration required</p>
          <p className="mt-1">
            Run{" "}
            <code className="rounded bg-amber-100 px-1">
              supabase/migrations/20260421_analytics_views.sql
            </code>{" "}
            in your Supabase project to enable the Past Sends page.
          </p>
        </div>
      </div>
    );
  }

  const rows = (stats ?? []) as StatRow[];

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

  const [{ data: emails }, { data: lists }] = await Promise.all([
    supabase
      .from("emails")
      .select("id, subject, from_address, html, status, created_at")
      .in("id", emailIds),
    listIds.length
      ? supabase.from("lists").select("id, name, address").in("id", listIds)
      : Promise.resolve({ data: [] as { id: string; name: string; address: string }[] }),
  ]);

  const emailDetails = new Map((emails ?? []).map((e) => [e.id, e]));
  const listDetails = new Map((lists ?? []).map((l) => [l.id, l]));

  const sends = rows.map((row) => {
    const email = emailDetails.get(row.email_id);
    const sendLists = (row.list_ids ?? [])
      .map((lid) => listDetails.get(lid))
      .filter(Boolean) as { id: string; name: string; address: string }[];

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

  const total = totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <Header total={total} />
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
