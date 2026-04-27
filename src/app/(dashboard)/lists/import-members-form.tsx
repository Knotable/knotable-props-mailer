"use client";

import { useRef, useState, useTransition } from "react";
import { importMembersAction } from "./actions";

type ImportResult = Awaited<ReturnType<typeof importMembersAction>>;

export function ImportMembersForm({ listId }: { listId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!formRef.current) return;

    const formData = new FormData(formRef.current);
    setResult(null);
    setError(null);

    startTransition(async () => {
      try {
        const next = await importMembersAction(formData);
        setResult(next);
        formRef.current?.reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed.");
      }
    });
  };

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="space-y-2 rounded-lg border border-dashed border-slate-300 p-3"
    >
      <input type="hidden" name="listId" value={listId} />
      <label className="text-sm font-medium text-slate-700">
        Paste members (CSV or newline)
        <textarea
          name="members"
          rows={3}
          required
          placeholder="address@example.com"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-slate-200 px-3 py-1 text-xs disabled:opacity-50"
        >
          {pending ? "Importing..." : "Import / Upsert"}
        </button>
        {result && (
          <span className="text-xs text-green-700">
            Upserted {result.upserted.toLocaleString()}
            {result.skippedInvalid > 0 || result.skippedDuplicate > 0
              ? `; skipped ${result.skippedInvalid + result.skippedDuplicate} (${result.skippedInvalid} invalid, ${result.skippedDuplicate} duplicate)`
              : ""}
          </span>
        )}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </form>
  );
}
