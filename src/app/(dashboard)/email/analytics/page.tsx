import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/authAccess";
import { getDailySendLimit, setDailySendLimit } from "@/lib/appSettings";
import { isoDaysAgo } from "@/lib/dateWindows";

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
  const supabase = getSupabaseAdmin();
  const dailySendLimit = await getDailySendLimit();

  // ── Delivery totals — COUNT queries at DB level, not full table scans ────────
  const [
    { count: totalSent },
    { count: totalFailed },
    { count: totalPending },
  ] = await Promise.all([
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "succeeded"),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .in("status", ["failed", "dead"]),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "processing"]),
  ]);

  const delivered = totalSent ?? 0;
  const failed = totalFailed ?? 0;
  const pending = totalPending ?? 0;
  const totalAttempted = delivered + failed;
  const deliveryRate =
    totalAttempted > 0 ? Math.round((delivered / totalAttempted) * 100) : null;

  // ── Engagement totals — last 30 days, event type only (no payload) ──────────
  const thirtyDaysAgo = isoDaysAgo(30);

  const { data: recentEvents } = await supabase
    .from("provider_events")
    .select("event_type")
    .gte("received_at", thirtyDaysAgo);

  const eventCounts =
    recentEvents?.reduce<Record<string, number>>((acc, e) => {
      acc[e.event_type] = (acc[e.event_type] ?? 0) + 1;
      return acc;
    }, {}) ?? {};

  const opens = eventCounts["opened"] ?? 0;
  const clicks = eventCounts["clicked"] ?? 0;
  const bounces = eventCounts["bounced"] ?? 0;

  const openRate =
    delivered > 0 ? ((opens / delivered) * 100).toFixed(1) : null;
  const clickRate =
    delivered > 0 ? ((clicks / delivered) * 100).toFixed(1) : null;

  const hasSnsEvents = (recentEvents?.length ?? 0) > 0;

  // ── Per-campaign breakdown — uses campaign_stats VIEW (DB-level GROUP BY) ────
  // Falls back to an empty list with an advisory message if the migration has
  // not been applied yet.
  type CampaignStat = {
    campaign_label: string;
    email_id: string;
    list_id: string | null;
      sent: number;
      failed: number;
      pending: number;
      started_at: string | null;
  };

  let campaignStats: CampaignStat[] = [];
  let viewMissing = false;

  const { data: campaignData, error: campaignError } = await supabase
    .from("campaign_stats")
    .select("campaign_label, email_id, list_id, sent, failed, pending, started_at")
    .order("started_at", { ascending: false })
    .limit(100);

  if (campaignError) {
    // View not yet created — fall back to a bounded scan of mail_queue
    // (last 90 days, max 5 000 rows) so historical data is still visible.
    viewMissing = true;
    const ninetyDaysAgo = isoDaysAgo(90);
    const { data: rawRows } = await supabase
      .from("mail_queue")
      .select("campaign_label, email_id, list_id, status, created_at")
      .not("campaign_label", "is", null)
      .gte("created_at", ninetyDaysAgo)
      .limit(5000);

    const grouped = new Map<string, CampaignStat>();
    for (const row of rawRows ?? []) {
      if (!row.campaign_label || !row.email_id) continue;
      const key = row.campaign_label;
      const entry: CampaignStat = grouped.get(key) ?? {
        campaign_label: key,
        email_id: row.email_id,
        list_id: row.list_id ?? null,
        sent: 0,
        failed: 0,
        pending: 0,
        started_at: row.created_at,
      };
      if (row.status === "succeeded") entry.sent++;
      else if (row.status === "failed" || row.status === "dead") entry.failed++;
      else if (row.status === "pending" || row.status === "processing") entry.pending++;
      if (row.created_at && row.created_at < (entry.started_at ?? row.created_at)) {
        entry.started_at = row.created_at;
      }
      grouped.set(key, entry);
    }
    campaignStats = [...grouped.values()]
      .sort((a, b) => ((b.started_at ?? "") > (a.started_at ?? "") ? 1 : -1))
      .slice(0, 100);
  } else {
    campaignStats = (campaignData ?? []) as CampaignStat[];
  }

  // Fetch email subjects + list names for the campaigns we have.
  const emailIds = [...new Set(campaignStats.map((c) => c.email_id))];
  const listIds = [...new Set(campaignStats.map((c) => c.list_id).filter(Boolean) as string[])];

  const [{ data: emailRows }, { data: listRows }, { data: eventRows }, { data: queueRows }] =
    await Promise.all([
      emailIds.length
        ? supabase.from("emails").select("id, subject").in("id", emailIds)
        : Promise.resolve({ data: [] as { id: string; subject: string }[] }),
      listIds.length
        ? supabase.from("lists").select("id, name").in("id", listIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      // Per-campaign event counts — last 90 days only.
      supabase
        .from("provider_events")
        .select("email_id, event_type")
        .in("event_type", ["opened", "clicked", "bounced"])
        .not("email_id", "is", null)
        .gte("received_at", isoDaysAgo(90)),
      emailIds.length
        ? supabase
            .from("mail_queue")
            .select("email_id, status, ses_message_id")
            .in("email_id", emailIds)
        : Promise.resolve({ data: [] as { email_id: string; status: string; ses_message_id: string | null }[] }),
    ]);

  const emailSubjects = new Map((emailRows ?? []).map((e) => [e.id, e.subject]));
  const listNames = new Map((listRows ?? []).map((l) => [l.id, l.name]));

  const eventsByEmail = new Map<string, { opens: number; clicks: number; bounces: number }>();
  for (const ev of eventRows ?? []) {
    if (!ev.email_id) continue;
    const entry = eventsByEmail.get(ev.email_id) ?? { opens: 0, clicks: 0, bounces: 0 };
    if (ev.event_type === "opened") entry.opens++;
    else if (ev.event_type === "clicked") entry.clicks++;
    else if (ev.event_type === "bounced") entry.bounces++;
    eventsByEmail.set(ev.email_id, entry);
  }

  const sendConfirmationByEmail = new Map<string, { sent: number; amazonAccepted: number }>();
  for (const row of queueRows ?? []) {
    if (!row.email_id || row.status !== "succeeded") continue;
    const entry = sendConfirmationByEmail.get(row.email_id) ?? { sent: 0, amazonAccepted: 0 };
    entry.sent++;
    if (row.ses_message_id) entry.amazonAccepted++;
    sendConfirmationByEmail.set(row.email_id, entry);
  }

  const campaigns = campaignStats.map((c) => {
    const evts = eventsByEmail.get(c.email_id) ?? { opens: 0, clicks: 0, bounces: 0 };
    const confirmation = sendConfirmationByEmail.get(c.email_id) ?? { sent: c.sent, amazonAccepted: 0 };
    return {
      ...c,
      subject: emailSubjects.get(c.email_id) ?? null,
      list_name: c.list_id ? (listNames.get(c.list_id) ?? null) : null,
      amazonAccepted: confirmation.amazonAccepted,
      opens: evts.opens,
      clicks: evts.clicks,
      bounces: evts.bounces,
    };
  });

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Insights</p>
        <h2 className="text-2xl font-semibold text-slate-900">Analytics</h2>
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
          label="Delivered"
          value={delivered.toLocaleString()}
          sub={
            deliveryRate !== null
              ? `${deliveryRate}% delivery rate`
              : pending > 0
              ? `${pending} pending`
              : "no sends yet"
          }
          color="green"
        />
        <StatCard
          label="Failed"
          value={failed > 0 ? failed.toLocaleString() : "0"}
          sub={
            hasSnsEvents && bounces > 0
              ? `${bounces.toLocaleString()} bounces reported`
              : totalAttempted > 0
              ? `${Math.round((failed / totalAttempted) * 100)}% of attempts`
              : "—"
          }
          color={failed > 0 ? "red" : "slate"}
        />
        <StatCard
          label="Opens"
          value={hasSnsEvents ? opens.toLocaleString() : "—"}
          sub={hasSnsEvents && openRate ? `${openRate}% open rate` : "awaiting SNS events"}
          color="blue"
        />
        <StatCard
          label="Clicks"
          value={hasSnsEvents ? clicks.toLocaleString() : "—"}
          sub={hasSnsEvents && clickRate ? `${clickRate}% click rate` : "awaiting SNS events"}
          color="blue"
        />
      </div>

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
          <span className="font-normal text-slate-400">(most recent 100)</span>
        </h3>

        {viewMissing && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 mb-3">
            <span className="font-medium">Showing last 90 days (fallback).</span>{" "}
            Run{" "}
            <code className="rounded bg-amber-100 px-1">
              supabase/migrations/20260421_analytics_views.sql
            </code>{" "}
            for full history and better performance.
          </div>
        )}
        {campaigns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
            No campaigns sent yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">List</th>
                  <th className="px-4 py-3 text-right">Sent</th>
                  <th className="px-4 py-3 text-right">Failed</th>
                  <th className="px-4 py-3 text-right">Opens</th>
                  <th className="px-4 py-3 text-right">Clicks</th>
                  <th className="px-4 py-3 text-right">Bounces</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {campaigns.map((c) => (
                  <tr key={c.campaign_label} className="bg-white hover:bg-slate-50">
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
                          c.sent > 0 && c.amazonAccepted === c.sent
                            ? "Amazon SES accepted every sent row and returned message IDs."
                            : `${c.amazonAccepted.toLocaleString()} of ${c.sent.toLocaleString()} sent rows have SES message IDs.`
                        }
                      >
                        {c.sent > 0 && c.amazonAccepted === c.sent && (
                          <span className="font-semibold text-green-600" aria-label="SES accepted">
                            ✓
                          </span>
                        )}
                        {c.sent.toLocaleString()}
                      </span>
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        c.failed > 0 ? "text-red-600" : "text-slate-400"
                      }`}
                    >
                      {c.failed > 0 ? c.failed.toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {hasSnsEvents ? c.opens.toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {hasSnsEvents ? c.clicks.toLocaleString() : "—"}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        c.bounces > 0 ? "text-amber-600" : "text-slate-400"
                      }`}
                    >
                      {hasSnsEvents
                        ? c.bounces > 0
                          ? c.bounces.toLocaleString()
                          : "—"
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
