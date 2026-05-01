"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { getQueueSnapshotAction, triggerQueueAction } from "../actions";

type QueueSnapshot = Awaited<ReturnType<typeof getQueueSnapshotAction>>;

type Props = {
  emailId?: string;
  autoStart?: boolean;
};

const POLL_MS = 31_000;

export function MonitorClient({ emailId, autoStart = false }: Props) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [autoRun, setAutoRun] = useState(autoStart);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const next = await getQueueSnapshotAction(emailId);
    setSnapshot(next);
    return next;
  }, [emailId]);

  const runOnce = useCallback(async () => {
    setError(null);
    const result = await triggerQueueAction(emailId);
    setMessage(
      result.processed === 0
        ? result.message
        : `Processed ${result.processed}: ${result.succeeded} sent${result.failed > 0 ? `, ${result.failed} failed` : ""}.`,
    );
    return refresh();
  }, [emailId, refresh]);

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
    if (!autoRun) return;

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
  }, [autoRun, runOnce]);

  const total = snapshot?.total ?? 0;
  const done = snapshot?.resolved ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const terminalFailures = snapshot?.terminalFailures ?? 0;
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
            disabled={pending}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {pending ? "Working..." : "Run once"}
          </button>
          <button
            type="button"
            onClick={() => setAutoRun((value) => !value)}
            className={`rounded-md px-4 py-2 text-sm font-semibold text-white ${
              autoRun ? "bg-red-700 hover:bg-red-800" : "bg-slate-900 hover:bg-slate-700"
            }`}
          >
            {autoRun ? "Stop auto-run" : "Start auto-run"}
          </button>
        </div>
      </header>

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
          <Metric label="Accepted by SES" value={snapshot?.succeeded ?? 0} tone="green" />
          <Metric label="Pending now" value={snapshot?.pendingDue ?? 0} tone="amber" />
          <Metric label="Held" value={snapshot?.pendingHeld ?? 0} tone="slate" />
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
            Sent today:{" "}
            <span className="font-medium text-slate-900">
              {(snapshot?.sentToday ?? 0).toLocaleString()}
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
        </div>
      </div>
    </div>
  );
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
