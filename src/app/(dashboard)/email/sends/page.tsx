import Link from "next/link";
import { connection } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { isoDaysAgo } from "@/lib/dateWindows";
import { SendsClient } from "./sends-client";

const PAGE_SIZE = 20;
const QUERY_TIMEOUT_MS = 2_500;

type StatRow = {
  email_id: string;
  list_ids: string[] | null;
  sent: number | null;
  failed: number | null;
  pending: number | null;
  canceled: number | null;
  first_sent: string | null;
  last_queued_at: string | null;
};

type SendList = {
  id: string;
  name: string;
  address: string;
  updated_at: string | null;
  memberCount: number;
  memberEmails: string[];
};

type SendItem = {
  email_id: string;
  subject: string;
  from_address: string;
  status: string;
  sent: number | null;
  failed: number | null;
  pending: number | null;
  canceled: number | null;
  first_sent: string | null;
  last_queued_at: string | null;
  lists: SendList[];
  created_at: string | null;
};

type EmailRow = {
  id: string;
  subject: string;
  from_address: string;
  status: string;
  created_at: string | null;
};

type FallbackEmailRow = Pick<EmailRow, "id" | "created_at">;

type ListRow = {
  id: string;
  name: string;
  address: string;
  updated_at: string | null;
};

type SampleMemberRow = {
  email: string;
};

type QueueListRow = {
  list_id: string | null;
};

type QueueDateRow = {
  send_date?: string | null;
  created_at?: string | null;
};

type PastSendsData = {
  sends: SendItem[];
  total: number;
  totalPages: number;
  sentLast7Days: number;
  sentAllTime: number;
  statsPartial: boolean;
};

type RecentSendStatsRpcRow = StatRow & {
  subject: string;
  from_address: string;
  status: string;
  created_at: string | null;
  total_count: number | null;
};

type TimedResult<T> = {
  data: T[] | null;
  count: number | null;
  error: { message?: string } | null;
};

type QueryLike = PromiseLike<unknown> | {
  abortSignal: (signal: AbortSignal) => unknown;
};

type RecentSendStatsRpcClient = {
  rpc(
    fn: "get_recent_email_send_stats",
    args: { p_limit: number; p_offset: number },
  ): Promise<TimedResult<RecentSendStatsRpcRow>>;
};

