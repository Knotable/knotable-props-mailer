import Link from "next/link";
import { connection } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { isoDaysAgo } from "@/lib/dateWindows";
import { SendsClient } from "./sends-client";

const PAGE_SIZE = 20;
const QUERY_TIMEOUT_MS = 2_500;
const OPEN_RECIPIENT_SCAN_LIMIT = 5_000;

type StatRow = {
  email_id: string;
  list_ids: string[] | null;
  sent: number | null;
  failed: number | null;
  pending: number | null;
  canceled: number | null;
  countStale: QueueCountStale;
  first_sent: string | null;
  last_queued_at: string | null;
};

type QueueCountStale = {
  sent: boolean;
  failed: boolean;
  pending: boolean;
  canceled: boolean;
};

type SendList = {
  id: string;
  name: string;
  address: string;
  updated_at: string | null;
  memberCount: number;
  queuedRecipientCount: number | null;
  memberEmails: string[];
};

type RecipientSample = {
  email: string;
  status: string | null;
  sendDate: string | null;
  lastError: string | null;
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
  opens: number | null;
  opensStale: boolean;
  countStale: QueueCountStale;
  first_sent: string | null;
  last_queued_at: string | null;
  lists: SendList[];
  recipientSamples: RecipientSample[];
  recipientSamplesPartial: boolean;
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

type QueueRecipientRow = {
  payload: unknown;
  status: string | null;
  send_date: string | null;
  last_error: string | null;
};

type ProviderEventRecipientRow = {
  recipient: string | null;
};

type OpenStats = {
  uniqueOpens: number | null;
  opensStale: boolean;
};

type PastSendsData = {
  sends: SendItem[];
  total: number;
  totalPages: number;
  sentLast7Days: number;
  sentAllTime: number;
  sentLast7DaysStale: boolean;
  sentAllTimeStale: boolean;
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

function payloadToEmail(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as { to?: unknown }).to;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const freshQueueCountStale = (): QueueCountStale => ({
  sent: false,
  failed: false,
  pending: false,
  canceled: false,
});

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
): Promise<StatRow> {
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
        .select("id", { count: "exact", head: true })
        .eq("email_id", email.id)
        .eq("status", "succeeded"),
    ),
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
        .eq("email_id", email.id)
        .in("status", ["failed", "dead"]),
    ),
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
        .eq("email_id", email.id)
        .in("status", ["pending", "processing"]),
    ),
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
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
  return {
    email_id: email.id,
    list_ids: listIds,
    sent: sentResult.count,
    failed: failedResult.count,
    pending: pendingResult.count,
    canceled: canceledResult.count,
    countStale: {
      sent: Boolean(sentResult.error),
      failed: Boolean(failedResult.error),
      pending: Boolean(pendingResult.error),
      canceled: Boolean(canceledResult.error),
    },
    first_sent: firstSent,
    last_queued_at: lastQueued,
  };
}

