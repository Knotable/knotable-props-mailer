import Link from "next/link";
import { notFound } from "next/navigation";
import { requireServerAuthContext } from "@/lib/authAccess";
import { getMailerRuntimeLimits } from "@/lib/dailyQuota";
import { parseUuid } from "@/lib/ids";
import { subjectPlaceholderTerms } from "@/lib/subjectReadiness";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MEMBER_STATUSES = ["active", "unsubscribed", "blocked", "bounced", "complained"] as const;

type Props = { params: Promise<{ emailId: string }> };
type Tone = "green" | "amber" | "red" | "slate" | "blue";
type Check = { label: string; detail: string; tone: Tone; blocking?: boolean };

function extractUrls(html: string, attribute: "href" | "src") {
  const values: string[] = [];
  const pattern = new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, "gi");
  for (const match of html.matchAll(pattern)) values.push(match[1]);
  return [...new Set(values)];
}

function unresolvedTags(value: string) {
  return [...new Set([...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1].trim()))];
}

async function exactCount(
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>,
) {
  const result = await query;
  return result.error ? null : result.count ?? 0;
}

export default async function SendReadinessPage({ params }: Props) {
  await requireServerAuthContext();
  const { emailId: rawEmailId } = await params;
  const emailId = parseUuid(rawEmailId);
  if (!emailId) notFound();

  const supabase = getSupabaseAdmin();
  const { data: email, error: emailError } = await supabase
    .from("emails")
    .select("id, subject, from_address, reply_to, html, text, status, scheduled_at, campaigns, tags, created_at, updated_at")
    .eq("id", emailId)
    .maybeSingle();
  if (emailError) throw emailError;
  if (!email) notFound();

  const now = new Date();
  const nowIso = now.toISOString();
  const [
    { data: recipientRows },
    { data: queueSummaryRows, error: queueSummaryError },
    runtime,
    { data: globalSummaryRows, error: globalSummaryError },
    latestProviderEvent,
  ] =
    await Promise.all([
      supabase.from("email_recipients").select("recipient_address").eq("email_id", emailId),
      supabase.rpc("get_queue_campaign_summaries", { p_email_ids: [emailId], p_now: nowIso }),
      getMailerRuntimeLimits(emailId, now),
      supabase.rpc("get_global_active_queue_summary", { p_now: nowIso }),
      supabase.from("provider_events").select("received_at, event_type").order("received_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
  if (queueSummaryError) throw queueSummaryError;
  if (globalSummaryError) throw globalSummaryError;

  const queueListIds = [...new Set((queueSummaryRows ?? []).map((row) => row.list_id).filter(Boolean))] as string[];
  const recipientAddresses = (recipientRows ?? []).map((row) => row.recipient_address.toLowerCase());
  const { data: lists } = queueListIds.length
    ? await supabase.from("lists").select("id, name, address, access_level").in("id", queueListIds)
    : { data: [] };
  const matchedLists = (lists ?? []).filter(
    (list) => queueListIds.includes(list.id) || recipientAddresses.includes(list.address.toLowerCase()),
  );
  const listIds = matchedLists.map((list) => list.id);

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [{ data: memberSummaryRows, error: memberSummaryError }, recentContactRows] = await Promise.all([
    listIds.length
      ? supabase.rpc("get_list_member_status_summaries", { p_list_ids: listIds })
      : Promise.resolve({ data: [], error: null }),
    listIds.length
      ? exactCount(
          supabase
            .from("mail_queue")
            .select("id", { count: "exact", head: true })
            .in("list_id", listIds)
            .neq("email_id", emailId)
            .eq("status", "succeeded")
            .gte("send_date", thirtyDaysAgo),
        )
      : Promise.resolve(0),
  ]);
  if (memberSummaryError) throw memberSummaryError;
  const memberCounts = new Map(
    (memberSummaryRows ?? []).map((row) => [`${row.list_id}:${row.status}`, Number(row.member_count)]),
  );
  const queueCounts = (queueSummaryRows ?? []).reduce(
    (counts, row) => ({
      total: counts.total + Number(row.total ?? 0),
      held: counts.held + Number(row.pending_held ?? 0),
      due: counts.due + Number(row.pending_due ?? 0),
      processing: counts.processing + Number(row.processing ?? 0),
      succeeded: counts.succeeded + Number(row.succeeded ?? 0),
      failed: counts.failed + Number(row.failed ?? 0) + Number(row.dead ?? 0),
      canceled: counts.canceled + Number(row.canceled ?? 0),
    }),
    { total: 0, held: 0, due: 0, processing: 0, succeeded: 0, failed: 0, canceled: 0 },
  );
  const globalSummary = globalSummaryRows?.[0];
  const globalDue = Number(globalSummary?.pending_due ?? 0);
  const globalProcessing = Number(globalSummary?.processing ?? 0);
  const quota = runtime.quota;
  const maxRate = runtime.sesMaxSendRatePerSecond;

  const activeAudience = matchedLists.reduce(
    (sum, list) => sum + (memberCounts.get(`${list.id}:active`) ?? 0),
    0,
  );
  const suppressedAudience = matchedLists.reduce(
    (sum, list) =>
      sum +
      MEMBER_STATUSES.filter((status) => status !== "active").reduce(
        (inner, status) => inner + (memberCounts.get(`${list.id}:${status}`) ?? 0),
        0,
      ),
    0,
  );
  const directAudience = matchedLists.length === 0 ? recipientAddresses.length : 0;
  const plannedAudience = (queueCounts.total ?? 0) > 0 ? queueCounts.total ?? 0 : activeAudience + directAudience;
  const quotaDays = plannedAudience > 0
    ? plannedAudience <= quota.remainingRolling24h
      ? 1
      : (quota.remainingRolling24h > 0 ? 1 : 0) +
        Math.ceil((plannedAudience - quota.remainingRolling24h) / quota.dailyCap)
    : 0;
  const estimatedSeconds = maxRate > 0 ? Math.ceil(plannedAudience / (maxRate * 0.9)) : null;

  const links = extractUrls(email.html, "href").filter((url) => !url.startsWith("mailto:") && !url.startsWith("#"));
  const images = extractUrls(email.html, "src");
  const insecureUrls = [...links, ...images].filter((url) => url.startsWith("http://"));
  const missingAltImages = [...email.html.matchAll(/<img\b[^>]*>/gi)].filter((match) => !/\balt\s*=\s*["'][^"']*["']/i.test(match[0])).length;
  const mergeTags = unresolvedTags(`${email.subject}\n${email.html}\n${email.text ?? ""}`);
  const placeholderSubjectTerms = subjectPlaceholderTerms(email.subject);
  const latestEventAt = latestProviderEvent.data?.received_at ?? null;
  const eventAgeHours = latestEventAt ? (now.getTime() - new Date(latestEventAt).getTime()) / 3_600_000 : null;
  const hasConfigurationSet = Boolean(process.env.AWS_SES_CONFIGURATION_SET?.trim());
  const hasSnsTopic = Boolean(process.env.AWS_SES_SNS_TOPIC_ARN?.trim());

  const checks: Check[] = [
    {
      label: "Send-ready subject",
      detail: placeholderSubjectTerms.length === 0
        ? "Subject contains no draft, test, or placeholder markers."
        : `Remove placeholder term${placeholderSubjectTerms.length === 1 ? "" : "s"}: ${placeholderSubjectTerms.join(", ")}.`,
      tone: placeholderSubjectTerms.length === 0 ? "green" : "red",
      blocking: placeholderSubjectTerms.length > 0,
    },
    {
      label: "Audience selected",
      detail: matchedLists.length
        ? `${matchedLists.map((list) => list.name).join(", ")} · ${activeAudience.toLocaleString()} active`
        : directAudience > 0
          ? `${directAudience.toLocaleString()} direct recipient${directAudience === 1 ? "" : "s"}`
          : "No list or direct recipients are attached.",
      tone: plannedAudience > 0 ? "green" : "red",
      blocking: plannedAudience === 0,
    },
    {
      label: "Required content",
      detail: !email.subject.trim()
        ? "Subject is missing."
        : !email.from_address.trim()
          ? "From address is missing."
          : !email.html.trim()
            ? "HTML body is empty."
            : "Subject, sender, and HTML body are present.",
      tone: email.subject.trim() && email.from_address.trim() && email.html.trim() ? "green" : "red",
      blocking: !(email.subject.trim() && email.from_address.trim() && email.html.trim()),
    },
    {
      label: "Reply and unsubscribe",
      detail: email.reply_to
        ? `Reply-To is ${email.reply_to}; the sender adds a mailto List-Unsubscribe header.`
        : "No Reply-To is set, so this send will not receive the app's mailto List-Unsubscribe header.",
      tone: email.reply_to ? "green" : "amber",
    },
    {
      label: "SES tracking pipeline",
      detail: hasConfigurationSet && hasSnsTopic
        ? "Configuration-set and SNS topic environment settings are present. Confirm Open and Click are enabled in the SES event destination."
        : "Tracking environment settings are incomplete; provider delivery/open/click data may be absent.",
      tone: hasConfigurationSet && hasSnsTopic ? "green" : "red",
      blocking: false,
    },
    {
      label: "Provider-event freshness",
      detail: latestEventAt
        ? `Latest ${latestProviderEvent.data?.event_type ?? "provider"} event: ${formatDate(latestEventAt)}${eventAgeHours !== null ? ` (${Math.round(eventAgeHours)}h ago)` : ""}.`
        : "No provider event has been recorded.",
      tone: eventAgeHours === null ? "red" : eventAgeHours <= 48 ? "green" : "amber",
    },
    {
      label: "Global queue isolation",
      detail: `${globalDue.toLocaleString()} due and ${globalProcessing.toLocaleString()} processing rows globally. Use only the scoped monitor for this campaign.`,
      tone: globalDue === queueCounts.due && globalProcessing === queueCounts.processing ? "green" : "amber",
    },
  ];

  const blockers = checks.filter((check) => check.blocking);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link href={`/email/composer?id=${email.id}`} className="text-xs font-medium text-slate-500 hover:text-slate-800">
          ← Back to campaign
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Send readiness</p>
            <h2 className="max-w-4xl text-2xl font-semibold text-slate-900">{email.subject || "Untitled campaign"}</h2>
            <p className="mt-1 text-sm text-slate-500">Read-only preflight · ID <code>{email.id}</code></p>
          </div>
          <div className={`rounded-full px-3 py-1.5 text-sm font-semibold ${blockers.length ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
            {blockers.length ? `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}` : "No hard blockers"}
          </div>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Planned audience" value={plannedAudience.toLocaleString()} detail={`${suppressedAudience.toLocaleString()} excluded/suppressed`} tone="blue" />
        <Metric label="Quota available now" value={quota.remainingRolling24h.toLocaleString()} detail={`${quota.rolling24hSent.toLocaleString()} accepted in rolling 24h`} tone={quota.remainingRolling24h >= plannedAudience ? "green" : "amber"} />
        <Metric label="Estimated quota slices" value={quotaDays ? quotaDays.toLocaleString() : "—"} detail={`${quota.dailyCap.toLocaleString()} per rolling 24h`} tone={quotaDays <= 1 ? "green" : "amber"} />
        <Metric label="Fastest drain time" value={estimatedSeconds === null ? "—" : formatDuration(estimatedSeconds)} detail={`Worker target ≈ ${(maxRate * 0.9).toFixed(1)}/sec`} tone="slate" />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Readiness checks</h3>
          <span className="text-xs text-slate-400">Generated {formatDate(new Date().toISOString())}</span>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {checks.map((check) => <ReadinessCheck key={check.label} check={check} />)}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">Audience and contact risk</h3>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <Fact label="Active members" value={activeAudience.toLocaleString()} />
            <Fact label="Suppressed/excluded" value={suppressedAudience.toLocaleString()} />
            <Fact label="Already sent this email" value={(queueCounts.succeeded ?? 0).toLocaleString()} tone={(queueCounts.succeeded ?? 0) > 0 ? "amber" : "slate"} />
            <Fact label="Other sends to list, 30d" value={(recentContactRows ?? 0).toLocaleString()} tone={(recentContactRows ?? 0) > 0 ? "amber" : "slate"} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">The 30-day number is delivered queue rows, not necessarily unique people. The queue confirmation remains the authoritative duplicate-recipient check.</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">Campaign queue</h3>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Fact label="Held" value={formatCount(queueCounts.held)} />
            <Fact label="Due" value={formatCount(queueCounts.due)} tone={(queueCounts.due ?? 0) > 0 ? "amber" : "slate"} />
            <Fact label="Processing" value={formatCount(queueCounts.processing)} tone={(queueCounts.processing ?? 0) > 0 ? "blue" : "slate"} />
            <Fact label="SES accepted" value={formatCount(queueCounts.succeeded)} tone="green" />
            <Fact label="Failed/dead" value={formatCount(queueCounts.failed)} tone={(queueCounts.failed ?? 0) > 0 ? "red" : "slate"} />
            <Fact label="Canceled" value={formatCount(queueCounts.canceled)} />
          </dl>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">Content and tracking inventory</h3>
        <div className="mt-3 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Links" value={links.length.toLocaleString()} />
          <Fact label="Images" value={images.length.toLocaleString()} />
          <Fact label="Merge tags" value={mergeTags.length.toLocaleString()} />
          <Fact label="Plain-text part" value={email.text?.trim() ? "Present" : "Missing"} tone={email.text?.trim() ? "green" : "amber"} />
        </div>
        {(insecureUrls.length > 0 || missingAltImages > 0 || mergeTags.length > 0) && (
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <Inventory label="HTTP URLs" values={insecureUrls} empty="All extracted URLs use HTTPS or non-web schemes." tone={insecureUrls.length ? "amber" : "green"} />
            <Inventory label="Images missing alt" values={missingAltImages ? [`${missingAltImages} image tag${missingAltImages === 1 ? "" : "s"}`] : []} empty="All image tags include alt text." tone={missingAltImages ? "amber" : "green"} />
            <Inventory label="Personalization tags" values={mergeTags} empty="No merge tags found." tone="slate" />
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <Link href={`/api/email/preview/${email.id}`} target="_blank" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Preview</Link>
        <Link href={`/email/sends/${email.id}`} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Campaign analytics</Link>
        <Link href={`/email/monitor?emailId=${email.id}`} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Scoped monitor</Link>
      </div>
    </div>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: Tone }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-wide text-slate-400">{label}</p><p className={`mt-1 text-2xl font-semibold ${toneText(tone)}`}>{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>;
}

function ReadinessCheck({ check }: { check: Check }) {
  return <div className={`rounded-lg border p-3 ${toneBox(check.tone)}`}><div className="flex items-center gap-2"><span className="text-base" aria-hidden>{check.tone === "green" ? "✓" : check.tone === "red" ? "!" : "•"}</span><p className="text-sm font-semibold">{check.label}</p></div><p className="mt-1 pl-6 text-xs opacity-80">{check.detail}</p></div>;
}

function Fact({ label, value, tone = "slate" }: { label: string; value: string; tone?: Tone }) {
  return <div><dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt><dd className={`mt-0.5 font-semibold ${toneText(tone)}`}>{value}</dd></div>;
}

function Inventory({ label, values, empty, tone }: { label: string; values: string[]; empty: string; tone: Tone }) {
  return <div className={`rounded-lg border p-3 ${toneBox(tone)}`}><p className="text-xs font-semibold uppercase tracking-wide">{label}</p>{values.length ? <ul className="mt-2 space-y-1 text-xs">{values.slice(0, 8).map((value) => <li key={value} className="break-all">{value}</li>)}</ul> : <p className="mt-2 text-xs">{empty}</p>}</div>;
}

function toneText(tone: Tone) { return { green: "text-green-700", amber: "text-amber-700", red: "text-red-700", slate: "text-slate-800", blue: "text-blue-700" }[tone]; }
function toneBox(tone: Tone) { return { green: "border-green-200 bg-green-50 text-green-800", amber: "border-amber-200 bg-amber-50 text-amber-900", red: "border-red-200 bg-red-50 text-red-800", slate: "border-slate-200 bg-slate-50 text-slate-700", blue: "border-blue-200 bg-blue-50 text-blue-800" }[tone]; }
function formatCount(value: number | null) { return value === null ? "Unavailable" : value.toLocaleString(); }
function formatDuration(seconds: number) { if (seconds < 60) return `${seconds}s`; const minutes = Math.ceil(seconds / 60); if (minutes < 60) return `${minutes}m`; const hours = minutes / 60; return `${hours.toFixed(hours < 10 ? 1 : 0)}h`; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