async function timedQuery<T>(query: QueryLike): Promise<TimedResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

  try {
    const runnable =
      "abortSignal" in query && typeof query.abortSignal === "function"
        ? query.abortSignal(controller.signal)
        : query;
    return (await runnable) as TimedResult<T>;
  } catch (error) {
    return {
      data: null,
      count: null,
      error: { message: error instanceof Error ? error.message : "Query timed out" },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadQueueStatsForEmail(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  email: FallbackEmailRow,
): Promise<{ row: StatRow; partial: boolean }> {
  const [
    sentResult,
    failedResult,
    pendingResult,
    canceledResult,
    firstSentResult,
    lastSentResult,
    lastQueuedResult,
    queueListResult,
  ] = await Promise.all([
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "planned", head: true })
        .eq("email_id", email.id)
        .eq("status", "succeeded"),
    ),
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "planned", head: true })
        .eq("email_id", email.id)
        .in("status", ["failed", "dead"]),
    ),
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "planned", head: true })
        .eq("email_id", email.id)
        .in("status", ["pending", "processing"]),
    ),
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "planned", head: true })
        .eq("email_id", email.id)
        .eq("status", "canceled"),
    ),
    timedQuery<QueueDateRow>(
      supabase
        .from("mail_queue")
        .select("send_date")
        .eq("email_id", email.id)
        .eq("status", "succeeded")
        .not("send_date", "is", null)
        .order("send_date", { ascending: true })
        .limit(1),
    ),
    timedQuery<QueueDateRow>(
      supabase
        .from("mail_queue")
        .select("send_date")
        .eq("email_id", email.id)
        .eq("status", "succeeded")
        .not("send_date", "is", null)
        .order("send_date", { ascending: false })
        .limit(1),
    ),
    timedQuery<QueueDateRow>(
      supabase
        .from("mail_queue")
        .select("created_at")
        .eq("email_id", email.id)
        .order("created_at", { ascending: false })
        .limit(1),
    ),
    timedQuery<QueueListRow>(
      supabase
        .from("mail_queue")
        .select("list_id")
        .eq("email_id", email.id)
        .not("list_id", "is", null)
        .order("list_id", { ascending: true })
        .limit(5000),
    ),
  ]);

  const firstSent = firstSentResult.data?.[0]?.send_date ?? null;
  const lastSent = lastSentResult.data?.[0]?.send_date ?? null;
  const lastQueued = lastSent ?? lastQueuedResult.data?.[0]?.created_at ?? email.created_at;
  const listIds = [
    ...new Set(
      (queueListResult.data ?? [])
        .map((row) => row.list_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const partial = [
    sentResult,
    failedResult,
    pendingResult,
    canceledResult,
    firstSentResult,
    lastSentResult,
    lastQueuedResult,
    queueListResult,
  ].some((result) => Boolean(result.error));

  return {
    row: {
      email_id: email.id,
      list_ids: listIds,
      sent: sentResult.count,
      failed: failedResult.count,
      pending: pendingResult.count,
      canceled: canceledResult.count,
      first_sent: firstSent,
      last_queued_at: lastQueued,
    },
    partial,
  };
}

async function loadPastSendsData(page: number): Promise<PastSendsData> {
  const offset = (page - 1) * PAGE_SIZE;
  const supabase = getSupabaseAdmin();
  const last7Date = isoDaysAgo(7).slice(0, 10);

  const [
    sentLast7DaysResult,
    sentAllTimeResult,
    recentStatsResult,
  ] = await Promise.all([
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "planned", head: true })
        .eq("status", "succeeded")
        .gte("send_date", last7Date),
    ),
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "planned", head: true })
        .eq("status", "succeeded"),
    ),
    timedQuery<RecentSendStatsRpcRow>(
      (supabase as unknown as RecentSendStatsRpcClient).rpc(
        "get_recent_email_send_stats",
        {
          p_limit: PAGE_SIZE,
          p_offset: offset,
        },
      ),
    ),
  ]);

  let emailRows: EmailRow[] = [];
  let rows: StatRow[] = [];
  let total = 0;
  let statsPartial = Boolean(sentLast7DaysResult.error) || Boolean(sentAllTimeResult.error);

  if (!recentStatsResult.error) {
    const rpcRows = (recentStatsResult.data ?? []) as RecentSendStatsRpcRow[];
    emailRows = rpcRows.map((row) => ({
      id: row.email_id,
      subject: row.subject,
      from_address: row.from_address,
      status: row.status,
      created_at: row.created_at,
    }));
    rows = rpcRows.map((row) => ({
      email_id: row.email_id,
      list_ids: row.list_ids ?? [],
      sent: Number(row.sent),
      failed: Number(row.failed),
      pending: Number(row.pending),
      canceled: Number(row.canceled ?? 0),
      first_sent: row.first_sent,
      last_queued_at: row.last_queued_at,
    }));
    total = Number(rpcRows[0]?.total_count ?? rpcRows.length);
  } else {
    statsPartial = true;

    const { data: emailsPage, count: totalCount } = await supabase
      .from("emails")
      .select("id, subject, from_address, status, created_at", { count: "exact" })
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    emailRows = (emailsPage ?? []) as EmailRow[];
    const statsEntries = await Promise.all(
      emailRows.map((email) => loadQueueStatsForEmail(supabase, email)),
    );
    rows = statsEntries.map((entry) => entry.row);
    total = totalCount ?? emailRows.length;
    statsPartial = statsPartial || statsEntries.some((entry) => entry.partial);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const listIds = [...new Set(rows.flatMap((row) => row.list_ids ?? []).filter(Boolean))];

    const [{ data: lists }] = await Promise.all([
      listIds.length
        ? supabase
            .from("lists")
            .select("id, name, address, updated_at")
            .in("id", listIds)
        : Promise.resolve({ data: [] }),
    ]);

    const listRows = (lists ?? []) as ListRow[];

    const listMetaEntries = await Promise.all(
      listRows.map(async (list) => {
        const [{ count }, { data: sampleMembers }] = await Promise.all([
          supabase
            .from("list_members")
            .select("id", { count: "exact", head: true })
            .eq("list_id", list.id)
            .eq("status", "active"),
          supabase
            .from("list_members")
            .select("email")
            .eq("list_id", list.id)
            .eq("status", "active")
            .order("email", { ascending: true })
            .limit(8),
        ]);

        const sampleRows = (sampleMembers ?? []) as SampleMemberRow[];

        return [
          list.id,
          {
            id: list.id,
            name: list.name,
            address: list.address,
            updated_at: list.updated_at,
            memberCount: count ?? 0,
            memberEmails: sampleRows.map((member) => member.email),
          } satisfies SendList,
        ] as const;
      }),
    );

    const emailDetails = new Map(emailRows.map((email) => [email.id, email]));
    const listDetails = new Map(listMetaEntries);

    const sends = rows.map((row) => {
      const email = emailDetails.get(row.email_id);
      const sendLists = (row.list_ids ?? [])
        .map((listId) => listDetails.get(listId))
        .filter(Boolean) as SendList[];

      return {
        email_id: row.email_id,
        subject: email?.subject ?? "(untitled)",
        from_address: email?.from_address ?? "",
        status: email?.status ?? "unknown",
        sent: row.sent,
        failed: row.failed,
        pending: row.pending,
        canceled: row.canceled,
        first_sent: row.first_sent,
        last_queued_at: row.last_queued_at,
        lists: sendLists,
        created_at: email?.created_at ?? null,
      };
    });

    return {
      sends,
      total,
      totalPages,
      sentLast7Days: sentLast7DaysResult.count ?? 0,
      sentAllTime: sentAllTimeResult.count ?? 0,
      statsPartial,
    };
}