async function loadRecipientSamplesForEmail(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
): Promise<{ samples: RecipientSample[]; partial: boolean }> {
  const result = await timedQuery<QueueRecipientRow>(
    supabase
      .from("mail_queue")
      .select("payload, status, send_date, last_error")
      .eq("email_id", emailId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(40),
  );

  return {
    samples: (result.data ?? [])
      .map((row) => ({
        email: payloadToEmail(row.payload),
        status: row.status,
        sendDate: row.send_date,
        lastError: row.last_error,
      }))
      .filter((sample): sample is RecipientSample => Boolean(sample.email)),
    partial: Boolean(result.error),
  };
}

async function loadOpenStatsForEmail(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
): Promise<OpenStats> {
  const result = await timedQuery<ProviderEventRecipientRow>(
    supabase
      .from("provider_events")
      .select("recipient", { count: "exact" })
      .eq("email_id", emailId)
      .eq("event_type", "opened")
      .not("recipient", "is", null)
      .order("received_at", { ascending: false })
      .limit(OPEN_RECIPIENT_SCAN_LIMIT),
  );

  if (result.error) {
    return { uniqueOpens: null, opensStale: true };
  }

  const uniqueRecipients = new Set(
    (result.data ?? [])
      .map((row) => row.recipient?.trim().toLowerCase())
      .filter((recipient): recipient is string => Boolean(recipient)),
  );
  const scannedCount = result.data?.length ?? 0;
  const opensStale = typeof result.count === "number" && scannedCount < result.count;

  return {
    uniqueOpens: uniqueRecipients.size,
    opensStale,
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
        .select("id", { count: "exact", head: true })
        .eq("status", "succeeded")
        .gte("send_date", last7Date),
    ),
    timedQuery(
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
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
      countStale: freshQueueCountStale(),
      first_sent: row.first_sent,
      last_queued_at: row.last_queued_at,
    }));
    total = Number(rpcRows[0]?.total_count ?? rpcRows.length);
  } else {
    const { data: emailsPage, count: totalCount } = await supabase
      .from("emails")
      .select("id, subject, from_address, status, created_at", { count: "exact" })
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    emailRows = (emailsPage ?? []) as EmailRow[];
    rows = await Promise.all(
      emailRows.map((email) => loadQueueStatsForEmail(supabase, email)),
    );
    total = totalCount ?? emailRows.length;
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
          queuedRecipientCount: null,
          memberEmails: sampleRows.map((member) => member.email),
        } satisfies SendList,
      ] as const;
    }),
  );

  const emailDetails = new Map(emailRows.map((email) => [email.id, email]));
  const listDetails = new Map(listMetaEntries);
  const emailListPairs = rows.flatMap((row) =>
    (row.list_ids ?? []).map((listId) => ({
      emailId: row.email_id,
      listId,
    })),
  );
  const queuedListCountEntries = await Promise.all(
    emailListPairs.map(async ({ emailId, listId }) => {
      const result = await timedQuery(
        supabase
          .from("mail_queue")
          .select("id", { count: "exact", head: true })
          .eq("email_id", emailId)
          .eq("list_id", listId),
      );

      return [
        `${emailId}:${listId}`,
        result.error ? null : result.count,
      ] as const;
    }),
  );
  const queuedListCounts = new Map(queuedListCountEntries);
  const recipientSampleEntries = await Promise.all(
    rows.map(async (row) => {
      const summary = await loadRecipientSamplesForEmail(supabase, row.email_id);
      return [row.email_id, summary] as const;
    }),
  );
  const recipientSamplesByEmail = new Map(recipientSampleEntries);
  const openStatsEntries = await Promise.all(
    rows.map(async (row) => {
      const stats = await loadOpenStatsForEmail(supabase, row.email_id);
      return [row.email_id, stats] as const;
    }),
  );
  const openStatsByEmail = new Map(openStatsEntries);

  const sends = rows.map((row) => {
    const email = emailDetails.get(row.email_id);
    const sendLists = (row.list_ids ?? [])
      .map((listId) => {
        const list = listDetails.get(listId);
        if (!list) return null;
        return {
          ...list,
          queuedRecipientCount:
            queuedListCounts.get(`${row.email_id}:${listId}`) ?? null,
        };
      })
      .filter(Boolean) as SendList[];
    const recipientSampleSummary = recipientSamplesByEmail.get(row.email_id);
    const openStats = openStatsByEmail.get(row.email_id);

    return {
      email_id: row.email_id,
      subject: email?.subject ?? "(untitled)",
      from_address: email?.from_address ?? "",
      status: email?.status ?? "unknown",
      sent: row.sent,
      failed: row.failed,
      pending: row.pending,
      canceled: row.canceled,
      opens: openStats?.uniqueOpens ?? null,
      opensStale: openStats?.opensStale ?? false,
      countStale: row.countStale,
      first_sent: row.first_sent,
      last_queued_at: row.last_queued_at,
      lists: sendLists,
      recipientSamples: recipientSampleSummary?.samples ?? [],
      recipientSamplesPartial: recipientSampleSummary?.partial ?? false,
      created_at: email?.created_at ?? null,
    };
  });

  return {
    sends,
    total,
    totalPages,
    sentLast7Days: sentLast7DaysResult.count ?? 0,
    sentAllTime: sentAllTimeResult.count ?? 0,
    sentLast7DaysStale: Boolean(sentLast7DaysResult.error),
    sentAllTimeStale: Boolean(sentAllTimeResult.error),
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
  const {
    sends,
    total,
    totalPages,
    sentLast7Days,
    sentAllTime,
    sentLast7DaysStale,
    sentAllTimeStale,
  } =
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
        sentLast7DaysStale={sentLast7DaysStale}
        sentAllTimeStale={sentAllTimeStale}
      />
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
  sentLast7DaysStale = false,
  sentAllTimeStale = false,
}: {
  total?: number;
  sentLast7Days?: number;
  sentAllTime?: number;
  sentLast7DaysStale?: boolean;
  sentAllTimeStale?: boolean;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">History</p>
        <h2 className="text-2xl font-semibold text-slate-900">Past Sends</h2>
        <p className="text-sm text-slate-500">
          Per-email campaign history, recipients, opens, delivery stats, and preview.
        </p>
      </div>
      <div className="text-right text-sm text-slate-500">
        {total !== undefined && <p>{total.toLocaleString()} email records</p>}
        {sentLast7Days !== undefined && sentAllTime !== undefined && (
          <p>
            <CountWithFreshness value={sentLast7Days} stale={sentLast7DaysStale} /> sent last 7 days ·{" "}
            <CountWithFreshness value={sentAllTime} stale={sentAllTimeStale} /> sent all time
          </p>
        )}
      </div>
    </header>
  );
}

function CountWithFreshness({ value, stale }: { value: number; stale: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{value.toLocaleString()}</span>
      {stale && <InlineSpinner />}
    </span>
  );
}

function InlineSpinner() {
  return (
    <span
      aria-label="Updating"
      className="inline-block size-3 animate-spin rounded-full border-2 border-amber-500 border-t-transparent align-[-1px]"
    />
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
