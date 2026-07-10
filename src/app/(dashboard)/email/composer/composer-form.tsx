"use client";

import {
  Bold,
  ChevronDown,
  Eraser,
  FileText,
  Heading2,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Pilcrow,
  Upload,
  Underline,
  Unlink,
  X,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  saveDraftAction,
  sendTestAction,
  queueCampaignAction,
  sendQueuedEmailAction,
  importOneTimeAudienceAction,
  type QueueCampaignConfirm,
  type QueueCampaignOk,
} from "../actions";
import { ProgressStatus } from "@/components/progress-status";
import { buildQueueReleaseConfirmation } from "@/lib/queueReleaseGuard";
import {
  parseOneTimeAudienceCsv,
  personalizeAudiencePreview,
  unresolvedMergeTags,
  type AudienceParseResult,
} from "@/lib/client/oneTimeAudience";

const LAST_DRAFT_KEY = "composer.lastDraftId";
const AUTOSAVE_DELAY_MS = 3_000;

type List = { id: string; name: string; address: string; access_level?: string | null };

type Draft = {
  id: string;
  from_address: string;
  reply_to: string | null;
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
  templateMode?: boolean;
  userEmail: string;
  canSend: boolean;
};

type AutosaveState = "idle" | "pending" | "saving" | "saved" | "error";
type QueueWorkflowTarget = "queue" | "sendNow";
type WarningGroup = QueueCampaignConfirm["warningGroups"][number];

function isOneTimeList(list: List | null) {
  return list?.access_level === "one_time_csv" || list?.address.startsWith("one-time-") || false;
}

