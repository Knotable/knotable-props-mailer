import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { revalidatePath } from "next/cache";
import { connection } from "next/server";
import { getServerAuthContext } from "@/lib/authAccess";
import { getDailySendLimit, setDailySendLimit } from "@/lib/appSettings";
import { isoDaysAgo } from "@/lib/dateWindows";
import { DataFreshness } from "@/components/data-freshness";

async function updateDailySendLimitAction(formData: FormData) {
  "use server";

  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");

  const raw = String(formData.get("dailySendLimit") ?? "").replace(/,/g, "").trim();
  const nextLimit = Number(raw);
  await setDailySendLimit(nextLimit);
  revalidatePath("/email/analytics");
}

export default async function AnalyticsPage() {
  await connection();
  const supabase = getSupabaseAdmin();
  const dailySendLimit = await getDailySendLimit();

  // ── Delivery totals — COUNT queries at DB level, not full table scans ────────
  const last7Date = isoDaysAgo(7).slice(0, 10);
  const last7Timestamp = isoDaysAgo(7);
  const [
    { count: sentAllTime },
    { count: sentLast7Days },
    { count: failedAllTime },
    { count: failedLast7Days },
    { count: totalPending },
  ] = await Promise.all([
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "succeeded"),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "succeeded")
      .gte("send_date", last7Date),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .in("status", ["failed", "dead"]),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .in("status", ["failed", "dead"])
      .gte("updated_at", last7Timestamp),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "processing"]),
  ]);

  const delivered = sentAllTime ?? 0;
  const deliveredLast7Days = sentLast7Days ?? 0;
  const failed = failedAllTime ?? 0;
  const recentFailed = failedLast7Days ?? 0;
  const pending = totalPending ?? 0;
  const totalAttempted = delivered + failed;
  const deliveryRate =
    totalAttempted > 0 ? Math.round((delivered / totalAttempted) * 100) : null;

  // ── Engagement totals — matching last-7-days and all-time buckets ───────────
  const [
    { count: opensLast7Days },
    { count: clicksLast7Days },
    { count: bouncesLast7Days },
    { count: deliveredAllTimeEvents },
    { count: complaintsAllTime },
    { count: opensAllTime },
    { count: clicksAllTime },
    { count: bouncesAllTime },
  ] = await Promise.all([
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "opened")
      .gte("received_at", last7Timestamp),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "clicked")
      .gte("received_at", last7Timestamp),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "bounced")
      .gte("received_at", last7Timestamp),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "delivered"),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "complained"),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "opened"),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "clicked"),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "bounced"),
  ]);

  const recentOpens = opensLast7Days ?? 0;
  const recentClicks = clicksLast7Days ?? 0;
  const recentBounces = bouncesLast7Days ?? 0;
  const allTimeProviderDeliveries = deliveredAllTimeEvents ?? 0;
  const allTimeComplaints = complaintsAllTime ?? 0;
  const allTimeOpens = opensAllTime ?? 0;
  const allTimeClicks = clicksAllTime ?? 0;
  const allTimeBounces = bouncesAllTime ?? 0;
  const hasSnsEvents =
    allTimeProviderDeliveries + allTimeComplaints + allTimeOpens + allTimeClicks + allTimeBounces > 0;

  // ── Per-campaign breakdown — pages from emails, then does exact indexed
  // counts for only the visible campaigns in Postgres.
  type CampaignAnalyticsRow = {
    email_id: string;
    subject: string;
    from_address: string;
    status: string;
    created_at: string | null;
    list_ids: string[];
    sent: number;
    failed: number;
    pending: number;
    canceled: number;
    delivered: number;
    bounced: number;
    complained: number;
    opened: number;
    clicked: number;
    first_sent: string | null;
    last_queued_at: string | null;
    latest_event_at: string | null;
    total_count: number | null;
  };

  type AnalyticsRpcClient = {
    rpc(
      fn: "get_recent_email_analytics_stats",
      args: { p_limit: number; p_offset: number },
    ): Promise<{ data: CampaignAnalyticsRow[] | null; error: { message?: string } | null }>;
  };

  let campaignStats: CampaignAnalyticsRow[] = [];
  let analyticsRpcMissing = false;

  const { data: recentAnalyticsStats, error: recentAnalyticsStatsError } = await (
    supabase as unknown as AnalyticsRpcClient
  ).rpc("get_recent_email_analytics_stats", {
    p_limit: 50,
    p_offset: 0,
  });

  if (recentAnalyticsStatsError) {
    analyticsRpcMissing = true;

    const { data: recentEmails } = await supabase
      .from("emails")
      .select("id, subject, from_address, status, created_at")
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(50);

    campaignStats = ((recentEmails ?? []) as {
      id: string;
      subject: string;
      from_address: string;
      status: string;
      created_at: string | null;
    }[]).map((email) => ({
        email_id: email.id,
        subject: email.subject,
        from_address: email.from_address,
        status: email.status,
        created_at: email.created_at,
        list_ids: [],
        sent: 0,
        failed: 0,
        pending: 0,
        canceled: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
        opened: 0,
        clicked: 0,
        first_sent: null,
        last_queued_at: email.created_at,
        latest_event_at: null,
        total_count: null,
      }));
  } else {
    campaignStats = ((recentAnalyticsStats ?? []) as CampaignAnalyticsRow[]).map((row) => ({
      email_id: row.email_id,
      subject: row.subject,
      from_address: row.from_address,
      status: row.status,
      created_at: row.created_at,
      list_ids: row.list_ids ?? [],
      sent: Number(row.sent),
      failed: Number(row.failed),
      pending: Number(row.pending),
      canceled: Number(row.canceled),
      delivered: Number(row.delivered),
      bounced: Number(row.bounced),
      complained: Number(row.complained),
      opened: Number(row.opened),
      clicked: Number(row.clicked),
      first_sent: row.first_sent,
      last_queued_at: row.last_queued_at ?? row.created_at,
      latest_event_at: row.latest_event_at,
      total_count: Number(row.total_count ?? 0),
    }));
  }

  // Fetch list names for the campaigns we have.
  const listIds = [...new Set(campaignStats.flatMap((c) => c.list_ids).filter(Boolean))];

  const { data: listRows } = listIds.length
    ? await supabase.from("lists").select("id, name").in("id", listIds)
    : { data: [] as { id: string; name: string }[] };
  const listNames = new Map((listRows ?? []).map((l) => [l.id, l.name]));

  const campaigns = campaignStats.map((c) => {
    const engagementRate = c.sent > 0 ? Math.round((c.opened / c.sent) * 1000) / 10 : null;
    const clickRate = c.sent > 0 ? Math.round((c.clicked / c.sent) * 1000) / 10 : null;
    const bounceRate = c.sent > 0 ? Math.round((c.bounced / c.sent) * 1000) / 10 : null;

    return {
      ...c,
      list_name:
        c.list_ids.length > 0
          ? c.list_ids.map((listId) => listNames.get(listId) ?? "Unknown list").join(", ")
          : null,
      engagementRate,
      clickRate,
      bounceRate,
    };
  });
  const generatedAt = new Date().toISOString();

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Insights</p>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold text-slate-900">Analytics</h2>
          <DataFreshness timestamp={generatedAt} />
        </div>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Queue acceptance, provider confirmations, and engagement for recent campaigns. Counts are
          generated server-side so the mobile view and desktop table use the same source.
        </p>
        {!hasSnsEvents && (
          <p className="mt-1 text-sm text-amber-600">
            Bounce/complaint/delivery tracking requires SES → SNS →{" "}
            <code className="rounded bg-amber-50 px-1 text-xs">/api/webhooks/ses</code> to be
            configured in AWS. Opens/clicks only work if SES event publishing is configured for
            those event types through a configuration set.
          </p>
        )}
      </header>

      {/* ── Summary cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Sent last 7 days"
          value={deliveredLast7Days.toLocaleString()}
          sub={`${recentFailed.toLocaleString()} failed in same window`}
          color="green"
        />
        <StatCard
          label="Sent all time"
          value={delivered.toLocaleString()}
          sub={
            deliveryRate !== null
              ? `${deliveryRate}% delivery success`
              : pending > 0
                ? `${pending.toLocaleString()} pending`
                : "no sends yet"
          }
          color="green"
        />
        <StatCard
          label="Failures all time"
          value={failed > 0 ? failed.toLocaleString() : "0"}
          sub={
            hasSnsEvents && allTimeBounces > 0
              ? `${allTimeBounces.toLocaleString()} bounces reported`
              : totalAttempted > 0
                ? `${Math.round((failed / totalAttempted) * 100)}% of attempts`
                : "no failed rows"
          }
          color={failed > 0 ? "red" : "slate"}
        />
        <StatCard
          label="Pending now"
          value={pending.toLocaleString()}
          sub={`${dailySendLimit.toLocaleString()} daily cap`}
          color={pending > 0 ? "blue" : "slate"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Opens last 7 days"
          value={hasSnsEvents ? recentOpens.toLocaleString() : "—"}
          sub={
            hasSnsEvents
              ? `${allTimeOpens.toLocaleString()} all time`
              : "awaiting SNS events"
          }
          color="blue"
        />
        <StatCard
          label="Clicks last 7 days"
          value={hasSnsEvents ? recentClicks.toLocaleString() : "—"}
          sub={
            hasSnsEvents
              ? `${allTimeClicks.toLocaleString()} all time`
              : "awaiting SNS events"
          }
          color="blue"
        />
        <StatCard
          label="Bounces last 7 days"
          value={hasSnsEvents ? recentBounces.toLocaleString() : "—"}
          sub={
            hasSnsEvents
              ? `${allTimeBounces.toLocaleString()} all time`
              : "awaiting SNS events"
          }
          color={recentBounces > 0 ? "red" : "slate"}
        />
      </div>

      <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm sm:grid-cols-3">
        <ConfidenceItem
          label="Queue truth"
          value="SES accepted rows"
          detail="Sent counts come from mail_queue succeeded rows, not from open pixels."
        />
        <ConfidenceItem
          label="Provider truth"
          value={hasSnsEvents ? "Events present" : "Awaiting events"}
          detail="Delivered, bounced, complaints, opens, and clicks depend on SES/SNS."
          tone={hasSnsEvents ? "green" : "amber"}
        />
        <ConfidenceItem
          label="Campaign rows"
          value={analyticsRpcMissing ? "Fallback mode" : "Exact recent counts"}
          detail={
            analyticsRpcMissing
              ? "Apply the 20260702 analytics RPC migration for full campaign stats."
              : "Recent rows are counted in Postgres without page-level sampling."
          }
          tone={analyticsRpcMissing ? "amber" : "green"}
        />
      </section>

      {/* ── Daily capacity ── */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
        <form action={updateDailySendLimitAction} className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-slate-700">
            Daily send cap
            <input
              name="dailySendLimit"
              type="number"
              min={1}
              max={1_000_000}
              step={1}
              defaultValue={dailySendLimit}
              className="mt-1 w-40 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            Save cap
          </button>
          <span className="pb-2 text-slate-500">
            {dailySendLimit.toLocaleString()} emails/day · {pending.toLocaleString()} pending in queue
          </span>
        </form>
      </div>

      {/* ── Per-campaign table ── */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-slate-700">
          Campaigns{" "}
          <span className="font-normal text-slate-400">(most recent 50)</span>
        </h3>

        {analyticsRpcMissing && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 mb-3">
            <span className="font-medium">Showing recent emails without exact analytics totals.</span>{" "}
            Run{" "}
            <code className="rounded bg-amber-100 px-1">
              supabase/migrations/20260702_recent_analytics_rpc.sql
            </code>{" "}
            for exact queue and provider-event campaign totals.
          </div>
        )}
        {campaigns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
            No campaigns sent yet.
          </div>
        ) : (
          <>
          <div className="space-y-3 md:hidden">
            {campaigns.map((c) => (
              <article
                key={c.email_id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="break-words text-sm font-semibold text-slate-900">
                      {c.subject || "Untitled campaign"}
                    </h4>
                    <p className="mt-1 truncate text-xs text-slate-500">
                      {c.list_name ?? "No list recorded"}
                    </p>
                  </div>
                  <StatusBadge status={c.status} />
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <MiniMetric label="sent" value={c.sent} tone="green" />
                  <MiniMetric label="opened" value={c.opened} tone="blue" />
                  <MiniMetric label="clicked" value={c.clicked} tone="blue" />
                  <MiniMetric label="pending" value={c.pending} tone="amber" />
                  <MiniMetric label="failed" value={c.failed} tone="red" />
                  <MiniMetric label="bounced" value={c.bounced} tone="amber" />
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <RatePill label="open" value={c.engagementRate} />
                  <RatePill label="click" value={c.clickRate} />
                  <RatePill label="bounce" value={c.bounceRate} tone={c.bounceRate && c.bounceRate > 0 ? "amber" : "slate"} />
                </div>

                <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 text-xs">
                  <span className="min-w-0 truncate text-slate-500">
                    {c.latest_event_at
                      ? `Latest event ${formatDate(c.latest_event_at)}`
                      : c.last_queued_at
                        ? `Queued ${formatDate(c.last_queued_at)}`
                        : "No activity timestamp"}
                  </span>
                  <Link
                    href={`/email/sends?emailId=${c.email_id}`}
                    className="shrink-0 rounded-md border border-slate-200 px-2.5 py-1.5 font-medium text-slate-700"
                  >
                    History
                  </Link>
                </div>
              </article>
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 md:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">List</th>
                  <th className="px-4 py-3 text-right">SES accepted</th>
                  <th className="px-4 py-3 text-right">Delivered</th>
                  <th className="px-4 py-3 text-right">Pending</th>
                  <th className="px-4 py-3 text-right">Failed</th>
                  <th className="px-4 py-3 text-right">Opens</th>
                  <th className="px-4 py-3 text-right">Clicks</th>
                  <th className="px-4 py-3 text-right">Bounces</th>
                  <th className="px-4 py-3 text-right">Complaints</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {campaigns.map((c) => (
                  <tr key={c.email_id} className="bg-white hover:bg-slate-50">
                    <td className="max-w-xs truncate px-4 py-3 font-medium text-slate-800">
                      {c.subject ?? (
                        <span className="italic text-slate-400">untitled</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.list_name ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      <span
                        className="inline-flex items-center justify-end gap-1"
                        title={
                          c.sent > 0
                            ? "Accepted by SES according to mail_queue succeeded rows."
                            : "No succeeded queue rows yet."
                        }
                      >
                        {c.sent > 0 && (
                          <span className="font-semibold text-green-600" aria-label="SES accepted">
                            ✓
                          </span>
                        )}
                        {c.sent.toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {hasSnsEvents ? c.delivered.toLocaleString() : "—"}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        c.pending > 0 ? "text-blue-700" : "text-slate-400"
                      }`}
                    >
                      {c.pending > 0 ? c.pending.toLocaleString() : "—"}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        c.failed > 0 ? "text-red-600" : "text-slate-400"
                      }`}
                    >
                      {c.failed > 0 ? c.failed.toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {hasSnsEvents ? c.opened.toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {hasSnsEvents ? c.clicked.toLocaleString() : "—"}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        c.bounced > 0 ? "text-amber-600" : "text-slate-400"
                      }`}
                    >
                      {hasSnsEvents
                        ? c.bounced > 0
                          ? c.bounced.toLocaleString()
                          : "—"
                        : "—"}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        c.complained > 0 ? "text-red-600" : "text-slate-400"
                      }`}
                    >
                      {hasSnsEvents
                        ? c.complained > 0
                          ? c.complained.toLocaleString()
                          : "—"
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: "green" | "red" | "blue" | "slate";
}) {
  const valueColors = {
    green: "text-green-700",
    red: "text-red-700",
    blue: "text-blue-700",
    slate: "text-slate-900",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueColors[color]}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function ConfidenceItem({
  label,
  value,
  detail,
  tone = "slate",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "slate" | "green" | "amber";
}) {
  const toneClasses = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
  };

  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${toneClasses[tone]}`}>
        {value}
      </p>
      <p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p>
    </div>
  );
}

function MiniMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "blue" | "amber" | "red";
}) {
  const toneClasses = {
    green: "text-emerald-700",
    blue: "text-blue-700",
    amber: "text-amber-700",
    red: "text-red-700",
  };

  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-2">
      <p className={`text-base font-semibold tabular-nums ${toneClasses[tone]}`}>
        {value.toLocaleString()}
      </p>
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
    </div>
  );
}

function RatePill({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: number | null;
  tone?: "slate" | "amber";
}) {
  const toneClasses = {
    slate: "border-slate-200 bg-slate-50 text-slate-600",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
  };

  return (
    <span className={`rounded-full border px-2 py-1 font-medium ${toneClasses[tone]}`}>
      {label} {value === null ? "—" : `${value}%`}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusClass =
    status === "sent"
      ? "bg-emerald-50 text-emerald-700"
      : status === "queued" || status === "sending"
        ? "bg-blue-50 text-blue-700"
        : status === "failed"
          ? "bg-red-50 text-red-700"
          : "bg-slate-100 text-slate-600";

  return (
    <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${statusClass}`}>
      {status}
    </span>
  );
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}
