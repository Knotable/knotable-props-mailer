"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { saveDraftAction, sendTestAction, queueCampaignAction } from "../actions";

const LAST_DRAFT_KEY = "composer.lastDraftId";

type List = { id: string; name: string; address: string };

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

type Props = { draft: Draft | null; lists: List[] };

export function ComposerForm({ draft, lists }: Props) {
  const router = useRouter();
  const initialList = draft?.list_id
    ? (lists.find((l) => l.id === draft.list_id) ?? null)
    : null;

  const [selectedList, setSelectedList] = useState<List | null>(initialList);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; message: string } | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Persist / restore last open draft across reloads and redeploys
  useEffect(() => {
    if (draft?.id) {
      localStorage.setItem(LAST_DRAFT_KEY, draft.id);
    } else {
      const lastId = localStorage.getItem(LAST_DRAFT_KEY);
      if (lastId) router.replace(`/email/composer?id=${lastId}`);
    }
  }, [draft?.id, router]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Format a Date as YYYY-MM-DDTHH:mm in the *browser's* local timezone,
  // which is what datetime-local inputs expect and submit.
  const toDatetimeLocal = (d: Date) => {
    const offsetMs = d.getTimezoneOffset() * 60_000;
    return new Date(d.getTime() - offsetMs).toISOString().slice(0, 16);
  };

  // Default to "now" (rounded down to the minute).
  // If the draft has a future scheduled_at, use that; otherwise use now.
  const scheduledAtLocal = (() => {
    const now = new Date();
    now.setSeconds(0, 0);
    const nowStr = toDatetimeLocal(now);
    if (!draft?.scheduled_at) return nowStr;
    const draftStr = toDatetimeLocal(new Date(draft.scheduled_at));
    return draftStr > nowStr ? draftStr : nowStr;
  })();

  // ── Save Draft ────────────────────────────────────────────────────────────
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formRef.current) return;
    setSaving(true);
    setBanner(null);
    try {
      const fd = new FormData(formRef.current);
      await saveDraftAction(fd);
      setBanner({ ok: true, message: "Draft saved." });
    } catch (err) {
      setBanner({ ok: false, message: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!formRef.current) return;
    setSending(true);
    setBanner(null);
    const fd = new FormData(formRef.current);

    try {
      if (selectedList) {
        if (!draft?.id) {
          setBanner({ ok: false, message: "Save the draft before sending to a list." });
          return;
        }
        fd.set("emailId", draft.id);
        fd.set("listId", selectedList.id);
        const res = await queueCampaignAction(fd);
        setBanner({
          ok: true,
          message: `Queued ${res.totalRecipients.toLocaleString()} emails to "${selectedList.name}"${res.daysNeeded > 1 ? ` across ${res.daysNeeded} days` : ""}.`,
        });
      } else {
        // No list selected — send directly to addresses in the To field
        const res = await sendTestAction(fd);
        const n = res.sent;
        setBanner({
          ok: true,
          message: `Sent to ${n} recipient${n !== 1 ? "s" : ""}.`,
        });
      }
    } catch (err) {
      setBanner({ ok: false, message: err instanceof Error ? err.message : "Send failed." });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">
          {draft ? "Editing Draft" : "Draft"}
        </p>
        <h2 className="text-2xl font-semibold text-slate-900">Compose Email</h2>
      </header>

      <form
        ref={formRef}
        onSubmit={handleSave}
        className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-6"
      >
        {draft && <input type="hidden" name="id" value={draft.id} />}

        {/* From + Scheduled */}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            From
            <input
              name="from"
              required
              defaultValue={draft?.from_address ?? "Amol Sarva <amol@sarva.co>"}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Scheduled send (optional)
            <input
              name="scheduledAt"
              type="datetime-local"
              defaultValue={scheduledAtLocal}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
        </div>

        {/* Subject */}
        <label className="block text-sm font-medium text-slate-700">
          Subject
          <input
            name="subject"
            required
            defaultValue={draft?.subject ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </label>

        {/* To field with Lists dropdown */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">To</label>
          <div className="flex gap-2 items-start">
            {/* Text field or selected list pill */}
            <div className="flex-1">
              {selectedList ? (
                <div className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2">
                  <span className="text-sm text-slate-800 font-medium flex-1">
                    {selectedList.name}
                    <span className="ml-1 text-slate-400 font-normal text-xs">
                      &lt;{selectedList.address}&gt;
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedList(null)}
                    className="text-slate-400 hover:text-slate-700 text-xs leading-none"
                    title="Remove list"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <textarea
                  name="recipients"
                  rows={2}
                  defaultValue={draft?.recipients.join("\n") ?? ""}
                  placeholder="email@example.com, one per line or comma-separated"
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              )}
              {selectedList && (
                <p className="mt-1 text-xs text-slate-500">
                  Sends individually to every active member of this list.
                </p>
              )}
              {/* Hidden field so form still submits recipient info when list selected */}
              {selectedList && (
                <input type="hidden" name="recipients" value={selectedList.address} />
              )}
            </div>

            {/* Lists dropdown button */}
            {lists.length > 0 && (
              <div className="relative shrink-0" ref={dropdownRef}>
                <button
                  type="button"
                  onClick={() => setDropdownOpen((o) => !o)}
                  className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  Lists
                  <span className="text-slate-400">▾</span>
                </button>

                {dropdownOpen && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-slate-200 bg-white shadow-lg">
                    <div className="p-1">
                      {lists.map((list) => (
                        <button
                          key={list.id}
                          type="button"
                          onClick={() => {
                            setSelectedList(list);
                            setDropdownOpen(false);
                          }}
                          className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors ${
                            selectedList?.id === list.id
                              ? "bg-slate-900 text-white"
                              : "text-slate-700 hover:bg-slate-100"
                          }`}
                        >
                          <span className="font-medium">{list.name}</span>
                          <span className={`ml-2 text-xs ${selectedList?.id === list.id ? "text-slate-300" : "text-slate-400"}`}>
                            {list.address}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* HTML */}
        <label className="block text-sm font-medium text-slate-700">
          HTML
          <textarea
            name="html"
            required
            rows={8}
            defaultValue={draft?.html ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono"
          />
        </label>

        {/* Campaigns + Tags */}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Campaigns
            <input
              name="campaigns"
              placeholder="campaign-a,campaign-b"
              defaultValue={draft?.campaigns.join(",") ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Tags
            <input
              name="tags"
              placeholder="weekly,update"
              defaultValue={draft?.tags.join(",") ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
        </div>

        {/* Banner */}
        {banner && (
          <div className={`rounded-md px-4 py-3 text-sm border ${
            banner.ok
              ? "bg-green-50 text-green-800 border-green-200"
              : "bg-red-50 text-red-800 border-red-200"
          }`}>
            {banner.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-3 pt-1">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Draft"}
          </button>

          <button
            type="button"
            onClick={handleSend}
            disabled={sending}
            className="rounded-md bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
