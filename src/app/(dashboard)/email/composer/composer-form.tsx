"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { saveDraftAction, sendTestAction, queueCampaignAction, type QueueCampaignConfirm } from "../actions";

const LAST_DRAFT_KEY = "composer.lastDraftId";
const AUTOSAVE_DELAY_MS = 3_000;

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

type AutosaveState = "idle" | "pending" | "saving" | "saved" | "error";

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
  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null);
  const [autosaveState, setAutosaveState] = useState<AutosaveState>("idle");
  // Duplicate-send confirmation state — set when the server returns requiresConfirmation:true.
  const [dupWarning, setDupWarning] = useState<QueueCampaignConfirm | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref so the autosave closure always sees the latest draftId without
  // needing to re-register the form onChange handler.
  const draftIdRef = useRef<string | null>(draftId);
  useEffect(() => { draftIdRef.current = draftId; }, [draftId]);

  // Persist / restore last open draft across reloads
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

  // Clear the autosave timer on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  // Core autosave logic — reads from formRef so it always has the latest values.
  const runAutosave = useCallback(async () => {
    if (!formRef.current) return;
    setAutosaveState("saving");
    try {
      const fd = new FormData(formRef.current);
      // Inject the current draftId (may differ from the mounted prop).
      const currentId = draftIdRef.current;
      if (currentId && !fd.get("id")) fd.set("id", currentId);
      const res = await saveDraftAction(fd);
      if (res?.id && res.id !== draftIdRef.current) {
        draftIdRef.current = res.id;
        setDraftId(res.id);
        localStorage.setItem(LAST_DRAFT_KEY, res.id);
        router.replace(`/email/composer?id=${res.id}`, { scroll: false });
      }
      setAutosaveState("saved");
      // Fade "Saved" back to idle after 4 s
      setTimeout(() => setAutosaveState((s) => (s === "saved" ? "idle" : s)), 4_000);
    } catch {
      setAutosaveState("error");
    }
  }, [router]);

  // Schedule an autosave 3 s after the user stops typing.
  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    setAutosaveState("pending");
    autosaveTimerRef.current = setTimeout(runAutosave, AUTOSAVE_DELAY_MS);
  }, [runAutosave]);

  const cancelAutosave = () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    setAutosaveState("idle");
  };

  const toDatetimeLocal = (d: Date) => {
    const offsetMs = d.getTimezoneOffset() * 60_000;
    return new Date(d.getTime() - offsetMs).toISOString().slice(0, 16);
  };

  const scheduledAtLocal = (() => {
    const now = new Date();
    now.setSeconds(0, 0);
    const nowStr = toDatetimeLocal(now);
    if (!draft?.scheduled_at) return nowStr;
    const draftStr = toDatetimeLocal(new Date(draft.scheduled_at));
    return draftStr > nowStr ? draftStr : nowStr;
  })();

  // ── Save Draft ─────────────────────────────────────────────────────────────
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formRef.current) return;
    cancelAutosave();
    setSaving(true);
    setBanner(null);
    try {
      const fd = new FormData(formRef.current);
      const res = await saveDraftAction(fd);
      if (res?.id && res.id !== draftId) {
        setDraftId(res.id);
        localStorage.setItem(LAST_DRAFT_KEY, res.id);
        router.replace(`/email/composer?id=${res.id}`, { scroll: false });
      }
      setBanner({ ok: true, message: "Draft saved." });
    } catch (err) {
      setBanner({ ok: false, message: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  // ── Core queue helper (used by both first-send and "send anyway") ─────────
  const runQueueCampaign = async (skipDuplicateCheck: boolean) => {
    if (!formRef.current || !selectedList || !draftId) return;
    cancelAutosave();
    setSending(true);
    setBanner(null);
    setDupWarning(null);
    const fd = new FormData(formRef.current);
    fd.set("emailId", draftId);
    fd.set("listId", selectedList.id);
    if (skipDuplicateCheck) fd.set("skipDuplicateCheck", "true");

    try {
      const res = await queueCampaignAction(fd);
      if (!res.ok && res.requiresConfirmation) {
        setDupWarning(res);
        return;
      }
      if (res.ok) {
        setBanner({
          ok: true,
          message: `Queued ${res.totalRecipients.toLocaleString()} emails to "${selectedList.name}"${res.daysNeeded > 1 ? ` across ${res.daysNeeded} days` : ""}.`,
        });
      }
    } catch (err) {
      setBanner({ ok: false, message: err instanceof Error ? err.message : "Send failed." });
    } finally {
      setSending(false);
    }
  };

  // ── Send ───────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!formRef.current) return;
    cancelAutosave();
    setBanner(null);
    setDupWarning(null);

    if (selectedList) {
      if (!draftId) {
        setBanner({ ok: false, message: "Save the draft before sending to a list." });
        return;
      }
      await runQueueCampaign(false);
    } else {
      setSending(true);
      const fd = new FormData(formRef.current);
      try {
        const res = await sendTestAction(fd);
        const n = res.sent;
        setBanner({
          ok: true,
          message: `Sent to ${n} recipient${n !== 1 ? "s" : ""}.`,
        });
      } catch (err) {
        setBanner({ ok: false, message: err instanceof Error ? err.message : "Send failed." });
      } finally {
        setSending(false);
      }
    }
  };

  // ── Send anyway (override duplicate warning) ───────────────────────────────
  const handleSendAnyway = () => runQueueCampaign(true);

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
        onChange={scheduleAutosave}
        className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-6"
      >
        {draftId && <input type="hidden" name="id" value={draftId} />}

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
              {selectedList && (
                <input type="hidden" name="recipients" value={selectedList.address} />
              )}
            </div>

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

        {/* Duplicate-send confirmation */}
        {dupWarning && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-4 text-sm space-y-3">
            <p className="font-semibold text-amber-900">Duplicate send detected</p>
            <ul className="space-y-1 text-amber-800">
              {dupWarning.duplicateCount > 0 && (
                <li>
                  <span className="font-medium">{dupWarning.duplicateCount.toLocaleString()}</span>{" "}
                  recipient{dupWarning.duplicateCount !== 1 ? "s" : ""} already received this exact email
                  {dupWarning.listName ? ` via "${dupWarning.listName}"` : ""}.
                </li>
              )}
              {dupWarning.recentlySentCount > 0 && (
                <li>
                  <span className="font-medium">{dupWarning.recentlySentCount.toLocaleString()}</span>{" "}
                  recipient{dupWarning.recentlySentCount !== 1 ? "s" : ""} on this list received a different email in the last 30 days.
                </li>
              )}
            </ul>
            {dupWarning.sampleAddresses.length > 0 && (
              <div>
                <p className="text-xs font-medium text-amber-700 mb-1">Sample addresses:</p>
                <ul className="text-xs text-amber-700 space-y-0.5">
                  {dupWarning.sampleAddresses.map((addr) => (
                    <li key={addr} className="font-mono">{addr}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDupWarning(null)}
                className="rounded-md border border-amber-300 bg-white px-4 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendAnyway}
                disabled={sending}
                className="rounded-md bg-amber-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send anyway"}
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
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

          {/* Autosave indicator */}
          <span className="ml-auto text-xs">
            {autosaveState === "pending" && (
              <span className="text-slate-300">●</span>
            )}
            {autosaveState === "saving" && (
              <span className="text-slate-400">Autosaving…</span>
            )}
            {autosaveState === "saved" && (
              <span className="text-green-600">Autosaved</span>
            )}
            {autosaveState === "error" && (
              <span className="text-amber-600">Autosave failed</span>
            )}
          </span>
        </div>
      </form>
    </div>
  );
}
