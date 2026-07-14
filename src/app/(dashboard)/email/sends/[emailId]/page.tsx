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
  deliveredEvents: number;
  propsOpenEvents: number;
  sesOpenEvents: number;
  clickEvents: number;
  bounceEvents: number;
  complaintEvents: number;
  firstOpenAt: string | null;
  lastOpenAt: string | null;
  firstClickAt: string | null;
  lastClickAt: string | null;
  latestEventAt: string | null;
};

type AnalyticsDetail = {
  queued: number;
  sesAccepted: number;
  withSesMessageId: number;
  deliveredUnique: number;
  bouncedUnique: number;
  complainedUnique: number;
  openedUnique: number;
  propsOpenedUnique: number;
  sesOpenedUnique: number;
  clickedUnique: number;
  deliveryEvents: number;
  openEvents: number;
  propsOpenEvents: number;
  sesOpenEvents: number;
  clickEvents: number;
  firstEventAt: string | null;
  latestEventAt: string | null;
};

type TopLink = {
  url: string;
  totalClicks: number;
  uniqueRecipients: number;
  lastClickedAt: string | null;
};

type RpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message?: string } | null }>;
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
        deliveredEvents: 0,
        propsOpenEvents: 0,
        sesOpenEvents: 0,
        clickEvents: 0,
        bounceEvents: 0,
        complaintEvents: 0,
        firstOpenAt: null,
        lastOpenAt: null,
        firstClickAt: null,
        lastClickAt: null,
        latestEventAt: null,
      } satisfies RecipientRow;
    }),
  };
}

async function loadAnalyticsDetail(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
) {
  const { data, error } = await (supabase as unknown as RpcClient).rpc(
    "get_email_analytics_detail",
    { p_email_id: emailId },
  );
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (error || !row) return { detail: null, exact: false } as const;

  const number = (key: string) => Number(row[key] ?? 0);
  return {
    exact: true,
    detail: {
      queued: number("queued"),
      sesAccepted: number("ses_accepted"),
      withSesMessageId: number("with_ses_message_id"),
      deliveredUnique: number("delivered_unique"),
      bouncedUnique: number("bounced_unique"),
      complainedUnique: number("complained_unique"),
      openedUnique: number("opened_unique"),
      propsOpenedUnique: number("props_opened_unique"),
      sesOpenedUnique: number("ses_opened_unique"),
      clickedUnique: number("clicked_unique"),
      deliveryEvents: number("delivery_events"),
      openEvents: number("open_events"),
      propsOpenEvents: number("props_open_events"),
      sesOpenEvents: number("ses_open_events"),
      clickEvents: number("click_events"),
      firstEventAt: typeof row.first_event_at === "string" ? row.first_event_at : null,
      latestEventAt: typeof row.latest_event_at === "string" ? row.latest_event_at : null,
    } satisfies AnalyticsDetail,
  } as const;
}

async function loadTopLinks(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
) {
  const { data, error } = await (supabase as unknown as RpcClient).rpc("get_email_top_links", {
    p_email_id: emailId,
    p_limit: 20,
  });
  if (error || !Array.isArray(data)) return [] as TopLink[];
  return data.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      url: String(row.url ?? ""),
      totalClicks: Number(row.total_clicks ?? 0),
      uniqueRecipients: Number(row.unique_recipients ?? 0),
      lastClickedAt: typeof row.last_clicked_at === "string" ? row.last_clicked_at : null,
    };
  }).filter((row) => row.url);
}

