"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ProgressStatus } from "@/components/progress-status";
import { DataFreshness } from "@/components/data-freshness";
import type { AutopilotRecord, AutopilotView } from "@/lib/sendAutopilot";

type RecipientLogRow = {
  recipientEmail: string | null;
  status: string | null;
  attemptCount: number | null;
  maxAttempts: number | null;
  availableAt: string | null;
  updatedAt: string | null;
  lastError: string | null;
};

type QueueSnapshot = {
  ok: true;
  generatedAt: string;
  emailId: string | null;
  subject: string | null;
  emailStatus: string | null;
  displayStatus: string;
  statusDetail: string;
  date: string;
  dailyCap: number;
  sentToday: number;
  acceptedTodayUtc?: number;
  rolling24hSent?: number;
  sentLast7Days: number;
  sentAllTime: number | null;
  remainingToday: number;
  remainingRolling24h?: number;
  quotaWindowHours?: number;
  sesMaxSendRatePerSecond?: number;
  effectiveSendRatePerSecond?: number;
  total: number;
  resolved: number;
  terminalFailures: number;
  isDrained: boolean;
  pending: number;
  pendingDue: number;
  pendingHeld: number;
  processing: number;
  oldestProcessingLockedAt?: string | null;
  stalledProcessing?: boolean;
  succeeded: number;
  failed: number;
  dead: number;
  canceled: number;
  recipientLog?: RecipientLogRow[];
  autopilot?: AutopilotRecord | null;
  autopilotView?: AutopilotView | null;
  autopilotQueue?: {
    emailId: string;
    subject: string | null;
    state: string;
    view: AutopilotView | null;
    progress: AutopilotRecord["progress"] | null;
  }[];
};

type Props = {
  emailId?: string;
  notice?: string;
};

const POLL_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    throw new Error(formatError(body.error, `Request failed with ${response.status}`));
  }
  return body as T;
}

function formatError(error: unknown, fallback: string) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error == null) return fallback;
  if (typeof error === "object" && "message" in error) {
    const message = String(error.message ?? "").trim();
    if (message) return message;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : fallback;
  } catch {
    return fallback;
  }
}

