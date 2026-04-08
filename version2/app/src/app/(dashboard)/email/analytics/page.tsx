import { createServerSupabaseClient } from "@/lib/supabaseServer";

const defaultMetrics = [
  { label: "Open rate", value: "--", delta: "waiting" },
  { label: "Click rate", value: "--", delta: "waiting" },
  { label: "Bounces", value: "--", delta: "waiting" },
];

export default async function AnalyticsPage() {
  const supabase = await createServerSupabaseClient();
  const { data: events } = await supabase
    .from("provider_events")
    .select("event_type")
    // eslint-disable-next-line react-hooks/purity
    .gte("received_at", new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString());

  const counts =
    events?.reduce<Record<string, number>>((acc, curr) => {
      acc[curr.event_type] = (acc[curr.event_type] ?? 0) + 1;
      return acc;
    }, {}) ?? {};

  const metrics = [
    {
      label: "Open rate",
      value: counts["opened"] ? `${counts["opened"]}` : defaultMetrics[0].value,
      delta: defaultMetrics[0].delta,
    },
    {
      label: "Click rate",
      value: counts["clicked"] ? `${counts["clicked"]}` : defaultMetrics[1].value,
      delta: defaultMetrics[1].delta,
    },
    {
      label: "Bounces",
      value: counts["bounced"] ? `${counts["bounced"]}` : defaultMetrics[2].value,
      delta: defaultMetrics[2].delta,
    },
  ];

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Insights</p>
        <h2 className="text-2xl font-semibold text-slate-900">Engagement</h2>
        <p className="text-sm text-slate-500">Mailgun webhooks → Supabase provider_events → UI.</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{metric.label}</p>
            <p className="text-2xl font-semibold text-slate-900">{metric.value}</p>
            <p className="text-xs text-slate-500">{metric.delta}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
        Chart placeholder – daily opens/clicks stacked chart.
      </div>
    </div>
  );
}