export function ComposerForm({ draft, lists, templateMode = false, userEmail, canSend }: Props) {
  const router = useRouter();
  const initialList = draft?.list_id
    ? (lists.find((l) => l.id === draft.list_id) ?? null)
    : null;

  const [selectedList, setSelectedList] = useState<List | null>(initialList);
  const [availableLists, setAvailableLists] = useState<List[]>(lists);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(templateMode ? null : (draft?.id ?? null));
  const [autosaveState, setAutosaveState] = useState<AutosaveState>("idle");
  const [activeWorkflow, setActiveWorkflow] = useState<QueueWorkflowTarget | "directSend" | null>(null);
  const [pendingQueueTarget, setPendingQueueTarget] = useState<QueueWorkflowTarget>("queue");
  // Duplicate-send confirmation state — set when the server returns requiresConfirmation:true.
  const [dupWarning, setDupWarning] = useState<QueueCampaignConfirm | null>(null);
  const [audienceName, setAudienceName] = useState("");
  const [audienceCsv, setAudienceCsv] = useState("");
  const [audienceFileName, setAudienceFileName] = useState<string | null>(null);
  const [audiencePreview, setAudiencePreview] = useState<AudienceParseResult | null>(null);
  const [audienceImporting, setAudienceImporting] = useState(false);
  const [audiencePreviewIndex, setAudiencePreviewIndex] = useState(0);

  const formRef = useRef<HTMLFormElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref so the autosave closure always sees the latest draftId without
  // needing to re-register the form onChange handler.
  const draftIdRef = useRef<string | null>(draftId);
  useEffect(() => { draftIdRef.current = draftId; }, [draftId]);

  useEffect(() => {
    setAvailableLists(lists);
  }, [lists]);

  // Persist / restore last open draft across reloads
  useEffect(() => {
    if (templateMode) return;
    if (draft?.id) {
      localStorage.setItem(LAST_DRAFT_KEY, draft.id);
    } else {
      const lastId = localStorage.getItem(LAST_DRAFT_KEY);
      if (lastId) router.replace(`/email/composer?id=${lastId}`);
    }
  }, [draft?.id, router, templateMode]);

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

  // ── Preview ────────────────────────────────────────────────────────────────
  const handlePreview = () => {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    const html = fd.get("html") as string | null;
    if (!html) return;
    const win = window.open("", "_blank", "width=800,height=700,resizable=yes,scrollbars=yes");
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  // ── Send Test ──────────────────────────────────────────────────────────────
  const [sendingTest, setSendingTest] = useState(false);

  const handleSendTest = async () => {
    if (!formRef.current) return;
    if (!canSend) {
      setBanner({ ok: false, message: "An admin has not enabled sending for this account." });
      return;
    }
    cancelAutosave();
    setSendingTest(true);
    setBanner(null);
    setActionStatus("Sending a test email through SES...");
    try {
      const fd = new FormData(formRef.current);
      fd.set("recipients", userEmail);
      const res = await sendTestAction(fd);
      if (res.error) {
        setBanner({ ok: false, message: res.error });
      } else {
        setBanner({ ok: true, message: `Test sent to ${userEmail} (${res.sent} email${res.sent !== 1 ? "s" : ""}).` });
      }
    } catch (err) {
      setBanner({ ok: false, message: getActionErrorMessage(err, "Test send failed.") });
    } finally {
      setSendingTest(false);
      setActionStatus(null);
    }
  };

  const refreshAudiencePreview = (csv: string) => {
    const parsed = parseOneTimeAudienceCsv(csv);
    setAudiencePreview(parsed);
    setAudiencePreviewIndex(0);
    return parsed;
  };

  const handleAudienceFile = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setAudienceFileName(file.name);
    setAudienceCsv(text);
    if (!audienceName.trim()) {
      const baseName = file.name.replace(/\.[^.]+$/g, "").replace(/[-_]+/g, " ").trim();
      setAudienceName(baseName ? `One-time: ${baseName}` : "One-time CSV audience");
    }
    refreshAudiencePreview(text);
  };

  const handleImportAudience = async () => {
    const parsed = audiencePreview ?? refreshAudiencePreview(audienceCsv);
    if (parsed.errors.length > 0) {
      setBanner({ ok: false, message: parsed.errors[0] });
      return;
    }
    if (parsed.members.length === 0) {
      setBanner({ ok: false, message: "CSV did not contain any valid recipients." });
      return;
    }

    setAudienceImporting(true);
    setBanner(null);
    setActionStatus("Importing one-time audience...");
    try {
      const fd = new FormData();
      fd.set("name", audienceName.trim() || "One-time CSV audience");
      fd.set("csv", audienceCsv);
      if (audienceFileName) fd.set("sourceFilename", audienceFileName);
      const res = await importOneTimeAudienceAction(fd);
      if (!res.ok) {
        setBanner({ ok: false, message: res.error });
        return;
      }
      setAvailableLists((current) => [res.list, ...current.filter((list) => list.id !== res.list.id)]);
      setSelectedList(res.list);
      setBanner({
        ok: true,
        message: `Imported ${res.imported.toLocaleString()} recipient${res.imported !== 1 ? "s" : ""} as "${res.list.name}".`,
      });
    } catch (err) {
      setBanner({ ok: false, message: getActionErrorMessage(err, "Could not import this audience.") });
    } finally {
      setAudienceImporting(false);
      setActionStatus(null);
    }
  };

  const handlePreviewAudienceRecipient = () => {
    const member = audiencePreview?.members[audiencePreviewIndex];
    if (!member || !formRef.current) return;

    const fd = new FormData(formRef.current);
    const subject = String(fd.get("subject") ?? "");
    const html = String(fd.get("html") ?? "");
    const personalizedSubject = personalizeAudiencePreview(subject, member, "text");
    const personalizedHtml = personalizeAudiencePreview(html, member, "html");
    const remainingTags = unresolvedMergeTags(`${personalizedSubject}\n${personalizedHtml}`);
    const warning = remainingTags.length > 0
      ? `<p style="color:#92400e;font:13px system-ui;margin:0 0 12px;">Unresolved tags: ${remainingTags.join(", ")}</p>`
      : "";

    const win = window.open("", "_blank", "width=900,height=760,resizable=yes,scrollbars=yes");
    if (!win) return;
    win.document.open();
    win.document.write(`
      <div style="font:14px system-ui;padding:16px;border-bottom:1px solid #e5e7eb;background:#f8fafc;">
        <div><strong>To:</strong> ${member.email}</div>
        <div><strong>Subject:</strong> ${personalizedSubject}</div>
      </div>
      <div style="padding:16px;">${warning}${personalizedHtml}</div>
    `);
    win.document.close();
  };

  // ── Save Draft ─────────────────────────────────────────────────────────────
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formRef.current) return;
    cancelAutosave();
    setSaving(true);
    setBanner(null);
    setActionStatus("Saving draft to Supabase...");
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
      setActionStatus(null);
    }
  };

  // ── Core queue helper (used by Queue, Send Now, and duplicate overrides) ──
  const runQueueCampaign = async (
    skipDuplicateCheck: boolean,
    emailIdOverride?: string,
    excludeRecipients?: string[],
    target: QueueWorkflowTarget = "queue",
  ) => {
    let emailId = emailIdOverride ?? draftId;
    if (!formRef.current || !selectedList || !emailId) return;
    cancelAutosave();
    setSending(true);
    setActiveWorkflow(target);
    setBanner(null);
    setDupWarning(null);
    setPendingQueueTarget(target);
    setActionStatus("Saving the latest draft before queue preparation...");

    try {
      const saveFd = new FormData(formRef.current);
      saveFd.set("id", emailId);
      const saveRes = await saveDraftAction(saveFd);
      emailId = saveRes.id;
      if (saveRes.id !== draftId) {
        setDraftId(saveRes.id);
        localStorage.setItem(LAST_DRAFT_KEY, saveRes.id);
        router.replace(`/email/composer?id=${saveRes.id}`, { scroll: false });
      }

      let offset = 0;
      let lastOk: QueueCampaignOk | null = null;

      for (;;) {
        setActionStatus(
          offset === 0
            ? `Preparing recipients from "${selectedList.name}"...`
            : `Preparing the next recipient batch from "${selectedList.name}" at offset ${offset.toLocaleString()}...`,
        );
        const fd = new FormData(formRef.current);
        fd.set("emailId", emailId);
        fd.set("listId", selectedList.id);
        fd.set("offset", String(offset));
        if (skipDuplicateCheck) fd.set("skipDuplicateCheck", "true");
        if (excludeRecipients && excludeRecipients.length > 0) {
          fd.set("excludeRecipients", JSON.stringify(excludeRecipients));
        }

        const res = await queueCampaignAction(fd);
        if (!res.ok) {
          if (res.requiresConfirmation) {
            setDupWarning(res);
            setPendingQueueTarget(target);
          } else {
            setBanner({ ok: false, message: res.error });
          }
          return;
        }

        lastOk = res;
        setActionStatus(
          `Prepared ${res.queuedRecipients.toLocaleString()} of ${res.totalRecipients.toLocaleString()} recipients from "${selectedList.name}".`,
        );
        setBanner({
          ok: true,
          message: `Queueing "${selectedList.name}": ${res.queuedRecipients.toLocaleString()} of ${res.totalRecipients.toLocaleString()} prepared...`,
        });

        if (!res.hasMore || !res.nextOffset) break;
        offset = res.nextOffset;
      }

      if (lastOk?.ok) {
        if (target === "sendNow") {
          setActionStatus("Queue preparation finished. Releasing this campaign now...");
          const releaseFd = new FormData();
          releaseFd.set("id", emailId);
          releaseFd.set("releaseConfirmation", buildQueueReleaseConfirmation(emailId));
          const release = await sendQueuedEmailAction(releaseFd);
          if (release.error) throw new Error(release.error);
          setActionStatus("Release started. Opening the scoped monitor...");
          setBanner({
            ok: true,
            message:
              (release.remainingQueued ?? 0) > 0
                ? `Released ${release.dueNow ?? 0} for today; opening the monitor for this campaign.`
                : `Send completed: ${release.succeeded ?? 0} accepted${(release.failed ?? 0) > 0 ? `, ${release.failed} failed` : ""}.`,
          });
          router.push(`/email/monitor?emailId=${emailId}&auto=1`);
        } else {
          setActionStatus("Queue preparation finished. Opening the Queue page...");
          setBanner({
            ok: true,
            message: `Queued ${lastOk.totalRecipients.toLocaleString()} emails to "${selectedList.name}" for manual send${lastOk.daysNeeded > 1 ? ` (${lastOk.daysNeeded} send-days at current quota)` : ""}.`,
          });
          router.push("/email/schedule");
        }
      }
    } catch (err) {
      setBanner({ ok: false, message: getActionErrorMessage(err, "Queue failed.") });
    } finally {
      setSending(false);
      setActiveWorkflow(null);
      setActionStatus(null);
    }
  };

  // ── Queue / Send ───────────────────────────────────────────────────────────
  const handleQueueOrSend = async (target: QueueWorkflowTarget) => {
    if (!formRef.current) return;
    if (!canSend) {
      setBanner({ ok: false, message: "An admin has not enabled sending for this account." });
      return;
    }
    cancelAutosave();
    setBanner(null);
    setDupWarning(null);
    const fd = new FormData(formRef.current);

    if (selectedList) {
      if (target === "sendNow") {
        const confirmed = confirm(
          `Queue and send "${(fd.get("subject") as string | null) || "this email"}" to "${selectedList.name}" now?`,
        );
        if (!confirmed) return;
      }

      let emailId = draftId;
      if (!emailId) {
        setActionStatus("Creating a draft before queue preparation...");
        try {
          const saveRes = await saveDraftAction(fd);
          emailId = saveRes.id;
          setDraftId(emailId);
          localStorage.setItem(LAST_DRAFT_KEY, emailId);
          router.replace(`/email/composer?id=${emailId}`, { scroll: false });
        } catch (err) {
          setBanner({ ok: false, message: getActionErrorMessage(err, "Unable to prepare this email for queueing.") });
          setActionStatus(null);
          return;
        }
      }
      if (!emailId) {
        setBanner({ ok: false, message: "Unable to create a draft for queueing. Please try again." });
        return;
      }
      await runQueueCampaign(false, emailId, undefined, target);
    } else {
      setSending(true);
      setActiveWorkflow("directSend");
      setActionStatus("Sending email through SES...");
      try {
        const res = await sendTestAction(fd);
        if (res.error) {
          setBanner({ ok: false, message: res.error });
          return;
        }
        const n = res.sent;
        setBanner({
          ok: true,
          message: `Sent to ${n} recipient${n !== 1 ? "s" : ""}.`,
        });
        router.push("/email/sends");
      } catch (err) {
        setBanner({ ok: false, message: getActionErrorMessage(err, "Send failed.") });
      } finally {
        setSending(false);
        setActiveWorkflow(null);
        setActionStatus(null);
      }
    }
  };

  // ── Queue anyway (override duplicate warning) ──────────────────────────────
  const handleSendAnyway = () => runQueueCampaign(true, undefined, undefined, pendingQueueTarget);

  // ── Queue without duplicates (exclude exact duplicate recipients) ──────────
  const handleSendWithoutDuplicates = () => {
    if (!dupWarning) return;
    const exactDuplicates = dupWarning.warningGroups.flatMap((g) => g.exactRecipientAddresses);
    runQueueCampaign(true, undefined, exactDuplicates, pendingQueueTarget);
  };

  const canQueueWithoutDuplicates =
    !!dupWarning &&
    dupWarning.duplicateCount > 0 &&
    dupWarning.duplicateCount === dupWarning.sampledDuplicateCount;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-400">
          {templateMode ? "From Existing Email" : draft ? "Editing Draft" : "Draft"}
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

        <div className="grid gap-4 sm:grid-cols-1">
          <label className="block text-sm font-medium text-slate-700">
            From
            <input
              name="from"
              required
              defaultValue={draft?.from_address ?? "Amol Sarva <amol@lifex.vc>"}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Reply-To
            <input
              name="replyTo"
              type="email"
              defaultValue={draft?.reply_to ?? "amol@lifex.vc"}
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
            placeholder="Subject, e.g. Hello {{firstName}}"
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
                    className="inline-flex items-center justify-center rounded text-slate-400 hover:text-slate-700"
                    title="Remove list"
                  >
                    <X aria-hidden="true" className="size-4" />
                    <span className="sr-only">Remove list</span>
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
                  Queues individual sends for every active member of this {isOneTimeList(selectedList) ? "one-time audience" : "list"}. You can review and send it later from the Queue page.
                </p>
              )}
              {selectedList && (
                <input type="hidden" name="recipients" value={selectedList.address} />
              )}
            </div>

            {availableLists.length > 0 && (
              <div className="relative shrink-0" ref={dropdownRef}>
                <button
                  type="button"
                  onClick={() => setDropdownOpen((o) => !o)}
                  className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  Lists
                  <ChevronDown aria-hidden="true" className="size-4 text-slate-400" />
                </button>

                {dropdownOpen && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-slate-200 bg-white shadow-lg">
                    <div className="p-1">
                      {availableLists.map((list) => (
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
                          {isOneTimeList(list) && (
                            <span className={`ml-2 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase ${selectedList?.id === list.id ? "bg-white/15 text-slate-100" : "bg-blue-50 text-blue-700"}`}>
                              one-time
                            </span>
                          )}
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

        <div
          className="rounded-md border border-blue-200 bg-white px-4 py-4"
          onChange={(event) => event.stopPropagation()}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">One-time mail merge audience</p>
              <p className="mt-1 text-xs text-slate-500">
                Upload a CSV with an email column and optional fields like name, first_name, opener, company, or custom_note.
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800 hover:bg-blue-100">
              <Upload aria-hidden="true" className="size-4" />
              Upload CSV
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => void handleAudienceFile(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                Audience name
                <input
                  value={audienceName}
                  onChange={(event) => setAudienceName(event.target.value)}
                  placeholder="One-time: July investor intros"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                CSV
                <textarea
                  value={audienceCsv}
                  onChange={(event) => {
                    setAudienceCsv(event.target.value);
                    setAudiencePreview(null);
                  }}
                  rows={5}
                  placeholder={'email,name,first_name,opener\na@example.com,Alice Smith,Alice,"Loved your London note."'}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => refreshAudiencePreview(audienceCsv)}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  <FileText aria-hidden="true" className="size-4" />
                  Validate
                </button>
                <button
                  type="button"
                  onClick={handleImportAudience}
                  disabled={audienceImporting || !audienceCsv.trim()}
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                >
                  {audienceImporting ? "Importing..." : "Import and select"}
                </button>
                {audienceFileName && (
                  <span className="text-xs text-slate-500">{audienceFileName}</span>
                )}
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase text-slate-500">Validation</p>
              {audiencePreview ? (
                <div className="mt-2 space-y-3 text-sm">
                  {audiencePreview.errors.length > 0 ? (
                    <p className="text-red-700">{audiencePreview.errors[0]}</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded bg-white p-2">
                          <p className="text-slate-500">Valid</p>
                          <p className="text-lg font-semibold text-slate-900">{audiencePreview.members.length.toLocaleString()}</p>
                        </div>
                        <div className="rounded bg-white p-2">
                          <p className="text-slate-500">Skipped</p>
                          <p className="text-lg font-semibold text-slate-900">
                            {(audiencePreview.skippedInvalid + audiencePreview.skippedDuplicate).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-slate-600">
                        {audiencePreview.skippedInvalid.toLocaleString()} invalid, {audiencePreview.skippedDuplicate.toLocaleString()} duplicate.
                      </p>
                      {audiencePreview.members.length > 0 && (
                        <div className="space-y-2">
                          <label className="block text-xs font-medium text-slate-600">
                            Preview recipient
                            <select
                              value={audiencePreviewIndex}
                              onChange={(event) => setAudiencePreviewIndex(Number(event.target.value))}
                              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs"
                            >
                              {audiencePreview.members.slice(0, 25).map((member, index) => (
                                <option key={`${member.email}-${member.sourceRow}`} value={index}>
                                  {member.name ? `${member.name} - ` : ""}{member.email}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            onClick={handlePreviewAudienceRecipient}
                            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            Open personalized preview
                          </button>
                          <div className="max-h-28 overflow-auto rounded border border-slate-200 bg-white p-2 text-xs text-slate-600">
                            {Object.entries(audiencePreview.members[audiencePreviewIndex]?.mergeData ?? {}).slice(0, 10).map(([key, value]) => (
                              <p key={key} className="truncate">
                                <span className="font-medium text-slate-800">{`{{${key}}}`}</span>: {value}
                              </p>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">Validate a CSV to see row counts, skipped recipients, and a personalized preview sample.</p>
              )}
            </div>
          </div>
        </div>

        {/* HTML */}
        <RichHtmlEditor
          initialHtml={draft?.html ?? ""}
          onChange={scheduleAutosave}
        />

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

        {actionStatus && (
          <ProgressStatus
            title={actionStatus}
            detail="Waiting for the remote call to finish before updating this page."
            tone={sending ? "blue" : "slate"}
          />
        )}

        {!canSend && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Sending is disabled for this account. You can still draft, edit, preview, and save shared mail.
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
            {dupWarning.warningGroups.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-amber-700">
                  Review sampled send clusters to see when they went out and who already received them:
                </p>
                <div className="space-y-2">
                  {dupWarning.warningGroups.map((group) => (
                    <details
                      key={group.key}
                      className="overflow-hidden rounded-md border border-amber-200 bg-white"
                    >
                      <summary className="cursor-pointer list-none px-3 py-2 hover:bg-amber-100/60">
                        <div className="flex flex-col gap-1 pr-6 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="font-medium text-amber-950">
                              {formatWarningTimestamp(group.receivedAt, group.date)}
                            </p>
                            <p className="text-xs text-amber-800">
                              {group.subject || (group.exactRecipientAddresses.length > 0 ? "This email" : "Another email")}
                            </p>
                          </div>
                          <div className="text-xs text-amber-800 sm:text-right">
                            <p>
                              {group.recipientAddresses.length.toLocaleString()} overlapping recipient
                              {group.recipientAddresses.length !== 1 ? "s" : ""}
                            </p>
                            <p>
                              {describeRecipientBucket(group)}
                            </p>
                          </div>
                        </div>
                      </summary>
                      <div className="border-t border-amber-200 px-3 py-3 text-xs text-amber-900">
                        {group.exactRecipientAddresses.length > 0 && (
                          <div className="space-y-1">
                            <p className="font-medium">Received this exact email</p>
                            <p className="break-words leading-5">
                              {group.exactRecipientAddresses.join(", ")}
                            </p>
                          </div>
                        )}
                        {group.otherRecentRecipientAddresses.length > 0 && (
                          <div className={group.exactRecipientAddresses.length > 0 ? "mt-3 space-y-1" : "space-y-1"}>
                            <p className="font-medium">Received another email recently</p>
                            <p className="break-words leading-5">
                              {group.otherRecentRecipientAddresses.join(", ")}
                            </p>
                          </div>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}
            {dupWarning.duplicateCount > dupWarning.sampledDuplicateCount && (
              <p className="text-xs text-amber-800">
                Showing a bounded sample of {dupWarning.warningSampleLimit.toLocaleString()} rows; duplicate removal is disabled for this large warning set.
              </p>
            )}
            <p className="text-xs font-medium text-amber-900">
              Continuing will {pendingQueueTarget === "sendNow" ? "queue and release this campaign now" : "queue this campaign and open the Queue tab"}.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDupWarning(null)}
                className="rounded-md border border-amber-300 bg-white px-4 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
              >
                Cancel
              </button>
              {canSend && canQueueWithoutDuplicates && (
                <button
                  type="button"
                  onClick={handleSendWithoutDuplicates}
                  disabled={sending}
                  className="rounded-md border border-amber-400 bg-amber-100 px-4 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-50"
                >
                  {sending
                    ? pendingQueueTarget === "sendNow" ? "Sending…" : "Queueing…"
                    : `Remove ${dupWarning.duplicateCount.toLocaleString()} duplicate${dupWarning.duplicateCount !== 1 ? "s" : ""} & ${pendingQueueTarget === "sendNow" ? "send now" : "queue"}`}
                </button>
              )}
              <button
                type="button"
                onClick={handleSendAnyway}
                disabled={sending || !canSend}
                className="rounded-md bg-amber-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
              >
                {sending
                  ? pendingQueueTarget === "sendNow" ? "Sending…" : "Queueing…"
                  : pendingQueueTarget === "sendNow" ? "Send anyway" : "Queue anyway"}
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
            onClick={handlePreview}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Preview
          </button>

          <button
            type="button"
            onClick={handleSendTest}
            disabled={sendingTest || !canSend}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {sendingTest ? "Sending test…" : "Send Test"}
          </button>

          <button
            type="button"
            onClick={() => void handleQueueOrSend("queue")}
            disabled={sending || !canSend}
            className="rounded-md bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {sending
              ? activeWorkflow === "queue"
                ? "Queueing…"
                : activeWorkflow === "directSend"
                  ? "Sending…"
                  : selectedList
                    ? "Queue"
                    : "Sending…"
              : selectedList
                ? "Queue"
                : "Send"}
          </button>

          {selectedList && (
            <button
              type="button"
              onClick={() => void handleQueueOrSend("sendNow")}
              disabled={sending || !canSend}
              className="rounded-md bg-green-700 px-5 py-2 text-sm font-semibold text-white hover:bg-green-800 disabled:opacity-50"
            >
              {sending && activeWorkflow === "sendNow" ? "Sending…" : "Send Now"}
            </button>
          )}

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

type EditorMode = "visual" | "html";

function RichHtmlEditor({
  initialHtml,
  onChange,
}: {
  initialHtml: string;
  onChange: () => void;
}) {
  const [mode, setMode] = useState<EditorMode>("visual");
  const [html, setHtml] = useState(initialHtml);
  const editorRef = useRef<HTMLDivElement>(null);
  const htmlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "visual" && editorRef.current && editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html;
    }
  }, [html, mode]);

  const updateHtml = (nextHtml: string) => {
    if (htmlInputRef.current) htmlInputRef.current.value = nextHtml;
    setHtml(nextHtml);
    onChange();
  };

  const runCommand = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    updateHtml(editorRef.current?.innerHTML ?? html);
  };

  const addLink = () => {
    const url = window.prompt("Enter the link URL");
    if (!url) return;
    runCommand("createLink", url);
  };

  return (
    <div>
      <div className="mb-1 flex items-end justify-between gap-3">
        <span className="text-sm font-medium text-slate-700">HTML</span>
        <div className="flex rounded-md border border-slate-300 bg-white p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode("visual")}
            className={`rounded px-2.5 py-1 font-medium ${
              mode === "visual" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            Visual
          </button>
          <button
            type="button"
            onClick={() => setMode("html")}
            className={`rounded px-2.5 py-1 font-medium ${
              mode === "html" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            HTML source
          </button>
        </div>
      </div>

      <input ref={htmlInputRef} type="hidden" name="html" value={html} />

      {mode === "visual" ? (
        <div className="overflow-hidden rounded-md border border-slate-300 bg-white">
          <div className="flex flex-wrap gap-1 border-b border-slate-200 bg-slate-50 p-2">
            <EditorToolbarButton label="Paragraph" onClick={() => runCommand("formatBlock", "p")}>
              <Pilcrow aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Heading" onClick={() => runCommand("formatBlock", "h2")}>
              <Heading2 aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Bold" onClick={() => runCommand("bold")}>
              <Bold aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Italic" onClick={() => runCommand("italic")}>
              <Italic aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Underline" onClick={() => runCommand("underline")}>
              <Underline aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Bullets" onClick={() => runCommand("insertUnorderedList")}>
              <List aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Numbered list" onClick={() => runCommand("insertOrderedList")}>
              <ListOrdered aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Link" onClick={addLink}>
              <LinkIcon aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Unlink" onClick={() => runCommand("unlink")}>
              <Unlink aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
            <EditorToolbarButton label="Clear format" onClick={() => runCommand("removeFormat")}>
              <Eraser aria-hidden="true" className="size-4" />
            </EditorToolbarButton>
          </div>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={(event) => updateHtml(event.currentTarget.innerHTML)}
            className="min-h-64 px-4 py-3 text-sm leading-6 text-slate-900 outline-none [&_a]:text-blue-700 [&_a]:underline [&_h2]:my-3 [&_h2]:text-xl [&_h2]:font-semibold [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6"
            aria-label="Email body visual editor"
          />
        </div>
      ) : (
        <textarea
          required
          rows={14}
          value={html}
          onChange={(event) => updateHtml(event.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono"
          aria-label="Email body HTML source"
        />
      )}
      <p className="mt-1 text-xs text-slate-500">
        Merge tags work in subject and body: {"{{firstName}}"}, {"{{name}}"}, {"{{email}}"}.
      </p>
    </div>
  );
}

function EditorToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="inline-flex size-9 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function getActionErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;

  if (err.message.includes("Server Components render")) {
    return "The server returned an internal error while sending this email. Please try again. If it keeps failing, contact support with the current timestamp.";
  }

  return err.message || fallback;
}

function formatWarningTimestamp(receivedAt: string | null, fallbackDate: string): string {
  if (!receivedAt) return fallbackDate;

  try {
    return new Date(receivedAt).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return fallbackDate;
  }
}

function describeRecipientBucket(group: WarningGroup): string {
  const parts: string[] = [];

  if (group.exactRecipientAddresses.length > 0) {
    parts.push(
      `${group.exactRecipientAddresses.length.toLocaleString()} exact duplicate${
        group.exactRecipientAddresses.length !== 1 ? "s" : ""
      }`,
    );
  }

  if (group.otherRecentRecipientAddresses.length > 0) {
    parts.push(
      `${group.otherRecentRecipientAddresses.length.toLocaleString()} recent${
        group.otherRecentRecipientAddresses.length !== 1 ? "s" : ""
      }`,
    );
  }

  return parts.join(" · ");
}
