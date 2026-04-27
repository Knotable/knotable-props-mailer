"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteEmailAction,
  editQueuedEmailAction,
  sendQueuedEmailAction,
  triggerQueueAction,
} from "../actions";

// ── Process-all button shown in the page header ──────────────────────────────
export function ProcessQueueButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleProcess = () => {
    setResult(null);
    startTransition(async () => {
      try {
        const res = await triggerQueueAction();
        setResult({
          ok: true,
          message:
            res.processed === 0
              ? "Queue is empty — nothing to process."
              : `Processed ${res.processed}: ${res.succeeded} sent${res.failed > 0 ? `, ${res.failed} failed` : ""}.`,
        });
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : "Queue processing failed.",
        });
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleProcess}
        disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {pending ? "Processing…" : "⚡ Process Queue Now"}
      </button>
      {result && (
        <span className={`text-xs ${result.ok ? "text-green-700" : "text-red-700"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}

type RowProps = {
  id: string;
  subject: string;
  status: "draft" | "queued" | "sending";
};

export function ScheduleActions({ id, subject, status }: RowProps) {
  const router = useRouter();
  const [working, startWorking] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const runAction = (task: () => Promise<void>) => {
    setResult(null);
    startWorking(async () => {
      try {
        await task();
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : "Action failed.",
        });
      }
    });
  };

  const handleEdit = () => {
    runAction(async () => {
      const fd = new FormData();
      fd.set("id", id);
      const res = await editQueuedEmailAction(fd);
      router.push(res.href);
    });
  };

  const handleSendNow = () => {
    runAction(async () => {
      const fd = new FormData();
      fd.set("id", id);
      const res = await sendQueuedEmailAction(fd);
      setResult({
        ok: true,
        message:
          res.remainingQueued > 0
            ? `Sent ${res.succeeded}, ${res.remainingQueued} still queued.`
            : `Sent ${res.succeeded}${res.failed > 0 ? `, ${res.failed} failed` : ""}.`,
      });
    });
  };

  const handleDelete = () => {
    if (!confirm(`Delete "${subject || "this draft"}"?`)) return;
    runAction(async () => {
      const fd = new FormData();
      fd.set("id", id);
      await deleteEmailAction(fd);
    });
  };

  const isQueued = status === "queued" || status === "sending";

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex shrink-0 gap-2">
        {isQueued && (
          <>
            <button
              onClick={handleEdit}
              disabled={working}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {working ? "Working..." : "Edit"}
            </button>
            <button
              onClick={handleSendNow}
              disabled={working}
              className="rounded-md bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {working ? "Working..." : "Send Now"}
            </button>
          </>
        )}
        <button
          onClick={handleDelete}
          disabled={working}
          className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {working ? "Working..." : "Delete"}
        </button>
      </div>
      {result && (
        <span className={`text-xs ${result.ok ? "text-green-700" : "text-red-700"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}