export function MonitorClient({ emailId, notice }: Props) {
  const scopedEmailId = emailId && UUID_RE.test(emailId) ? emailId : undefined;
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResponseAt, setLastResponseAt] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState("Loading queue status from Supabase...");
  const [pending, startTransition] = useTransition();
  const [recipientLog, setRecipientLog] = useState<RecipientLogRow[]>([]);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (scopedEmailId) params.set("emailId", scopedEmailId);
    params.set("refresh", Date.now().toString());
    setProgressMessage(
      scopedEmailId
        ? "Refreshing this campaign's queue snapshot..."
        : "Refreshing the global queue snapshot...",
    );

    const response = await fetch(`/api/email/send-monitor?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
    });
    const next = await readJson<QueueSnapshot>(response);
    setRecipientLog(scopedEmailId ? next.recipientLog ?? [] : []);
    setSnapshot(next);
    setLastResponseAt(next.generatedAt);
    setProgressMessage("Queue snapshot loaded.");
    return next;
  }, [scopedEmailId]);

  useEffect(() => {
    startTransition(async () => {
      try {
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load queue status.");
      }
    });
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      startTransition(async () => {
        try {
          await refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Unable to refresh queue status.");
        }
      });
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const total = snapshot?.total ?? 0;
  const done = snapshot?.resolved ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const terminalFailures = snapshot?.terminalFailures ?? 0;
  const isCampaignScoped = Boolean(snapshot?.emailId);
  const isWorking = pending;
  const terminalFailuresText = terminalFailures.toLocaleString();
  const statusTone =
    snapshot?.stalledProcessing
      ? "border-red-200 bg-red-50 text-red-800"
      : snapshot?.isDrained && terminalFailures === 0
      ? "border-green-200 bg-green-50 text-green-800"
      : snapshot?.isDrained
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-blue-200 bg-blue-50 text-blue-800";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Queue Monitor</p>
          <h2 className="text-2xl font-semibold text-slate-900">
            {snapshot?.subject ?? "Outbound Queue"}
          </h2>
          <p className="text-sm text-slate-500">
            Sending runs in the cloud. This page only watches — close it any time.
          </p>
        </div>
      </header>

      {notice && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{notice}</div>
      )}

      {snapshot?.autopilot && snapshot.autopilotView && (
        <AutopilotPanel record={snapshot.autopilot} view={snapshot.autopilotView} />
      )}

      {!scopedEmailId && (snapshot?.autopilotQueue?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-slate-200">
          <p className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Autopilot queue (sent one at a time, oldest approval first)</p>
          <ul className="divide-y divide-slate-100">
            {snapshot?.autopilotQueue?.map((item) => (
              <li key={item.emailId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <a href={`/email/monitor?emailId=${item.emailId}`} className="font-medium text-blue-700 hover:underline">
                  {item.subject ?? item.emailId}
                </a>
                <span className="text-slate-600">
                  {item.view?.label ?? item.state}
                  {item.progress?.etaSeconds ? ` · ~${formatEta(item.progress.etaSeconds)} left` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!scopedEmailId && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Account-wide view. Open a campaign for its live progress.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {(isWorking || !snapshot) && (
        <ProgressStatus
          title={progressMessage}
          detail={
            "Waiting for the remote status request to complete."
          }
        />
      )}

      <div className={`rounded-lg border px-4 py-3 ${statusTone}`}>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{snapshot?.displayStatus ?? "Loading queue status"}</p>
          <DataFreshness timestamp={snapshot?.generatedAt} loading={isWorking} />
        </div>
        {snapshot?.statusDetail && <p className="mt-1 text-sm">{snapshot.statusDetail}</p>}
      </div>

      <div className="space-y-3">
        <div className="h-3 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-green-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <Metric
            label={isCampaignScoped ? "Accepted by SES" : "Sent last 7 days"}
            value={isCampaignScoped ? snapshot?.succeeded ?? 0 : snapshot?.sentLast7Days ?? 0}
            tone="green"
          />
          <Metric label="Unsent" value={snapshot?.pending ?? 0} tone="amber" />
          <Metric label="In flight" value={snapshot?.processing ?? 0} tone="blue" />
          <Metric label="Permanent failures" value={(snapshot?.dead ?? 0) + (snapshot?.failed ?? 0)} tone="red" />
          {(snapshot?.canceled ?? 0) > 0 && <Metric label="Canceled" value={snapshot?.canceled ?? 0} tone="slate" />}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 p-4 text-sm text-slate-600">
        <div className="grid gap-2 sm:grid-cols-2">
          <p>
            Queue status:{" "}
            <span className="font-medium text-slate-900">{snapshot?.displayStatus ?? "all queue"}</span>
          </p>
          <p>
            Resolved:{" "}
            <span className="font-medium text-slate-900">
              {done.toLocaleString()} / {total.toLocaleString()} ({pct}%)
            </span>
          </p>
          <p>
            SES accepted rolling {snapshot?.quotaWindowHours ?? 24}h:{" "}
            <span className="font-medium text-slate-900">
              {(snapshot?.rolling24hSent ?? snapshot?.sentToday ?? 0).toLocaleString()}
            </span>
          </p>
          <p>
            {isCampaignScoped ? "Campaign accepted all time" : "Accepted all time"}:{" "}
            <span className="font-medium text-slate-900">
              {snapshot?.sentAllTime == null ? "Open a campaign monitor" : snapshot.sentAllTime.toLocaleString()}
            </span>
          </p>
          <p>
            SES quota left rolling {snapshot?.quotaWindowHours ?? 24}h:{" "}
            <span className="font-medium text-slate-900">
              {(snapshot?.remainingRolling24h ?? snapshot?.remainingToday ?? 0).toLocaleString()}
            </span>
          </p>
          <p>
            SES max send rate:{" "}
            <span className="font-medium text-slate-900">
              {formatRate(snapshot?.sesMaxSendRatePerSecond)} / sec
            </span>
          </p>
          <p>
            Worker target rate:{" "}
            <span className="font-medium text-slate-900">
              {formatRate(snapshot?.effectiveSendRatePerSecond)} / sec
            </span>
          </p>
          <p>
            Account accepted last 7 days:{" "}
            <span className="font-medium text-slate-900">{(snapshot?.sentLast7Days ?? 0).toLocaleString()}</span>
          </p>
          <p>
            Accepted today UTC:{" "}
            <span className="font-medium text-slate-900">
              {(snapshot?.acceptedTodayUtc ?? snapshot?.sentToday ?? 0).toLocaleString()}
            </span>
          </p>
          <p>
            Email record:{" "}
            <span className="font-medium text-slate-900">{snapshot?.emailStatus ?? "all queue"}</span>
          </p>
          <p>
            Last status refresh:{" "}
            <span className="font-medium text-slate-900">{formatTimestamp(lastResponseAt)}</span>
          </p>
          {terminalFailures > 0 && (
            <p className="sm:col-span-2">
              Permanent failures:{" "}
              <span className="font-medium text-red-700">{terminalFailuresText}</span>
            </p>
          )}
        </div>
      </div>

      {isCampaignScoped && (
        <div className="rounded-lg border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Recipient send log (latest first)</p>
            <p className="text-xs text-slate-500">Latest 50 status changes.</p>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Recipient</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Attempts</th>
                  <th className="px-4 py-2">Updated (UTC)</th>
                  <th className="px-4 py-2">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recipientLog.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-4 text-slate-500">
                      No recipient logs yet.
                    </td>
                  </tr>
                ) : (
                  recipientLog.map((row, index) => (
                    <tr key={`${row.recipientEmail ?? "unknown"}-${row.updatedAt ?? index}`}>
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">{row.recipientEmail}</td>
                      <td className="px-4 py-2 text-slate-700">{row.status}</td>
                      <td className="px-4 py-2 text-slate-700">
                        {row.attemptCount}/{row.maxAttempts}
                      </td>
                      <td className="px-4 py-2 text-slate-700">{row.updatedAt?.replace("T", " ").slice(0, 19)}</td>
                      <td className="px-4 py-2 text-xs text-red-700">{row.lastError ?? "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function formatEta(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${total}s`;
}

