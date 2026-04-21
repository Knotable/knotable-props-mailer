"use client";

import { useTransition } from "react";
import { cancelEmailAction, deleteEmailAction } from "../actions";

type Props = {
  id: string;
  subject: string;
  isQueued: boolean;
};

export function ScheduleActions({ id, subject, isQueued }: Props) {
  const [canceling, startCancel] = useTransition();
  const [deleting, startDelete] = useTransition();

  const handleCancel = () => {
    const fd = new FormData();
    fd.set("id", id);
    startCancel(() => cancelEmailAction(fd));
  };

  const handleDelete = () => {
    if (!confirm(`Delete "${subject || "this draft"}"?`)) return;
    const fd = new FormData();
    fd.set("id", id);
    startDelete(() => deleteEmailAction(fd));
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
