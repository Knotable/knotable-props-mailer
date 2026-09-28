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

export function QueueSafetyNotice() {
  return (
    <div className="max-w-sm rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
      <span className="font-semibold">Sends run in the cloud.</span> Press Send, confirm the recipient count, and close the
      tab — autopilot paces SES, waits out quota windows, and emails you when it finishes.
    </div>
  );
}

type RowProps = {
  id: string;
  subject: string;
  status: "draft" | "queued" | "sending";
  canSend: boolean;
  unsent: number;
  autopilotActive: boolean;
  preparing?: boolean;
  estimate?: string | null;
};

export function ScheduleActions({ id, subject, status, canSend, unsent, autopilotActive, preparing = false, estimate = null }: RowProps) {
  const router = useRouter();
  const [working, startWorking] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [sendConfirmationArmed, setSendConfirmationArmed] = useState(false);
  const [sendAtLocal, setSendAtLocal] = useState("");
  const [businessHours, setBusinessHours] = useState(false);
  const localTimeZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const sendWindow = businessHours ? `07:00-21:00 ${localTimeZone}` : "";
  const sendAtIso = (() => {
    if (!sendAtLocal) return "";
    const date = new Date(sendAtLocal);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  })();

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
    if (status === "sending" && !confirm("Editing stops this send and cancels its unsent recipients. Continue?")) return;
    runAction("Unlocking the queued email so it can be edited...", async () => {
      const fd = new FormData();
      fd.set("id", id);
      const res = await editQueuedEmailAction(fd);
      if (res.error) throw new Error(res.error);
      setProgress("Draft reopened. Loading the composer...");
      router.push(res.href!);
    });
  };

  const handleSendSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!sendConfirmationArmed) {
      event.preventDefault();
      setSendConfirmationArmed(true);
      return;
    }
    setResult(null);
    setProgress("Approving this exact recipient count for the cloud sender...");
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
            ? `Paused. ${res.paused.toLocaleString()} unsent recipients kept; ${res.processing.toLocaleString()} in-flight will finish.`
            : `Paused with ${res.paused.toLocaleString()} unsent recipients kept.`,
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
  // "sending" without an active approval is a legacy/stalled state: nothing is
  // draining it, so offer Send to hand it to autopilot.
  const canStart = canSend && unsent > 0 && !preparing && (status === "queued" || (status === "sending" && !autopilotActive));

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
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
            {canSend && (status === "sending" || preparing) && (
              <button
                type="button"
                onClick={handlePause}
                disabled={working}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                {working ? "Working..." : "Pause"}
              </button>
            )}
            {canStart && (
              <form action={sendQueuedEmailAndRedirectAction} onSubmit={handleSendSubmit} className="contents">
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="releaseConfirmation" value={buildQueueReleaseConfirmation(id)} />
                <input type="hidden" name="expectedRecipients" value={String(unsent)} />
                <input type="hidden" name="sendAt" value={sendAtIso} />
                <input type="hidden" name="sendWindow" value={sendWindow} />
                <SendButton disabled={working} armed={sendConfirmationArmed} unsent={unsent} scheduled={Boolean(sendAtIso)} />
                {sendConfirmationArmed && (
                  <button
                    type="button"
                    onClick={() => {
                      setSendConfirmationArmed(false);
                      setSendAtLocal("");
                    }}
                    className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                )}
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
      {sendConfirmationArmed && canStart && (
        <div className="w-full min-w-64 space-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          {estimate && <p>Estimated send time: <span className="font-semibold">{estimate}</span></p>}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={businessHours} onChange={(event) => setBusinessHours(event.target.checked)} />
            Only send 7am–9pm {localTimeZone.replace(/_/g, " ")} time (multi-day sends pause overnight)
          </label>
          <label className="flex flex-wrap items-center gap-2">
            Send later (optional, your local time):
            <input
              type="datetime-local"
              value={sendAtLocal}
              onChange={(event) => setSendAtLocal(event.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs"
            />
          </label>
        </div>
      )}
      {progress && (
        <div className="w-full min-w-64">
          <ProgressStatus title={progress} detail="Waiting for the server action to finish." tone="slate" />
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

function SendButton({ disabled, armed, unsent, scheduled }: { disabled: boolean; armed: boolean; unsent: number; scheduled: boolean }) {
  const { pending } = useFormStatus();
  const isDisabled = disabled || pending;
  const count = unsent.toLocaleString();

  return (
    <button
      type="submit"
      disabled={isDisabled}
      aria-label={armed ? `Confirm ${scheduled ? "scheduled " : ""}send to ${count} recipients` : `Send to ${count} recipients`}
      className={`rounded-md px-3 py-1 text-xs font-semibold text-white disabled:opacity-50 ${
        armed ? "bg-red-600 hover:bg-red-700" : "bg-slate-900 hover:bg-slate-700"
      }`}
    >
      {isDisabled ? "Approving..." : armed ? (scheduled ? `Yes, schedule ${count}` : `Yes, send to ${count}`) : `Send to ${count}`}
    </button>
  );
}
