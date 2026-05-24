"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteEmailAction,
  editQueuedEmailAction,
  sendQueuedEmailAction,
} from "../actions";
import { buildQueueReleaseConfirmation } from "@/lib/queueReleaseGuard";

// ── Header safety notice: broad queue drains are intentionally unavailable. ──
export function QueueSafetyNotice() {
  return (
    <div className="max-w-sm rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      Process sends from a specific row only. Broad queue draining is disabled to avoid sending an unintended campaign.
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
      if (res.error) throw new Error(res.error);
      router.push(res.href!);
    });
  };

  const handleSendNow = () => {
    const confirmed = confirm(
      `Release queued recipients for "${subject || "this email"}" and start the monitor?`,
    );
    if (!confirmed) return;

    runAction(async () => {
      const fd = new FormData();
      fd.set("id", id);
      fd.set("releaseConfirmation", buildQueueReleaseConfirmation(id));
      const res = await sendQueuedEmailAction(fd);
      if (res.error) throw new Error(res.error);
      setResult({
        ok: true,
        message:
          (res.remainingQueued ?? 0) > 0
            ? `Released ${res.dueNow ?? 0} for today${(res.scheduledFuture ?? 0) > 0 ? `, scheduled ${res.scheduledFuture} future` : ""}; sent ${res.succeeded}, ${res.remainingQueued} still queued.`
            : `Sent ${res.succeeded}${(res.failed ?? 0) > 0 ? `, ${res.failed} failed` : ""}.`,
      });
      router.push(`/email/monitor?emailId=${id}&auto=1`);
    });
  };

  const handleDelete = () => {
    if (!confirm(`Delete "${subject || "this draft"}"?`)) return;
    runAction(async () => {
      const fd = new FormData();
      fd.set("id", id);
      const res = await deleteEmailAction(fd);
      if (res.error) throw new Error(res.error);
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
