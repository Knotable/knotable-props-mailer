import Link from "next/link";
import { notFound } from "next/navigation";
import { requireServerAuthContext } from "@/lib/authAccess";
import { parseUuid } from "@/lib/ids";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAGE_SIZE = 100;
const QUEUE_STATUSES = ["succeeded", "failed", "dead", "pending", "processing", "canceled"] as const;

type Props = {
  params: Promise<{ emailId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type QueueRow = {
  id: string;
  list_id: string | null;
  payload: unknown;
  status: string | null;
  send_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_error: string | null;
  ses_message_id: string | null;
};

type QueueListRow = {
  list_id: string | null;
};

type ListRow = {
  id: string;
  name: string;
  address: string;
};

type ListSummary = {
  id: string;
  name: string;
  address: string;
  queueRows: number | null;
  currentActiveMembers: number | null;
  samples: RecipientSample[];
  statusCounts: Record<string, number | null>;
};

type RecipientSample = {
  email: string;
  status: string | null;
  sendDate: string | null;
  lastError: string | null;
};

type RecipientRow = {
  id: string;
  email: string | null;
  toName: string | null;
  listId: string | null;
  listName: string | null;
  status: string | null;
  sendDate: string | null;
  queuedAt: string | null;
  updatedAt: string | null;
  lastError: string | null;
  sesMessageId: string | null;
};

function payloadValue(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function payloadToEmail(payload: unknown) {
  return payloadValue(payload, "to");
}

function payloadToName(payload: unknown) {
  return payloadValue(payload, "toName");
}

function clampPage(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const page = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function csvSafe(value: string | null | undefined) {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

async function countQueueRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
  status?: string,
  listId?: string | null,
) {
  let query = supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("email_id", emailId);

  if (status) query = query.eq("status", status);
  if (listId === null) query = query.is("list_id", null);
  if (typeof listId === "string") query = query.eq("list_id", listId);

  const { count, error } = await query;
  if (error) return null;
  return count ?? 0;
}

async function loadListSummaries(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
) {
  const { data: queueListRows } = await supabase
    .from("mail_queue")
    .select("list_id")
    .eq("email_id", emailId)
    .not("list_id", "is", null)
    .limit(5000);

  const listIds = [
    ...new Set(
      ((queueListRows ?? []) as QueueListRow[])
        .map((row) => row.list_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const { data: lists } = listIds.length
    ? await supabase
        .from("lists")
        .select("id, name, address")
        .in("id", listIds)
    : { data: [] as ListRow[] };

  const listsById = new Map(((lists ?? []) as ListRow[]).map((list) => [list.id, list]));

  return Promise.all(
    listIds.map(async (listId) => {
      const list = listsById.get(listId) ?? {
        id: listId,
        name: "Unknown list",
        address: "No list address recorded",
      };

      const [
        queueRows,
        currentActiveMembers,
        sampleResult,
        ...statusCounts
      ] = await Promise.all([
        countQueueRows(supabase, emailId, undefined, listId),
        supabase
          .from("list_members")
          .select("id", { count: "exact", head: true })
          .eq("list_id", listId)
          .eq("status", "active"),
        supabase
          .from("mail_queue")
          .select("payload, status, send_date, last_error")
          .eq("email_id", emailId)
          .eq("list_id", listId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(8),
        ...QUEUE_STATUSES.map((status) => countQueueRows(supabase, emailId, status, listId)),
      ]);

      const counts = Object.fromEntries(
        QUEUE_STATUSES.map((status, index) => [status, statusCounts[index] ?? null]),
      );

      return {
        id: list.id,
        name: list.name,
        address: list.address,
        queueRows,
        currentActiveMembers: currentActiveMembers.error ? null : currentActiveMembers.count ?? 0,
        samples: ((sampleResult.data ?? []) as {
          payload: unknown;
          status: string | null;
          send_date: string | null;
          last_error: string | null;
        }[])
          .map((row) => ({
            email: payloadToEmail(row.payload),
            status: row.status,
            sendDate: row.send_date,
            lastError: row.last_error,
          }))
          .filter((sample): sample is RecipientSample => Boolean(sample.email)),
        statusCounts: counts,
      } satisfies ListSummary;
    }),
  );
}

async function loadRecipientPage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
  page: number,
) {
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, count, error } = await supabase
    .from("mail_queue")
    .select("id, list_id, payload, status, send_date, created_at, updated_at, last_error, ses_message_id", {
      count: "exact",
    })
    .eq("email_id", emailId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []) as QueueRow[];
  const listIds = [
    ...new Set(rows.map((row) => row.list_id).filter((id): id is string => Boolean(id))),
  ];
  const { data: lists } = listIds.length
    ? await supabase.from("lists").select("id, name, address").in("id", listIds)
    : { data: [] as ListRow[] };
  const listsById = new Map(((lists ?? []) as ListRow[]).map((list) => [list.id, list]));

  return {
    total: count ?? rows.length,
    rows: rows.map((row) => {
      const list = row.list_id ? listsById.get(row.list_id) : null;
      return {
        id: row.id,
        email: payloadToEmail(row.payload),
        toName: payloadToName(row.payload),
        listId: row.list_id,
        listName: list?.name ?? (row.list_id ? "Unknown list" : "Direct recipient"),
        status: row.status,
        sendDate: row.send_date,
        queuedAt: row.created_at,
        updatedAt: row.updated_at,
        lastError: row.last_error,
        sesMessageId: row.ses_message_id,
      } satisfies RecipientRow;
    }),
  };
}

export default async function PastSendDetailPage({ params, searchParams }: Props) {
  await requireServerAuthContext();

  const { emailId: rawEmailId } = await params;
  const emailId = parseUuid(rawEmailId);
  if (!emailId) notFound();

  const resolvedSearchParams = await searchParams;
  const page = clampPage(resolvedSearchParams.page);
  const supabase = getSupabaseAdmin();

  const { data: email, error: emailError } = await supabase
    .from("emails")
    .select("id, subject, from_address, reply_to, status, campaigns, tags, created_at, updated_at, sent_at")
    .eq("id", emailId)
    .maybeSingle();

  if (emailError) throw emailError;
  if (!email) notFound();

  const [
    totalRows,
    succeededRows,
    failedRows,
    deadRows,
    pendingRows,
    processingRows,
    canceledRows,
    firstSentResult,
    listSummaries,
    recipientPage,
  ] = await Promise.all([
    countQueueRows(supabase, emailId),
    countQueueRows(supabase, emailId, "succeeded"),
    countQueueRows(supabase, emailId, "failed"),
    countQueueRows(supabase, emailId, "dead"),
    countQueueRows(supabase, emailId, "pending"),
    countQueueRows(supabase, emailId, "processing"),
    countQueueRows(supabase, emailId, "canceled"),
    supabase
      .from("mail_queue")
      .select("send_date, created_at")
      .eq("email_id", emailId)
      .order("created_at", { ascending: true })
      .limit(1),
    loadListSummaries(supabase, emailId),
    loadRecipientPage(supabase, emailId, page),
  ]);

  const totalPages = Math.max(1, Math.ceil(recipientPage.total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link href="/email/sends" className="text-xs font-medium text-slate-500 hover:text-slate-800">
          ← Back to past sends
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-slate-400">Past Send</p>
            <h2 className="max-w-4xl text-2xl font-semibold text-slate-900">
              {email.subject || "(no subject)"}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              From: {email.from_address || "unknown sender"}
              {email.reply_to && <> · Reply-To: {email.reply_to}</>}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              ID: <code>{email.id}</code> · Status: <code>{email.status ?? "unknown"}</code>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/api/email/preview/${email.id}`}
              target="_blank"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Preview
            </Link>
            <Link
              href={`/api/email/preview/${email.id}?mode=source`}
              target="_blank"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Source HTML
            </Link>
            <Link
              href={`/email/composer?cloneId=${email.id}`}
              className="rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
            >
              Clone as new draft
            </Link>
            <Link
              href={`/email/composer?id=${email.id}`}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Open original
            </Link>
          </div>
        </div>
      </header>

      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Queued rows" value={totalRows} />
        <Metric label="SES accepted" value={succeededRows} tone="green" />
        <Metric label="Failed/dead" value={(failedRows ?? 0) + (deadRows ?? 0)} tone="red" />
        <Metric label="Unsent/canceled" value={(pendingRows ?? 0) + (processingRows ?? 0) + (canceledRows ?? 0)} tone="amber" />
        <Fact label="First queue row" value={firstSentResult.data?.[0]?.created_at ?? null} />
        <Fact label="First send date" value={firstSentResult.data?.[0]?.send_date ?? null} />
        <Fact label="Created" value={email.created_at} />
        <Fact label="Updated" value={email.updated_at} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-800">
            Mailing Preview
          </div>
          <iframe
            src={`/api/email/preview/${email.id}`}
            title={`Preview: ${email.subject ?? "past send"}`}
            className="h-[560px] w-full border-0"
            sandbox="allow-same-origin"
          />
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-900">Source Metadata</h3>
            <MetadataList label="Campaigns" values={email.campaigns ?? []} />
            <MetadataList label="Tags" values={email.tags ?? []} />
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-900">Source Lists</h3>
            {listSummaries.length > 0 ? (
              <div className="mt-3 space-y-3">
                {listSummaries.map((list) => (
                  <div key={list.id} className="rounded-md border border-slate-100 bg-slate-50 p-3">
                    <Link
                      href={`/lists/${list.id}`}
                      className="block truncate text-sm font-semibold text-slate-800 hover:text-blue-700 hover:underline"
                    >
                      {list.name}
                    </Link>
                    <p className="truncate text-xs text-slate-500">{list.address}</p>
                    <p className="mt-2 text-xs text-slate-600">
                      {formatNullableCount(list.queueRows)} queued row{list.queueRows === 1 ? "" : "s"}
                      {list.currentActiveMembers !== null && (
                        <> · {list.currentActiveMembers.toLocaleString()} active now</>
                      )}
                    </p>
                    <StatusLine counts={list.statusCounts} />
                    {list.samples.length > 0 && (
                      <div className="mt-2 max-h-24 overflow-y-auto">
                        {list.samples.map((sample) => (
                          <p key={`${list.id}:${sample.email}`} className="truncate text-[11px] text-slate-500">
                            {sample.email} <span className={statusClassName(sample.status)}>{sample.status}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-400">No source list recorded. This may have been a direct-recipient or legacy send.</p>
            )}
          </div>
        </aside>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Recipients</h3>
            <p className="text-xs text-slate-500">
              Showing {recipientPage.rows.length.toLocaleString()} of {recipientPage.total.toLocaleString()} queued rows.
            </p>
          </div>
          <Pagination emailId={email.id} page={safePage} totalPages={totalPages} />
        </div>
        {recipientPage.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-white text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Recipient</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">List</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Status</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Send Date</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">SES Message</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recipientPage.rows.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="max-w-xs px-4 py-2">
                      <p className="truncate font-medium text-slate-800">{row.email ?? "Unknown recipient"}</p>
                      {row.toName && <p className="truncate text-slate-400">{row.toName}</p>}
                    </td>
                    <td className="max-w-xs px-4 py-2 text-slate-600">
                      {row.listId ? (
                        <Link href={`/lists/${row.listId}`} className="hover:text-blue-700 hover:underline">
                          {row.listName}
                        </Link>
                      ) : (
                        row.listName
                      )}
                    </td>
                    <td className={`px-4 py-2 ${statusClassName(row.status)}`}>{row.status ?? "unknown"}</td>
                    <td className="px-4 py-2 text-slate-500">{row.sendDate ?? "not sent"}</td>
                    <td className="max-w-xs px-4 py-2">
                      <code className="block truncate text-[11px] text-slate-500">{row.sesMessageId ?? "-"}</code>
                    </td>
                    <td className="max-w-sm px-4 py-2 text-red-600">
                      <span className="line-clamp-2">{csvSafe(row.lastError) || "-"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-slate-500">No queue recipient rows were recorded for this email.</p>
        )}
        <div className="border-t border-slate-100 px-4 py-3">
          <Pagination emailId={email.id} page={safePage} totalPages={totalPages} />
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, tone = "slate" }: { label: string; value: number | null; tone?: "slate" | "green" | "red" | "amber" }) {
  const color = {
    slate: "text-slate-900",
    green: "text-green-700",
    red: "text-red-600",
    amber: "text-amber-700",
  }[tone];

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-xl font-semibold ${color}`}>{formatNullableCount(value)}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="break-words text-sm font-medium text-slate-700">{formatDate(value)}</p>
    </div>
  );
}

function MetadataList({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="mt-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      {values.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {values.map((value) => (
            <span key={value} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {value}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-slate-400">None recorded</p>
      )}
    </div>
  );
}

function StatusLine({ counts }: { counts: Record<string, number | null> }) {
  const visible = QUEUE_STATUSES
    .map((status) => ({ status, count: counts[status] ?? 0 }))
    .filter((item) => item.count > 0);

  if (visible.length === 0) return null;

  return (
    <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
      {visible.map((item) => (
        <span key={item.status} className={statusClassName(item.status)}>
          {item.count.toLocaleString()} {item.status}
        </span>
      ))}
    </p>
  );
}

function Pagination({ emailId, page, totalPages }: { emailId: string; page: number; totalPages: number }) {
  const prev = page > 1 ? page - 1 : null;
  const next = page < totalPages ? page + 1 : null;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-500">
        Page {page} of {totalPages}
      </span>
      {prev ? (
        <Link href={`/email/sends/${emailId}?page=${prev}`} className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
          Previous
        </Link>
      ) : (
        <span className="rounded border border-slate-200 px-2 py-1 text-slate-300">Previous</span>
      )}
      {next ? (
        <Link href={`/email/sends/${emailId}?page=${next}`} className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
          Next
        </Link>
      ) : (
        <span className="rounded border border-slate-200 px-2 py-1 text-slate-300">Next</span>
      )}
    </div>
  );
}

function statusClassName(status: string | null) {
  if (status === "succeeded") return "font-medium text-green-700";
  if (status === "failed" || status === "dead") return "font-medium text-red-600";
  if (status === "pending" || status === "processing") return "font-medium text-amber-600";
  if (status === "canceled") return "font-medium text-slate-500";
  return "font-medium text-slate-400";
}

function formatNullableCount(value: number | null) {
  return value === null ? "..." : value.toLocaleString();
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
