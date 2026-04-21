"use client";

import { useTransition, useState } from "react";
import { cancelEmailAction, deleteEmailAction, triggerQueueAction } from "../actions";

// ── Per-row cancel / delete ───────────────────────────────────────────────────

type RowProps = { id: string; subject: string; isQueued: boolean };

export function ScheduleActions({ id, subject, isQueued }: RowProps) {
  const [canceling, startCancel] = useTransition();
  const [deleting, startDelete] = useTransition();

  const handleCancel = () => {
    const fd = new FormData();
    fd.set("id", id);
    startCancel(async () => { await cancelEmailAction(fd); });
  };

  const handleDelete = () => {
    if (!confirm(`Delete "${subject || "this draft"}"?`)) return;
    const fd = new FormData();
    fd.set("id", id);
    startDelete(async () => { await deleteEmailAction(fd); });
  };

  return (
    <div className="flex shrink-0 gap-2">
      {isQueued && (
        <button
          onClick={handleCancel}
          disabled={canceling}
          className="rounded-md border border-orange-200 px-3 py-1 text-xs font-medium text-orange-600 hover:bg-orange-50 disabled:opacity-50"
        >
          {canceling ? "Canceling…" : "Cancel"}
        </button>
      )}
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
}

// ── Page-level queue trigger ──────────────────────────────────────────────────

export function TriggerQueueButton() {
  const [pending, startTrigger] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleTrigger = () => {
    setResult(null);
    startTrigger(async () => {
      try {
        const data = await triggerQueueAction();
        setResult({
          ok: true,
          message:
            data.processed === 0
              ? "No pending items in the queue."
              : `Processed ${data.processed}: ${data.succeeded} sent, ${data.failed} failed.`,
        });
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : "Trigger failed.",
        });
      }
    });
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleTrigger}
        disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {pending ? "Running…" : "Trigger Queue Now"}
      </button>
      {result && (
        <span
          className={`text-sm ${result.ok ? "text-green-700" : "text-red-700"}`}
        >
          {result.message}
        </span>
      )}
    </div>
  );
}