function secondsAgo(value: string | null | undefined) {
  const at = Date.parse(value ?? "");
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

function AutopilotPanel({ record, view }: { record: AutopilotRecord; view: AutopilotView }) {
  const tones: Record<AutopilotView["tone"], string> = {
    green: "border-green-200 bg-green-50 text-green-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    red: "border-red-200 bg-red-50 text-red-900",
    slate: "border-slate-200 bg-slate-50 text-slate-800",
  };
  const terminal = ["complete", "canceled", "paused", "blocked"].includes(record.state);
  const progress = terminal ? undefined : record.progress;
  const quota = terminal ? undefined : record.quota;
  const heartbeat = terminal ? null : secondsAgo(record.heartbeatAt);
  return (
    <div className={`space-y-2 rounded-lg border px-4 py-3 text-sm ${tones[view.tone]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">Cloud autopilot: {view.label}</p>
        {view.live && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" aria-label="worker live" />}
        {heartbeat && <span className="text-xs opacity-75">worker heartbeat {heartbeat}</span>}
        {record.run?.url && (
          <a href={record.run.url} target="_blank" rel="noreferrer" className="text-xs underline">
            worker run
          </a>
        )}
      </div>
      {view.detail && <p>{view.detail}</p>}
      <div className="grid gap-1 text-xs sm:grid-cols-2">
        <p>
          Approved {record.approvedRecipients?.toLocaleString() ?? "?"} recipients
          {record.approvedBy ? ` by ${record.approvedBy}` : ""} · {record.approvedAt?.replace("T", " ").slice(0, 16)} UTC
        </p>
        {progress && (
          <p>
            This run: {progress.acceptedThisRun?.toLocaleString() ?? 0} accepted at {progress.ratePerSecond ?? 0}/s
            {progress.etaSeconds ? ` · ~${formatEta(progress.etaSeconds)} left` : ""}
            {progress.backoffMs ? ` · easing off database ${Math.round(progress.backoffMs / 1000)}s` : ""}
          </p>
        )}
        {quota?.max24HourSend ? (
          <p>
            SES rolling 24h: {quota.sentLast24Hours?.toLocaleString()} / {quota.max24HourSend.toLocaleString()} used
            {typeof quota.available === "number" ? ` · ${quota.available.toLocaleString()} available` : ""}
          </p>
        ) : null}
        {!terminal && record.nextCheckAt && <p>Next automatic check: {record.nextCheckAt.replace("T", " ").slice(0, 16)} UTC</p>}
        {record.state === "complete" && record.completedAt && <p>Finished {record.completedAt.replace("T", " ").slice(0, 16)} UTC</p>}
        {record.state === "blocked" && <p>Fix the reason above, then press Send on the Queue page to re-approve.</p>}
      </div>
    </div>
  );
}

function formatTimestamp(value: string | null) {
  return value ? value.replace("T", " ").slice(0, 19) : "never";
}

function formatRate(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "unknown";
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "amber" | "slate" | "blue" | "red";
}) {
  const colors = {
    green: "text-green-700",
    amber: "text-amber-700",
    slate: "text-slate-700",
    blue: "text-blue-700",
    red: "text-red-700",
  };

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${colors[tone]}`}>{value.toLocaleString()}</p>
    </div>
  );
}
