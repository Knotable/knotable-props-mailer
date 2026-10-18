import type { Metadata } from "next";
import { requireCanSendAuthContext } from "@/lib/authAccess";
import { campaignContentDigest, estimateSendDuration, getAutopilotRecord } from "@/lib/sendAutopilot";
import { checkSendRequest, loadSendRequestByToken } from "@/lib/sendApprovalRequests";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ApproveForm } from "./approve-form";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata: Metadata = { title: "Approve send · Props", robots: { index: false, follow: false } };

const fmt = (n: number) => n.toLocaleString("en-US");
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";

function Notice({ tone, children }: { tone: "red" | "amber" | "green"; children: React.ReactNode }) {
  const cls =
    tone === "red"
      ? "border-red-200 bg-red-50 text-red-800"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-green-200 bg-green-50 text-green-800";
  return <div className={`rounded-md border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

export default async function ApprovePage({ params }: { params: Promise<{ token: string }> }) {
  await requireCanSendAuthContext();
  const { token } = await params;
  const request = await loadSendRequestByToken(token);
  if (!request) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <h1 className="text-xl font-semibold">Approve send</h1>
        <Notice tone="red">This approval link is not valid. Ask for a new one.</Notice>
      </div>
    );
  }

  const supabase = getSupabaseAdmin();
  // The per-list summary can hit the statement timeout on a 180k-row queue.
  // Retry, and never mistake a failed count for "nothing left to send".
  const loadSummaries = async () => {
    let last: { message: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase.rpc("get_queue_campaign_summaries", { p_email_ids: [request.emailId], p_now: new Date().toISOString() });
      if (!error) return { data, error: null };
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    return { data: null, error: last };
  };
  const [{ data: email }, { data: summaries, error: summaryError }, record] = await Promise.all([
    supabase.from("emails").select("status, subject, from_address, reply_to, html, text").eq("id", request.emailId).maybeSingle(),
    loadSummaries(),
    getAutopilotRecord(request.emailId),
  ]);

  const rows = (summaries ?? []).map((r) => ({ listId: r.list_id, unsent: Number(r.pending_due ?? 0) + Number(r.pending_held ?? 0), sent: Number(r.succeeded ?? 0) }));
  const unsent = rows.reduce((t, r) => t + r.unsent, 0);
  const listIds = rows.map((r) => r.listId).filter((id): id is string => Boolean(id));
  const { data: lists } = listIds.length
    ? await supabase.from("lists").select("id, name").in("id", listIds)
    : { data: [] as { id: string; name: string }[] };
  const listName = new Map((lists ?? []).map((l) => [l.id, l.name]));

  const check = checkSendRequest(request, email ? campaignContentDigest(email) : null);
  const statusOk = email && ["queued", "sending"].includes(email.status);
  const drift = unsent !== request.unsentAtRequest;
  const countUnavailable = Boolean(summaryError);
  const canApprove = check.ok && statusOk && unsent > 0 && !countUnavailable;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Send approval</p>
        <h1 className="break-words text-xl font-semibold text-slate-900">{request.subject}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Requested by {request.requestedBy} on {when(request.requestedAt)} · link expires {when(request.expiresAt)}
        </p>
      </div>

      {!check.ok && <Notice tone={check.reason === "decided" && request.status === "approved" ? "green" : "red"}>{check.message}</Notice>}
      {check.ok && !statusOk && <Notice tone="red">This campaign is {email?.status ?? "missing"} now, so it can’t be sent from this link.</Notice>}
      {countUnavailable && <Notice tone="amber">The database was too busy to count recipients just now. Reload this page in a few seconds; the link still works.</Notice>}
      {check.ok && statusOk && !countUnavailable && unsent === 0 && <Notice tone="amber">No unsent recipients remain for this campaign.</Notice>}
      {request.lastError && check.ok && <Notice tone="amber">Last attempt failed: {request.lastError}</Notice>}
      {request.note && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <span className="font-medium">Note from the requester:</span> {request.note}
        </div>
      )}

      <dl className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">From</dt>
          <dd className="break-all font-medium">{email?.from_address ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Reply-to</dt>
          <dd className="break-all font-medium">{email?.reply_to || "same as From"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Recipients this send</dt>
          <dd className="text-lg font-semibold">{fmt(unsent)}</dd>
          {drift && (
            <dd className="text-xs text-amber-700">Was {fmt(request.unsentAtRequest)} when requested.</dd>
          )}
        </div>
        <div>
          <dt className="text-slate-500">Estimated duration</dt>
          <dd className="font-medium">{estimateSendDuration(unsent) ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Send window</dt>
          <dd className="font-medium">{request.sendWindow ?? "Any time (no window)"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Start</dt>
          <dd className="font-medium">{request.sendAt ? when(request.sendAt) : "Immediately after approval"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-slate-500">Audience</dt>
          <dd>
            <ul className="mt-1 space-y-1">
              {rows.map((r) => (
                <li key={r.listId ?? "direct"} className="flex justify-between gap-3">
                  <span className="break-words">{r.listId ? (listName.get(r.listId) ?? r.listId) : "Direct recipients"}</span>
                  <span className="whitespace-nowrap tabular-nums">
                    {fmt(r.unsent)} unsent{r.sent ? ` · ${fmt(r.sent)} already sent` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
        {record && (
          <div className="sm:col-span-2 text-xs text-slate-500">Autopilot state: {record.state}</div>
        )}
      </dl>

      <div className="overflow-hidden rounded-lg border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span>Exactly what recipients will see</span>
          <a className="underline" href={`/api/email/preview/${request.emailId}`} target="_blank" rel="noreferrer">
            Open full size
          </a>
        </div>
        <iframe
          title="Email preview"
          src={`/api/email/preview/${request.emailId}`}
          sandbox="allow-same-origin"
          className="h-[70vh] w-full bg-white"
        />
      </div>

      {canApprove ? (
        <ApproveForm token={token} expectedRecipients={unsent} />
      ) : (
        <a href="/email/schedule" className="inline-block text-sm text-slate-600 underline">
          Back to the schedule
        </a>
      )}
    </div>
  );
}
