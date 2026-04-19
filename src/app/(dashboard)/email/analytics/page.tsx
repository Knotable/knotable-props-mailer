import { createServerSupabaseClient } from "@/lib/supabaseServer";

type CampaignRow = {
  campaign_label: string;
  email_id: string;
  subject: string | null;
  list_name: string | null;
  sent: number;
  failed: number;
  opens: number;
  clicks: number;
  bounces: number;
};

export default async function AnalyticsPage() {
  const supabase = await createServerSupabaseClient();

  // ── Delivery totals from mail_queue ────────────────────────────────────────
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

  // ── Engagement totals from provider_events (last 30 days) ──────────────────
  const { data: recentEvents } = await supabase
    .from("provider_events")
    .select("event_type")
    .gte(
      "received_at",
      new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString()
    );

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

  // ── Per-campaign breakdown ─────────────────────────────────────────────────
  // Get distinct campaign_labels with their email_id, then join emails + lists
  const { data: campaignGroups } = await supabase
    .from("mail_queue")
    .select(
      "campaign_label, email_id, list_id, status"
    )
    .not("campaign_label", "is", null)
    .order("campaign_label", { ascending: false });

  // Aggregate per campaign_label
  const campaignMap = new Map<
    string,
    { email_id: string; list_id: string | null; sent: number; failed: number }
  >();

  for (const row of campaignGroups ?? []) {
    const key = row.campaign_label as string;
    const existing = campaignMap.get(key);
    const isSent = row.status === "succeeded";
    const isFailed = row.status === "failed" || row.status === "dead";
    if (existing) {
      if (isSent) existing.sent++;
      if (isFailed) existing.failed++;
    } else {
      campaignMap.set(key, {
        email_id: row.email_id as string,
        list_id: row.list_id as string | null,
        sent: isSent ? 1 : 0,
        failed: isFailed ? 1 : 0,
      });
    }
  }

  // Fetch email subjects and list names for the unique IDs
  const emailIds = [...new Set([...campaignMap.values()].map((c) => c.email_id).filter(Boolean))];
  const listIds = [...new Set([...campaignMap.values()].map((c) => c.list_id).filter(Boolean) as string[])];

  const [{ data: emailRows }, { data: listRows }, { data: eventRows }] =
    await Promise.all([
      emailIds.length
        ? supabase.from("emails").select("id, subject").in("id", emailIds)
        : Promise.resolve({ data: [] }),
      listIds.length
        ? supabase.from("lists").select("id, name").in("id", listIds)
        : Promise.resolve({ data: [] }),
      supabase
        .from("provider_events")
        .select("email_id, event_type")
        .in("event_type", ["opened", "clicked", "bounced"])
        .not("email_id", "is", null),
    ]);

  const emailSubjects = new Map((emailRows ?? []).map((e) => [e.id, e.subject]));
  const listNames = new Map((listRows ?? []).map((l) => [l.id, l.name]));

  // Count events per email_id
  const eventsByEmail = new Map<string, { opens: number; clicks: number; bounces: number }>();
  for (const ev of eventRows ?? []) {
    if (!ev.email_id) continue;
    const entry = eventsByEmail.get(ev.email_id) ?? { opens: 0, clicks: 0, bounces: 0 };
    if (ev.event_type === "opened") entry.opens++;
    else if (ev.event_type === "clicked") entry.clicks++;
    else if (ev.event_type === "bounced") entry.bounces++;
    eventsByEmail.set(ev.email_id, entry);
  }

  const campaigns: CampaignRow[] = [...campaignMap.entries()].map(
    ([label, data]) => {
      const evts = eventsByEmail.get(data.email_id) ?? { opens: 0, clicks: 0, bounces: 0 };
      return {
        campaign_label: label,
        email_id: data.email_id,
        subject: emailSubjects.get(data.email_id) ?? null,
        list_name: data.list_id ? (listNames.get(data.list_id) ?? null) : null,
        sent: data.sent,
        failed: data.failed,
        opens: evts.opens,
        clicks: evts.clicks,
        bounces: evts.bounces,
      };
    }
  );

  const hasSnsEvents = recentEvents && recentEvents.length > 0;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Insights</p>
        <h2 className="text-2xl font-semibold text-slate-900">Analytics</h2>
        {!hasSnsEvents && (
          <p className="mt-1 text-sm text-amber-600">
            Open/click/bounce tracking requires SES → SNS → <code className="text-xs bg-amber-50 px-1 rounded">/api/webhooks/ses</code> to be configured in AWS.
            Delivery stats below are live.
          </p>
        )}
      </header>

      {/* ── Summary cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Delivered"
          value={delivered.toLocaleString()}
          sub={deliveryRate !== null ? `${deliveryRate}% delivery rate` : pending > 0 ? `${pending} pending` : "no sends yet"}
          color="green"
        />
        <StatCard
          label="Failed"
          value={failed > 0 ? failed.toLocaleString() : "0"}
          sub={totalAttempted > 0 ? `${Math.round((failed / totalAttempted) * 100)}% of attempts` : "—"}
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

      {/* ── Per-campaign table ── */}
      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Campaigns</h3>
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
                    <td className="px-4 py-3 font-medium text-slate-800 max-w-xs truncate">
                      {c.subject ?? <span className="text-slate-400 italic">untitled</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.list_name ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{c.sent.toLocaleString()}</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${c.failed > 0 ? "text-red-600" : "text-slate-400"}`}>
                      {c.failed > 0 ? c.failed.toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {hasSnsEvents ? c.opens.toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {hasSnsEvents ? c.clicks.toLocaleString() : "—"}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums ${c.bounces > 0 ? "text-amber-600" : "text-slate-400"}`}>
                      {hasSnsEvents ? (c.bounces > 0 ? c.bounces.toLocaleString() : "—") : "—"}
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
      <p className={`text-2xl font-semibold mt-1 ${valueColors[color]}`}>{value}</p>
      <p className="text-xs text-slate-500 mt-1">{sub}</p>
    </div>
  );
}
