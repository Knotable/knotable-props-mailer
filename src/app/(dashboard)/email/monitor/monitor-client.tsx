"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

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
  emailId: string | null;
  subject: string | null;
  emailStatus: string | null;
  displayStatus: string;
  statusDetail: string;
  date: string;
  dailyCap: number;
  sentToday: number;
  sentLast7Days: number;
  sentAllTime: number | null;
  remainingToday: number;
  total: number;
  resolved: number;
  terminalFailures: number;
  isDrained: boolean;
  pending: number;
  pendingDue: number;
  pendingHeld: number;
  processing: number;
  succeeded: number;
  failed: number;
  dead: number;
  canceled: number;
  recipientLog?: RecipientLogRow[];
};

type WorkerResult = {
  processed?: number;
  succeeded?: number;
  failed?: number;
  message?: string;
};

type Props = {
  emailId?: string;
  autoStart?: boolean;
  monitorSecret: string;
};

const POLL_MS = 31_000;
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

export function MonitorClient({ emailId, autoStart = false, monitorSecret }: Props) {
  const scopedEmailId = emailId && UUID_RE.test(emailId) ? emailId : undefined;
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [autoRun, setAutoRun] = useState(autoStart && Boolean(scopedEmailId && monitorSecret));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runState, setRunState] = useState<"idle" | "running">("idle");
  const [lastRequestAt, setLastRequestAt] = useState<string | null>(null);
  const [lastResponseAt, setLastResponseAt] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [recipientLog, setRecipientLog] = useState<RecipientLogRow[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authHeaders = useCallback(() => {
    if (!monitorSecret) throw new Error("Monitor secret is missing. Set CRON_SECRET in Vercel.");
    return { Authorization: `Bearer ${monitorSecret}` };
  }, [monitorSecret]);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (scopedEmailId) params.set("emailId", scopedEmailId);

    const response = await fetch(`/api/email/send-monitor?${params.toString()}`, {
      method: "GET",
      headers: authHeaders(),
      cache: "no-store",
    });
    const next = await readJson<QueueSnapshot>(response);
    setRecipientLog(scopedEmailId ? next.recipientLog ?? [] : []);
    setSnapshot(next);
    return next;
  }, [authHeaders, scopedEmailId]);

  const runOnce = useCallback(async () => {
    if (!scopedEmailId) throw new Error("Worker controls require a specific emailId.");
    setError(null);
    setRunState("running");
    setLastRequestAt(new Date().toISOString());

    try {
      const response = await fetch("/api/email/send-monitor", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ emailId: scopedEmailId }),
      });
      const result = await readJson<WorkerResult>(response);
      setLastResponseAt(new Date().toISOString());
      setMessage(
        (result.processed ?? 0) === 0
          ? result.message ?? "Queue checked; no rows were processed."
          : `Processed ${result.processed ?? 0}: ${result.succeeded ?? 0} sent${
              (result.failed ?? 0) > 0 ? `, ${result.failed} failed` : ""
            }.`,
      );
      return refresh();
    } finally {
      setRunState("idle");
    }
  }, [authHeaders, scopedEmailId, refresh]);

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
    if (!autoRun || !scopedEmailId) return;

    const tick = () => {
      startTransition(async () => {
        try {
          const next = await runOnce();
          if (next.pending === 0 && next.processing === 0) {
            setAutoRun(false);
            return;
          }
        } catch (err) {
          setAutoRun(false);
          setError(err instanceof Error ? err.message : "Queue worker failed.");
          return;
        }
        timerRef.current = setTimeout(tick, POLL_MS);
      });
    };

    timerRef.current = setTimeout(tick, 500);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [autoRun, scopedEmailId, runOnce]);

  const total = snapshot?.total ?? 0;
  const done = snapshot?.resolved ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const terminalFailures = snapshot?.terminalFailures ?? 0;
  const isCampaignScoped = Boolean(snapshot?.emailId);
  const isWorking = pending || runState === "running";
  const canRunWorker = Boolean(scopedEmailId && monitorSecret);
  const terminalFailuresText = terminalFailures.toLocaleString();
  const statusTone =
    snapshot?.isDrained && terminalFailures === 0
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
            Keep this page open while a large send is draining.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              startTransition(async () => {
                try {
                  await runOnce();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Queue worker failed.");
                }
              })
            }
            disabled={isWorking || !canRunWorker}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isWorking ? "Working..." : "Run once"}
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMessage(null);
              setAutoRun((value) => !value);
            }}
            disabled={!canRunWorker}
            className={`rounded-md px-4 py-2 text-sm font-semibold text-white ${
              autoRun ? "bg-red-700 hover:bg-red-800" : "bg-slate-900 hover:bg-slate-700"
            } disabled:opacity-50`}
          >
            {autoRun ? "Stop auto-run" : "Start auto-run"}
          </button>
        </div>
      </header>

      {!monitorSecret && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Monitor secret is missing. Set CRON_SECRET before starting the worker.
        </div>
      )}
      {!scopedEmailId && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This is a read-only global queue snapshot. Worker controls require a specific emailId in the URL.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {message}
        </div>
      )}

      <div className={`rounded-lg border px-4 py-3 ${statusTone}`}>
        <p className="text-sm font-semibold">{snapshot?.displayStatus ?? "Loading queue status"}</p>
        {snapshot?.statusDetail && <p className="mt-1 text-sm">{snapshot.statusDetail}</p>}
      </div>

      <div className="space-y-3">
        <div className="h-3 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-green-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric
            label={isCampaignScoped ? "Campaign accepted" : "Sent last 7 days"}
            value={isCampaignScoped ? snapshot?.succeeded ?? 0 : snapshot?.sentLast7Days ?? 0}
            tone="green"
          />
          <Metric label="Pending now" value={snapshot?.pendingDue ?? 0} tone="amber" />
          <Metric label="Held" value={snapshot?.pendingHeld ?? 0} tone="slate" />
          {isCampaignScoped && (
            <Metric label="Accepted last 7 days" value={snapshot?.sentLast7Days ?? 0} tone="green" />
          )}
          <Metric label="Processing" value={snapshot?.processing ?? 0} tone="blue" />
          <Metric label="Failed rows" value={snapshot?.failed ?? 0} tone="red" />
          <Metric label="Permanent failures" value={snapshot?.dead ?? 0} tone="red" />
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
            Global sent today:{" "}
            <span className="font-medium text-slate-900">
              {(snapshot?.sentToday ?? 0).toLocaleString()}
            </span>
          </p>
          <p>
            {isCampaignScoped ? "Campaign accepted all time" : "Accepted all time"}:{" "}
            <span className="font-medium text-slate-900">
              {snapshot?.sentAllTime == null ? "Open a campaign monitor" : snapshot.sentAllTime.toLocaleString()}
            </span>
          </p>
          <p>
            Quota left today:{" "}
            <span className="font-medium text-slate-900">
              {(snapshot?.remainingToday ?? 0).toLocaleString()}
            </span>
          </p>
          <p>
            Email record:{" "}
            <span className="font-medium text-slate-900">{snapshot?.emailStatus ?? "all queue"}</span>
          </p>
          <p>
            Auto-run:{" "}
            <span className="font-medium text-slate-900">
              {autoRun ? (isWorking ? "active, request in flight" : "active") : "off"}
            </span>
          </p>
          <p>
            Last request:{" "}
            <span className="font-medium text-slate-900">{formatTimestamp(lastRequestAt)}</span>
          </p>
          <p>
            Last response:{" "}
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
            <p className="text-xs text-slate-500">Showing up to 250 rows for audit visibility.</p>
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

function formatTimestamp(value: string | null) {
  return value ? value.replace("T", " ").slice(0, 19) : "never";
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
