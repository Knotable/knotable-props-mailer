"use client";

import { useState, useRef } from "react";
import { saveDraftAction, sendTestAction, queueCampaignAction } from "../actions";

type List = {
  id: string;
  name: string;
  address: string;
};

type Draft = {
  id: string;
  from_address: string;
  subject: string;
  html: string;
  scheduled_at: string | null;
  campaigns: string[];
  tags: string[];
  recipients: string[];
  list_id: string | null;
};

type Props = {
  draft: Draft | null;
  lists: List[];
};

export function ComposerForm({ draft, lists }: Props) {
  // If the draft was previously sent to a list, pre-select it
  const initialList = draft?.list_id
    ? lists.find((l) => l.id === draft.list_id) ?? null
    : null;

  const [selectedList, setSelectedList] = useState<List | null>(initialList);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const scheduledAtLocal = draft?.scheduled_at
    ? new Date(draft.scheduled_at).toISOString().slice(0, 16)
    : "";

  const handleSelectList = (list: List) => {
    if (selectedList?.id === list.id) {
      // Deselect
      setSelectedList(null);
    } else {
      setSelectedList(list);
    }
    setResult(null);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formRef.current) return;

    setSending(true);
    setResult(null);

    const formData = new FormData(formRef.current);

    try {
      if (selectedList && draft?.id) {
        // Queue campaign to list
        formData.set("emailId", draft.id);
        formData.set("listId", selectedList.id);
        const res = await queueCampaignAction(formData);
        setResult({
          ok: true,
          message: `Queued ${res.totalRecipients.toLocaleString()} emails across ${res.daysNeeded} day${res.daysNeeded !== 1 ? "s" : ""}.`,
        });
      } else {
        // Send test directly to individual addresses in recipients field
        await sendTestAction(formData);
        setResult({ ok: true, message: "Test sent successfully." });
      }
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Send failed.",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs uppercase tracking-wide text-slate-400">
          {draft ? "Editing Draft" : "Draft"}
        </p>
        <h2 className="text-2xl font-semibold text-slate-900">Compose Email</h2>
        <p className="text-sm text-slate-500">
          This mirrors the original Props composer and hooks into Supabase + Amazon SES.
        </p>
      </section>

      <form
        ref={formRef}
        action={saveDraftAction}
        className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-6"
      >
        {draft && <input type="hidden" name="id" value={draft.id} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            From
            <input
              name="from"
              required
              defaultValue={draft?.from_address ?? "Amol Sarva <amol@sarva.co>"}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 bg-white"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Scheduled send (optional)
            <input
              name="scheduledAt"
              type="datetime-local"
              defaultValue={scheduledAtLocal}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 bg-white"
            />
          </label>
        </div>

        <label className="text-sm font-medium text-slate-700">
          Subject
          <input
            name="subject"
            required
            defaultValue={draft?.subject ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 bg-white"
          />
        </label>

        {/* ── To / Recipients ── */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-slate-700">To</span>
            {selectedList && (
              <button
                type="button"
                onClick={() => setSelectedList(null)}
                className="text-xs text-slate-400 hover:text-slate-700"
              >
                ✕ clear list
              </button>
            )}
          </div>

          {/* List picker */}
          {lists.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {lists.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  onClick={() => handleSelectList(list)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    selectedList?.id === list.id
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 text-slate-600 hover:border-slate-500 hover:text-slate-900"
                  }`}
                >
                  {list.name}
                </button>
              ))}
            </div>
          )}

          {/* Recipients field — shows list name when list selected, or individual addresses */}
          <textarea
            name="recipients"
            required={!selectedList}
            rows={selectedList ? 1 : 3}
            readOnly={!!selectedList}
            value={
              selectedList
                ? `${selectedList.name} <${selectedList.address}>`
                : undefined
            }
            defaultValue={
              !selectedList
                ? (draft?.recipients.join("\n") ?? "")
                : undefined
            }
            placeholder="Paste addresses or choose a list above"
            className={`w-full rounded-md border px-3 py-2 text-sm transition-colors ${
              selectedList
                ? "border-slate-200 bg-slate-100 text-slate-600 cursor-default"
                : "border-slate-300 bg-white"
            }`}
          />
          {selectedList && (
            <p className="mt-1 text-xs text-slate-500">
              Will send individually to every active member of this list.
            </p>
          )}
        </div>

        <label className="text-sm font-medium text-slate-700">
          HTML
          <textarea
            name="html"
            required
            rows={8}
            defaultValue={draft?.html ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 bg-white"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Campaigns
            <input
              name="campaigns"
              placeholder="campaign-a,campaign-b"
              defaultValue={draft?.campaigns.join(",") ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 bg-white"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Tags
            <input
              name="tags"
              placeholder="weekly,update"
              defaultValue={draft?.tags.join(",") ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 bg-white"
            />
          </label>
        </div>

        {/* Result banner */}
        {result && (
          <div
            className={`rounded-md px-4 py-3 text-sm ${
              result.ok
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {result.message}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Save Draft
          </button>

          <button
            type="button"
            onClick={handleSend}
            disabled={sending || (selectedList !== null && !draft?.id)}
            className={`rounded-md border px-4 py-2 text-sm font-semibold transition-colors ${
              selectedList
                ? "border-slate-900 bg-slate-900 text-white hover:bg-slate-700"
                : "border-slate-900 text-slate-900 hover:bg-slate-50"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {sending
              ? "Sending…"
              : selectedList
              ? `Send to ${selectedList.name}`
              : "Send Test"}
          </button>

          {selectedList && !draft?.id && (
            <p className="self-center text-xs text-amber-600">
              Save the draft first before sending to a list.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
