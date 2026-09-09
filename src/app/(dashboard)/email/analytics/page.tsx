import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { revalidatePath } from "next/cache";
import { connection } from "next/server";
import { getServerAuthContext } from "@/lib/authAccess";
import {
  getDailySendLimit,
  getSesMaxSendRatePerSecond,
  setDailySendLimit,
  setSesMaxSendRatePerSecond,
} from "@/lib/appSettings";
import { isoDaysAgo } from "@/lib/dateWindows";
import { DataFreshness } from "@/components/data-freshness";
import {
  CampaignAnalyticsList,
  type CampaignAnalyticsSeed,
} from "./campaign-analytics-list";

async function updateDailySendLimitAction(formData: FormData) {
  "use server";

  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");

  const raw = String(formData.get("dailySendLimit") ?? "").replace(/,/g, "").trim();
  const nextLimit = Number(raw);
  await setDailySendLimit(nextLimit);
  revalidatePath("/email/analytics");
}

async function updateSesSendRateAction(formData: FormData) {
  "use server";

  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");

  const raw = String(formData.get("sesMaxSendRatePerSecond") ?? "").replace(/,/g, "").trim();
  const nextRate = Number(raw);
  await setSesMaxSendRatePerSecond(nextRate);
  revalidatePath("/email/analytics");
}

export default async function AnalyticsPage() {
  await connection();
  const supabase = getSupabaseAdmin();
  const dailySendLimit = await getDailySendLimit();
  const sesMaxSendRatePerSecond = await getSesMaxSendRatePerSecond();

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
    { count: opensAllTime },
    { count: clicksAllTime },
    { count: bouncesAllTime },
    { count: sesEventsAllTime },
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
      .eq("event_type", "opened"),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "clicked"),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "bounced"),
    supabase
      .from("provider_events")
      .select("id", { count: "exact", head: true })
      .eq("provider", "ses"),
  ]);

  const recentOpens = opensLast7Days ?? 0;
  const recentClicks = clicksLast7Days ?? 0;
  const recentBounces = bouncesLast7Days ?? 0;
  const allTimeOpens = opensAllTime ?? 0;
  const allTimeClicks = clicksAllTime ?? 0;
  const allTimeBounces = bouncesAllTime ?? 0;
  const hasSnsEvents = (sesEventsAllTime ?? 0) > 0;

  // Campaign identities render immediately. A client-side queue refreshes one
  // campaign metric at a time and reuses timestamped browser-cached results.
  const { data: recentEmails } = await supabase
    .from("emails")
    .select("id, subject, status, created_at")
    .neq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(50);
  const campaigns: CampaignAnalyticsSeed[] = ((recentEmails ?? []) as {
    id: string;
    subject: string;
    status: string;
    created_at: string | null;
  }[]).map((email) => ({
    emailId: email.id,
    subject: email.subject,
    status: email.status,
    createdAt: email.created_at,
  }));
  const generatedAt = new Date().toISOString();

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Insights</p>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold text-slate-900">Analytics</h2>
          <DataFreshness timestamp={generatedAt} />
        </div>
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
          sub={`${dailySendLimit.toLocaleString()} SES rolling 24h cap`}
          color={pending > 0 ? "blue" : "slate"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Open events, 7 days"
          value={hasSnsEvents ? recentOpens.toLocaleString() : "—"}
          sub={
            hasSnsEvents
              ? `${allTimeOpens.toLocaleString()} all time`
              : "awaiting SNS events"
          }
          color="blue"
        />
        <StatCard
          label="Click events, 7 days"
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

      {/* ── SES capacity ── */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
        <form action={updateDailySendLimitAction} className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-slate-700">
            SES rolling 24h send cap
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
            {dailySendLimit.toLocaleString()} recipients / rolling 24h · {pending.toLocaleString()} pending in queue
          </span>
        </form>
        <form action={updateSesSendRateAction} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-slate-700">
            SES max send rate / sec
            <input
              name="sesMaxSendRatePerSecond"
              type="number"
              min={0.1}
              max={1_000}
              step={0.1}
              defaultValue={sesMaxSendRatePerSecond}
              className="mt-1 w-40 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            Save rate
          </button>
          <span className="pb-2 text-slate-500">
            Worker targets 90% of this value for sustained sends.
          </span>
        </form>
      </div>

      {/* ── Per-campaign table ── */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-slate-700">
          Campaigns{" "}
          <span className="font-normal text-slate-400">(most recent 50)</span>
        </h3>

        <CampaignAnalyticsList campaigns={campaigns} />
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
