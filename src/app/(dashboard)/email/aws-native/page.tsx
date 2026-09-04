import { connection } from "next/server";
import Link from "next/link";
import { requireAdminAuthContext } from "@/lib/authAccess";
import { getNativeCampaignStatus } from "@/lib/awsNativeCampaign";
import { dispatchNativeDryRunAction, dispatchNativeSendAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AwsNativeCampaignPage({
  searchParams,
}: {
  searchParams: Promise<{ campaignId?: string; notice?: string }>;
}) {
  await connection();
  if (process.env.AWS_NATIVE_CONTROL_ENABLED !== "true") throw new Error("AWS-native control is not production-enabled.");
  const auth = await requireAdminAuthContext();
  if (!auth.canSend) throw new Error("Send permission required.");
  const params = await searchParams;
  const campaignId = params.campaignId?.trim() ?? "";
  let status = null;
  let error: string | null = null;
  if (campaignId) {
    try {
      status = await getNativeCampaignStatus(campaignId);
      if (!status) error = "No frozen AWS campaign control record was found.";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Unable to read AWS campaign status.";
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">Durable AWS execution</p>
        <h2 className="text-2xl font-semibold text-slate-900">AWS campaign control</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          This page starts the autonomous GitHub/SES worker and reads its DynamoDB checkpoints. Closing the app does not interrupt a batch. Every batch requires a separate typed confirmation.
        </p>
      </header>

      <form method="get" className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm font-medium text-slate-700">
          Frozen campaign UUID
          <input name="campaignId" defaultValue={campaignId} required className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm" placeholder="00000000-0000-0000-0000-000000000000" />
        </label>
        <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Load AWS status</button>
      </form>

      {params.notice ? <p className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">{params.notice}</p> : null}
      {error ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</p> : null}

      {status ? (
        <>
          <section className="rounded-xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-900">{status.subject}</h3>
                <p className="mt-1 font-mono text-xs text-slate-500">{status.campaignId}</p>
                <p className="mt-1 break-all font-mono text-xs text-slate-500">Manifest {status.approvalSha256}</p>
              </div>
              <Link href={`/email/aws-native?campaignId=${encodeURIComponent(status.campaignId)}`} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">Refresh now</Link>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <Metric label="Audience" value={status.recipientCount.toLocaleString()} />
              <Metric label="24h quota" value={status.quota.max24Hour.toLocaleString()} />
              <Metric label="Rolling headroom" value={status.quota.remaining.toLocaleString()} />
              <Metric label="SES rate" value={`${status.quota.maxRate}/s`} />
            </div>
          </section>

          <div className="space-y-4">
            {status.batches.map((batch) => {
              const terminal = batch.accepted + batch.dead + batch.canceled;
              const remaining = Math.max(0, batch.recipientCount - terminal);
              const canApprove = batch.releaseState === "READY_FOR_APPROVAL" || batch.releaseState === "APPROVED";
              const confirmation = `send:${status.campaignId}:${status.approvalSha256.slice(0, 12)}:batch:${batch.batchNumber}`;
              return (
                <section key={batch.batchNumber} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-lg font-semibold text-slate-900">Batch {batch.batchNumber} · {batch.recipientCount.toLocaleString()} recipients</h3>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{batch.releaseState}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                    <Metric label="Accepted" value={batch.accepted.toLocaleString()} />
                    <Metric label="Claimed" value={batch.claimed.toLocaleString()} />
                    <Metric label="Retry" value={batch.retry.toLocaleString()} />
                    <Metric label="Dead" value={batch.dead.toLocaleString()} />
                    <Metric label="Canceled" value={batch.canceled.toLocaleString()} />
                    <Metric label="Remaining" value={remaining.toLocaleString()} />
                  </div>
                  <p className="mt-3 text-xs text-slate-500">Operator notice: {batch.operatorNoticeState ?? "not sent"}{batch.operatorNoticeSentAt ? ` at ${new Date(batch.operatorNoticeSentAt).toLocaleString()}` : ""}</p>
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <form action={dispatchNativeDryRunAction} className="rounded-lg border border-slate-200 p-3">
                      <input type="hidden" name="campaignId" value={status.campaignId} />
                      <input type="hidden" name="manifestKey" value={status.manifestKey} />
                      <input type="hidden" name="batchNumber" value={batch.batchNumber} />
                      <p className="text-sm text-slate-600">Read-only validation of manifest, state, unsubscribe secret, SES quota, and required approval token.</p>
                      <button className="mt-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Run batch dry-run</button>
                    </form>
                    <form action={dispatchNativeSendAction} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <input type="hidden" name="campaignId" value={status.campaignId} />
                      <input type="hidden" name="manifestKey" value={status.manifestKey} />
                      <input type="hidden" name="batchNumber" value={batch.batchNumber} />
                      <label className="text-sm font-medium text-amber-900">Type exact approval
                        <input name="confirmation" disabled={!canApprove} className="mt-1 w-full rounded-md border border-amber-300 bg-white px-2 py-2 font-mono text-xs disabled:bg-slate-100" placeholder={confirmation} autoComplete="off" />
                      </label>
                      <button disabled={!canApprove} className="mt-2 rounded-md bg-amber-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300">Approve and send only batch {batch.batchNumber}</button>
                    </form>
                  </div>
                </section>
              );
            })}
          </div>
        </>
      ) : null}

      <p className="text-xs text-slate-500">Audience freezing remains a deliberate operator command because it transfers subscriber PII from Supabase into private S3. This page cannot create a legacy Supabase queue.</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-slate-50 p-2"><p className="font-semibold tabular-nums text-slate-900">{value}</p><p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p></div>;
}
