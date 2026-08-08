"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import {
  deleteEmailAction,
  editQueuedEmailAction,
  pauseQueuedEmailAction,
  sendQueuedEmailAndRedirectAction,
} from "../actions";
import { buildQueueReleaseConfirmation } from "@/lib/queueReleaseGuard";
import { ProgressStatus } from "@/components/progress-status";

// ── Header safety notice: this page still releases specific rows only. ──
export function QueueSafetyNotice() {
  return (
    <div className="max-w-sm rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      Process sends from a specific row here. The monitor page has a guarded global drain for queued, sending, or sent campaigns.
    </div>
  );
}

type RowProps = {
  id: string;
  subject: string;
  status: "draft" | "queued" | "sending";
  canSend: boolean;
};

export function ScheduleActions({ id, subject, status, canSend }: RowProps) {
  const router = useRouter();
  const [working, startWorking] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [sendConfirmationArmed, setSendConfirmationArmed] = useState(false);

  const runAction = (initialProgress: string, task: () => Promise<void>) => {
    setResult(null);
    setProgress(initialProgress);
    startWorking(async () => {
      try {
        await task();
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : "Action failed.",
        });
      } finally {
        setProgress(null);
      }
    });
  };

  const handleEdit = () => {
    runAction("Unlocking the queued email so it can be edited...", async () => {
      const fd = new FormData();
      fd.set("id", id);
      const res = await editQueuedEmailAction(fd);
      if (res.error) throw new Error(res.error);
      setProgress("Draft reopened. Loading the composer...");
      router.push(res.href!);
    });
  };

  const handleSendNowSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!sendConfirmationArmed) {
      event.preventDefault();
      setSendConfirmationArmed(true);
      return;
    }

    setResult(null);
    setProgress(
      status === "queued"
        ? "Resuming the background sender and opening the scoped monitor..."
        : "Releasing due recipients and opening the scoped monitor...",
    );
  };

  const handlePause = () => {
    runAction("Pausing this campaign and preserving its unsent queue...", async () => {
      const fd = new FormData();
      fd.set("id", id);
      const res = await pauseQueuedEmailAction(fd);
      if (res.error) throw new Error(res.error);
      setResult({
        ok: true,
        message:
          res.processing > 0
            ? `Paused ${res.paused.toLocaleString()} pending recipients. ${res.processing.toLocaleString()} in-flight recipient(s) may finish.`
            : `Paused with ${res.paused.toLocaleString()} pending recipients preserved.`,
      });
      router.refresh();
    });
  };

  const handleDelete = () => {
    if (!confirm(`Delete "${subject || "this draft"}"?`)) return;
    runAction("Deleting this draft and refreshing the queue list...", async () => {
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
              type="button"
              onClick={handleEdit}
              disabled={working}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {working ? "Working..." : "Edit"}
            </button>
            {canSend && status === "sending" && (
              <button
                type="button"
                onClick={handlePause}
                disabled={working}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                {working ? "Working..." : "Pause"}
              </button>
            )}
            {canSend && status === "queued" && (
              <form
                action={sendQueuedEmailAndRedirectAction}
                onSubmit={handleSendNowSubmit}
                className="contents"
              >
                <input type="hidden" name="id" value={id} />
                <input
                  type="hidden"
                  name="releaseConfirmation"
                  value={buildQueueReleaseConfirmation(id)}
                />
                <SendNowButton
                  disabled={working}
                  confirmationArmed={sendConfirmationArmed}
                  resume
                />
              </form>
            )}
          </>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={working}
          className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {working ? "Working..." : "Delete"}
        </button>
      </div>
      {progress && (
        <div className="w-full min-w-64">
          <ProgressStatus
            title={progress}
            detail="Waiting for the server action to finish."
            tone="slate"
          />
        </div>
      )}
      {result && (
        <span className={`text-xs ${result.ok ? "text-green-700" : "text-red-700"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}

function SendNowButton({
  disabled,
  confirmationArmed,
  resume,
}: {
  disabled: boolean;
  confirmationArmed: boolean;
  resume: boolean;
}) {
  const { pending } = useFormStatus();
  const isDisabled = disabled || pending;

  return (
    <button
      type="submit"
      disabled={isDisabled}
      aria-label={confirmationArmed ? "Confirm resume" : "Resume"}
      className={`rounded-md px-3 py-1 text-xs font-semibold text-white disabled:opacity-50 ${
        confirmationArmed
          ? "bg-red-600 hover:bg-red-700"
          : "bg-slate-900 hover:bg-slate-700"
      }`}
    >
      {isDisabled ? "Working..." : confirmationArmed ? "Sure?" : resume ? "Resume" : "Send Now"}
    </button>
  );
}