async function loadRecipientActivityPage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  emailId: string,
  page: number,
  filters: { status: string | null; event: string | null; search: string | null },
) {
  const { data, error } = await (supabase as unknown as RpcClient).rpc(
    "get_email_recipient_activity",
    {
      p_email_id: emailId,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
      p_status: filters.status,
      p_event_type: filters.event,
      p_search: filters.search,
    },
  );

  if (error || !Array.isArray(data)) {
    const fallback = await loadRecipientPage(supabase, emailId, page);
    return { ...fallback, exact: false };
  }

  const rawRows = data as Record<string, unknown>[];
  const listIds = [...new Set(rawRows.map((row) => row.list_id).filter((id): id is string => typeof id === "string"))];
  const { data: lists } = listIds.length
    ? await supabase.from("lists").select("id, name").in("id", listIds)
    : { data: [] as { id: string; name: string }[] };
  const listNames = new Map((lists ?? []).map((list) => [list.id, list.name]));
  const text = (row: Record<string, unknown>, key: string) => typeof row[key] === "string" ? row[key] as string : null;
  const number = (row: Record<string, unknown>, key: string) => Number(row[key] ?? 0);

  return {
    exact: true,
    total: Number(rawRows[0]?.total_count ?? 0),
    rows: rawRows.map((row) => {
      const listId = text(row, "list_id");
      return {
        id: String(row.queue_id),
        email: text(row, "recipient"),
        toName: text(row, "recipient_name"),
        listId,
        listName: listId ? listNames.get(listId) ?? "Unknown list" : "Direct recipient",
        status: text(row, "queue_status"),
        sendDate: text(row, "send_date"),
        queuedAt: text(row, "queued_at"),
        updatedAt: text(row, "queue_updated_at"),
        lastError: text(row, "last_error"),
        sesMessageId: text(row, "ses_message_id"),
        deliveredEvents: number(row, "delivered_events"),
        propsOpenEvents: number(row, "props_open_events"),
        sesOpenEvents: number(row, "ses_open_events"),
        clickEvents: number(row, "click_events"),
        bounceEvents: number(row, "bounce_events"),
        complaintEvents: number(row, "complaint_events"),
        firstOpenAt: text(row, "first_open_at"),
        lastOpenAt: text(row, "last_open_at"),
        firstClickAt: text(row, "first_click_at"),
        lastClickAt: text(row, "last_click_at"),
        latestEventAt: text(row, "latest_event_at"),
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
  const search = singleParam(resolvedSearchParams.search);
  const statusFilter = singleParam(resolvedSearchParams.status);
  const eventFilter = singleParam(resolvedSearchParams.event);
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
    analyticsResult,
    topLinks,
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
    loadRecipientActivityPage(supabase, emailId, page, {
      status: statusFilter,
      event: eventFilter,
      search,
    }),
    loadAnalyticsDetail(supabase, emailId),
    loadTopLinks(supabase, emailId),
  ]);

  const totalPages = Math.max(1, Math.ceil(recipientPage.total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const analytics = analyticsResult.detail;
  const acceptedDenominator = analytics?.sesAccepted ?? succeededRows ?? 0;
  const deliveryRate = rate(analytics?.deliveredUnique ?? 0, acceptedDenominator);
  const openRate = rate(analytics?.openedUnique ?? 0, acceptedDenominator);
  const clickRate = rate(analytics?.clickedUnique ?? 0, acceptedDenominator);

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

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Campaign analytics</h3>
            <p className="mt-1 text-xs text-slate-500">
              Unique people are the headline metric; raw events show repeat activity. Opens combine
              SES and the Props pixel without counting the same recipient twice.
            </p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${analyticsResult.exact ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-800"}`}>
            {analyticsResult.exact ? "Exact database counts" : "Migration required"}
          </span>
        </div>

        {!analyticsResult.exact && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Apply <code>supabase/migrations/20260714_campaign_analytics_detail.sql</code> to enable exact
            engagement counts, filters, and timelines. Queue outcomes below remain exact.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <AnalyticsMetric label="SES accepted" value={acceptedDenominator} detail={`${analytics?.withSesMessageId ?? 0} with SES message ID`} tone="green" />
          <AnalyticsMetric label="Delivered" value={analytics?.deliveredUnique ?? null} detail={deliveryRate === null ? "provider confirmation" : `${deliveryRate}% of accepted`} tone="green" />
          <AnalyticsMetric label="Opened" value={analytics?.openedUnique ?? null} detail={openRate === null ? "unique recipients" : `${openRate}% of accepted`} tone="blue" />
          <AnalyticsMetric label="Clicked" value={analytics?.clickedUnique ?? null} detail={clickRate === null ? "unique recipients" : `${clickRate}% of accepted`} tone="blue" />
          <AnalyticsMetric label="Bounced / complained" value={analytics ? analytics.bouncedUnique + analytics.complainedUnique : null} detail={analytics ? `${analytics.bouncedUnique} bounced · ${analytics.complainedUnique} complained` : "provider events"} tone={(analytics?.bouncedUnique ?? 0) + (analytics?.complainedUnique ?? 0) > 0 ? "red" : "slate"} />
        </div>

        <div className="grid gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <ConfidenceFact label="Open sources" value={analytics ? `${analytics.propsOpenedUnique.toLocaleString()} Props pixel · ${analytics.sesOpenedUnique.toLocaleString()} SES` : "Unavailable"} />
          <ConfidenceFact label="Repeat activity" value={analytics ? `${analytics.openEvents.toLocaleString()} open events · ${analytics.clickEvents.toLocaleString()} click events` : "Unavailable"} />
          <ConfidenceFact label="Provider coverage" value={analytics && analytics.sesAccepted > 0 ? `${rate(analytics.withSesMessageId, analytics.sesAccepted) ?? 0}% have SES IDs` : "No accepted rows"} />
          <ConfidenceFact label="Latest provider event" value={analytics?.latestEventAt ? formatDate(analytics.latestEventAt) : "None recorded"} />
        </div>

        <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <span className="font-semibold">How to read this:</span> clicks are the strongest engagement
          signal here. Opens are directional because image blocking and privacy preloading can create
          false negatives and false positives. “SES accepted” is submission, while “Delivered” is the
          receiving mail server confirmation.
        </div>
      </section>

      {topLinks.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Top clicked links</h3>
            <p className="text-xs text-slate-500">Ranked by unique recipients, then total clicks.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="text-slate-400"><tr><th className="px-4 py-2">Destination</th><th className="px-4 py-2 text-right">People</th><th className="px-4 py-2 text-right">Clicks</th><th className="px-4 py-2">Latest</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {topLinks.map((link) => <tr key={link.url}><td className="max-w-2xl px-4 py-2"><a href={link.url} target="_blank" rel="noopener noreferrer" className="block truncate font-medium text-blue-700 hover:underline">{link.url}</a></td><td className="px-4 py-2 text-right tabular-nums">{link.uniqueRecipients.toLocaleString()}</td><td className="px-4 py-2 text-right tabular-nums">{link.totalClicks.toLocaleString()}</td><td className="px-4 py-2 text-slate-500">{formatDate(link.lastClickedAt)}</td></tr>)}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Recipient activity</h3>
            <p className="text-xs text-slate-500">
              Showing {recipientPage.rows.length.toLocaleString()} of {recipientPage.total.toLocaleString()} matching recipients.
              {!recipientPage.exact && " Event detail needs the analytics-detail migration."}
            </p>
          </div>
          <Pagination emailId={email.id} page={safePage} totalPages={totalPages} filters={{ search, status: statusFilter, event: eventFilter }} />
        </div>
        <form method="get" className="grid gap-2 border-b border-slate-100 bg-white p-3 sm:grid-cols-[minmax(12rem,1fr)_10rem_10rem_auto]">
          <input name="search" defaultValue={search ?? ""} placeholder="Search recipient email" className="rounded-md border border-slate-300 px-3 py-2 text-xs" />
          <select name="status" defaultValue={statusFilter ?? ""} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs"><option value="">Any queue status</option>{QUEUE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
          <select name="event" defaultValue={eventFilter ?? ""} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs"><option value="">Any activity</option>{["delivered", "opened", "clicked", "bounced", "complained"].map((event) => <option key={event} value={event}>{event}</option>)}</select>
          <div className="flex gap-2"><button className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white">Filter</button><Link href={`/email/sends/${email.id}`} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600">Clear</Link></div>
        </form>
        {recipientPage.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-white text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Recipient</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">List</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Status</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Delivery</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Opens</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Clicks</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-wide">Latest activity</th>
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
                    <td className="px-4 py-2"><EventCount count={row.deliveredEvents} label="delivered" tone="green" />{row.bounceEvents > 0 && <EventCount count={row.bounceEvents} label="bounced" tone="red" />}{row.complaintEvents > 0 && <EventCount count={row.complaintEvents} label="complained" tone="red" />}{row.lastError && <p className="mt-1 max-w-xs line-clamp-2 text-[10px] text-red-600">{csvSafe(row.lastError)}</p>}</td>
                    <td className="px-4 py-2"><EventCount count={row.propsOpenEvents + row.sesOpenEvents} label="events" tone="blue" />{row.propsOpenEvents + row.sesOpenEvents > 0 && <p className="text-[10px] text-slate-400">{row.propsOpenEvents} Props · {row.sesOpenEvents} SES</p>}</td>
                    <td className="px-4 py-2"><EventCount count={row.clickEvents} label="events" tone="blue" />{row.lastClickAt && <p className="text-[10px] text-slate-400">{formatDate(row.lastClickAt)}</p>}</td>
                    <td className="px-4 py-2 text-slate-500"><p>{formatDate(row.latestEventAt ?? row.updatedAt)}</p><p className="mt-1 text-[10px] text-slate-400">Sent {row.sendDate ?? "not sent"}</p></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-slate-500">No recipients match these filters.</p>
        )}
        <div className="border-t border-slate-100 px-4 py-3">
          <Pagination emailId={email.id} page={safePage} totalPages={totalPages} filters={{ search, status: statusFilter, event: eventFilter }} />
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

function AnalyticsMetric({ label, value, detail, tone }: { label: string; value: number | null; detail: string; tone: "slate" | "green" | "red" | "blue" }) {
  const color = { slate: "text-slate-900", green: "text-green-700", red: "text-red-700", blue: "text-blue-700" }[tone];
  return <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value === null ? "—" : value.toLocaleString()}</p><p className="mt-1 text-[11px] text-slate-500">{detail}</p></div>;
}

function ConfidenceFact({ label, value }: { label: string; value: string }) {
  return <div><p className="font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 font-medium text-slate-700">{value}</p></div>;
}

function EventCount({ count, label, tone }: { count: number; label: string; tone: "green" | "red" | "blue" }) {
  if (count <= 0) return <span className="text-slate-300">—</span>;
  const color = { green: "text-green-700", red: "text-red-700", blue: "text-blue-700" }[tone];
  return <p className={`font-semibold tabular-nums ${color}`}>{count.toLocaleString()} {label}</p>;
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

function Pagination({ emailId, page, totalPages, filters }: { emailId: string; page: number; totalPages: number; filters: { search: string | null; status: string | null; event: string | null } }) {
  const prev = page > 1 ? page - 1 : null;
  const next = page < totalPages ? page + 1 : null;
  const href = (targetPage: number) => {
    const params = new URLSearchParams({ page: String(targetPage) });
    if (filters.search) params.set("search", filters.search);
    if (filters.status) params.set("status", filters.status);
    if (filters.event) params.set("event", filters.event);
    return `/email/sends/${emailId}?${params.toString()}`;
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-500">
        Page {page} of {totalPages}
      </span>
      {prev ? (
        <Link href={href(prev)} className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
          Previous
        </Link>
      ) : (
        <span className="rounded border border-slate-200 px-2 py-1 text-slate-300">Previous</span>
      )}
      {next ? (
        <Link href={href(next)} className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
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

function singleParam(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
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
