"use client";

import { useActionState } from "react";
import { FormStatusButton } from "@/components/form-status-button";
import { approveSendRequestAction, rejectSendRequestAction, type ApprovalState } from "./actions";

export function ApproveForm({ token, expectedRecipients }: { token: string; expectedRecipients: number }) {
  const [state, approve] = useActionState<ApprovalState, FormData>(approveSendRequestAction, {});

  return (
    <div className="space-y-3 rounded-lg border border-slate-300 p-4">
      <form action={approve} className="space-y-3">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="expectedRecipients" value={expectedRecipients} />
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Your Props password</span>
          <span className="block text-xs text-slate-500">
            Required to approve. AI assistants are never allowed to enter it, so this step is always yours.
          </span>
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-base"
          />
        </label>
        {state.error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</div>
        )}
        <FormStatusButton
          type="submit"
          pendingLabel="Approving…"
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 py-3 text-base font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 sm:w-auto"
        >
          Approve &amp; send to {expectedRecipients.toLocaleString("en-US")}
        </FormStatusButton>
      </form>
      <form action={rejectSendRequestAction}>
        <input type="hidden" name="token" value={token} />
        <FormStatusButton
          type="submit"
          pendingLabel="Rejecting…"
          className="inline-flex items-center gap-2 text-sm text-red-700 underline"
        >
          Reject this request
        </FormStatusButton>
      </form>
    </div>
  );
}