// searchParams is a Promise in Next.js 15+.
export default async function PastSendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  await connection();
  const params = await searchParams;
  const page = Math.max(1, parseInt((params.page as string) ?? "1", 10));
  const { sends, total, totalPages, sentLast7Days, sentAllTime, statsPartial } =
    await loadPastSendsData(page);

  if (sends.length === 0 && page === 1) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
          No emails have been queued or sent yet.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header
        total={total}
        sentLast7Days={sentLast7Days ?? 0}
        sentAllTime={sentAllTime ?? 0}
      />
      {statsPartial && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span className="font-medium">Some queue stats are still catching up.</span>{" "}
          Recent campaigns are shown from the emails table, but one or more queue count
          queries timed out. For full-speed counts, run{" "}
          <code className="rounded bg-amber-100 px-1">
            supabase/migrations/20260616_fast_send_history_rpc.sql
          </code>{" "}
          in Supabase.
        </div>
      )}
      <SendsClient sends={sends} />
      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} />
      )}
    </div>
  );
}

function Header({
  total,
  sentLast7Days,
  sentAllTime,
}: {
  total?: number;
  sentLast7Days?: number;
  sentAllTime?: number;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">History</p>
        <h2 className="text-2xl font-semibold text-slate-900">Past Sends</h2>
        <p className="text-sm text-slate-500">
          Per-email campaign history, with delivery stats and preview.
        </p>
      </div>
      <div className="text-right text-sm text-slate-500">
        {total !== undefined && <p>{total.toLocaleString()} email records</p>}
        {sentLast7Days !== undefined && sentAllTime !== undefined && (
          <p>
            {sentLast7Days.toLocaleString()} sent last 7 days ·{" "}
            {sentAllTime.toLocaleString()} sent all time
          </p>
        )}
      </div>
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
