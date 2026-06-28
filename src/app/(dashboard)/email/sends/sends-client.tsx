"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { requeueDeadAction } from "../actions";
import { ProgressStatus } from "@/components/progress-status";

type SendItem = {
  email_id: string;
  subject: string;
  from_address: string;
  status: string;
  sent: number | null;
  failed: number | null;
  pending: number | null;
  canceled: number | null;
  opens: number | null;
  opensStale: boolean;
  countStale: {
    sent: boolean;
    failed: boolean;
    pending: boolean;
    canceled: boolean;
  };
  first_sent: string | null;
  last_queued_at: string | null;
  lists: {
    id: string;
    name: string;
    address: string;
    updated_at: string | null;
    memberCount: number;
    memberEmails: string[];
  }[];
  recipientSamples: {
    email: string;
    status: string | null;
    sendDate: string | null;
    lastError: string | null;
  }[];
  recipientSamplesPartial: boolean;
  created_at: string | null;
};

type PreviewMode = "html" | "source" | null;

export function SendsClient({ sends }: { sends: SendItem[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<Record<string, PreviewMode>>({});
  const [sourceContent, setSourceContent] = useState<Record<string, string>>({});
  const [loadingSource, setLoadingSource] = useState<Record<string, boolean>>({});
  const [loadingPreview, setLoadingPreview] = useState<Record<string, boolean>>({});
  const [openRecipients, setOpenRecipients] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => (prev === id ? null : id));
  };

  const setMode = async (id: string, mode: PreviewMode) => {
    setPreviewMode((prev) => ({ ...prev, [id]: mode }));
    if (mode === "html") {
      setLoadingPreview((prev) => ({ ...prev, [id]: true }));
    }

    if (mode === "source" && !sourceContent[id]) {
      setLoadingSource((prev) => ({ ...prev, [id]: true }));
      try {
        const res = await fetch(`/api/email/preview/${id}?mode=source`);
        const text = await res.text();
        setSourceContent((prev) => ({ ...prev, [id]: text }));
      } catch {
        setSourceContent((prev) => ({ ...prev, [id]: "Failed to load source." }));
      } finally {
        setLoadingSource((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  if (sends.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
        No emails have been queued or sent yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sends.map((send) => {
        const isOpen = expanded === send.email_id;
        const mode = previewMode[send.email_id] ?? null;
        const knownCounts =
          send.sent !== null &&
          send.failed !== null &&
          send.pending !== null &&
          send.canceled !== null;
        const total = knownCounts
          ? (send.sent ?? 0) +
            (send.failed ?? 0) +
            (send.pending ?? 0) +
            (send.canceled ?? 0)
          : null;
        const totalStale = Object.values(send.countStale).some(Boolean);

        return (
          <div
            key={send.email_id}
            className="rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            {/* ── Row header ── */}
            <div className="flex flex-col gap-4 px-5 py-4 transition-colors hover:bg-slate-50 lg:flex-row lg:items-start">
              <a
                href={`/api/email/preview/${send.email_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block h-28 w-full shrink-0 overflow-hidden rounded-md border border-slate-200 bg-white shadow-inner focus:outline-none focus:ring-2 focus:ring-slate-400 sm:w-40"
                aria-label={`Open preview for ${send.subject}`}
              >
                <iframe
                  src={`/api/email/preview/${send.email_id}`}
                  loading="lazy"
                  className="pointer-events-none origin-top-left scale-[0.24] border-0"
                  style={{ width: "667px", height: "467px" }}
                  title={`Thumbnail: ${send.subject}`}
                  sandbox="allow-same-origin"
                />
              </a>

              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                  <button
                    onClick={() => toggleExpand(send.email_id)}
                    className="mt-0.5 shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Collapse send details" : "Expand send details"}
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                  <div className="min-w-0">
                    <button
                      onClick={() => toggleExpand(send.email_id)}
                      className="block max-w-full truncate text-left font-semibold text-slate-800 hover:text-blue-700 hover:underline"
                    >
                      {send.subject}
                    </button>
                    <p className="mt-0.5 text-xs text-slate-500">
                      From: {send.from_address || "unknown sender"}
                      {send.first_sent && <> · Sent {formatDate(send.first_sent)}</>}
                      {!send.first_sent && send.last_queued_at && (
                        <> · Queued {formatDate(send.last_queued_at)}</>
                      )}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    href={`/api/email/preview/${send.email_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:border-blue-300 hover:text-blue-700"
                  >
                    Open preview
                  </a>
                  <button
                    onClick={() => {
                      setExpanded(send.email_id);
                      void setMode(send.email_id, "html");
                    }}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Inline preview
                  </button>
                  {send.lists.length > 0 || send.recipientSamples.length > 0 || total !== null ? (
                    <RecipientDetailsPopover
                      send={send}
                      total={total}
                      open={openRecipients === send.email_id}
                      onOpen={() => setOpenRecipients(send.email_id)}
                      onClose={() =>
                        setOpenRecipients((prev) => (prev === send.email_id ? null : prev))
                      }
                    />
                  ) : (
                    <span className="text-xs text-slate-400">No recipients recorded</span>
                  )}
                </div>
              </div>

              <div className="shrink-0 text-right">
                <div className="flex gap-3 text-xs">
                  <CountMetric
                    value={send.sent}
                    stale={send.countStale.sent}
                    label="sent"
                    className="text-green-700"
                    alwaysShow
                  />
                  <CountMetric
                    value={send.opens}
                    stale={send.opensStale}
                    label="opened"
                    className="text-blue-700"
                    alwaysShow
                    title="Unique recipients with an open event. Older sends before tracking was added can show 0."
                  />
                  <CountMetric
                    value={send.failed}
                    stale={send.countStale.failed}
                    label="failed"
                    className="text-red-600"
                  />
                  <CountMetric
                    value={send.pending}
                    stale={send.countStale.pending}
                    label="pending"
                    className="text-amber-600"
                  />
                  <CountMetric
                    value={send.canceled}
                    stale={send.countStale.canceled}
                    label="canceled"
                    className="text-slate-500"
                  />
                </div>
                {total !== null && total > 0 && (
                  <p className="mt-0.5 inline-flex items-center justify-end gap-1 text-xs text-slate-400">
                    <span>{total.toLocaleString()}</span>
                    {totalStale && <InlineSpinner />}
                    <span>total recipients</span>
                  </p>
                )}
              </div>
            </div>

            {/* ── Expanded panel ── */}
            {isOpen && (
              <div className="border-t border-slate-200">
                {/* Tab bar */}
                <div className="flex gap-0 border-b border-slate-200 bg-slate-50 px-5">
                  <TabButton
                    active={mode === "html"}
                    onClick={() => setMode(send.email_id, mode === "html" ? null : "html")}
                  >
                    Preview
                  </TabButton>
                  <TabButton
                    active={mode === "source"}
                    onClick={() => setMode(send.email_id, mode === "source" ? null : "source")}
                  >
                    Source
                  </TabButton>
                  <a
                    href={`/api/email/preview/${send.email_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 text-xs text-slate-500 hover:text-slate-700 transition-colors"
                  >
                    Open in tab ↗
                  </a>
                </div>

                {/* Preview content */}
                {mode === "html" && (
                  <div className="bg-white">
                    {loadingPreview[send.email_id] && (
                      <div className="p-4">
                        <ProgressStatus
                          title="Loading rendered email preview"
                          detail="Waiting for the preview route to render this email HTML."
                          tone="slate"
                        />
                      </div>
                    )}
                    <iframe
                      src={`/api/email/preview/${send.email_id}`}
                      className="w-full border-0"
                      style={{ height: "520px" }}
                      title={`Preview: ${send.subject}`}
                      sandbox="allow-same-origin"
                      onLoad={() =>
                        setLoadingPreview((prev) => ({ ...prev, [send.email_id]: false }))
                      }
                    />
                  </div>
                )}

                {mode === "source" && (
                  <div className="bg-slate-950 p-4 overflow-auto max-h-96">
                    {loadingSource[send.email_id] ? (
                      <ProgressStatus
                        title="Loading email source"
                        detail="Fetching the raw HTML from the preview API."
                        tone="slate"
                      />
                    ) : (
                      <pre className="text-xs text-green-400 whitespace-pre-wrap break-all font-mono">
                        {sourceContent[send.email_id] ?? ""}
                      </pre>
                    )}
                  </div>
                )}

                {/* Send details + actions */}
                <div className="px-5 py-3 bg-slate-50 text-xs text-slate-500 flex flex-wrap items-center gap-4 border-t border-slate-100">
                  <span>ID: <code className="font-mono text-slate-700">{send.email_id}</code></span>
                  <span>Status: <code className="font-mono text-slate-700">{send.status}</code></span>
                  {send.first_sent && <span>First sent: {send.first_sent}</span>}
                  <span>
                    Lists:{" "}
                    {send.lists.length
                      ? send.lists.map((l) => `${l.name} (${l.address})`).join(", ")
                      : "none recorded"}
                  </span>
                  <span>
                    Recipients sampled:{" "}
                    <code className="font-mono text-slate-700">
                      {send.recipientSamples.length.toLocaleString()}
                    </code>
                    {send.recipientSamplesPartial && " (partial)"}
                  </span>

                  {/* Requeue dead rows button — only shown when there are failures */}
                  {send.failed !== null && send.failed > 0 && (
                    <span className="ml-auto">
                      <RequeueDeadButton emailId={send.email_id} failedCount={send.failed} />
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RecipientDetailsPopover({
  send,
  total,
  open,
  onOpen,
  onClose,
}: {
  send: SendItem;
  total: number | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const remainder =
    total !== null ? Math.max(0, total - send.recipientSamples.length) : null;

  return (
    <span
      className="relative inline-block"
      onMouseEnter={onOpen}
      onMouseLeave={onClose}
      onFocus={onOpen}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        onClose();
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
        aria-expanded={open}
      >
        Recipients
        {total !== null && <span className="text-slate-400">{total.toLocaleString()}</span>}
      </button>
      {open && (
        <span className="absolute left-0 top-full z-50 mt-1 block w-[28rem] max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-3 text-left shadow-xl">
          <span className="flex items-start justify-between gap-3">
            <span className="block">
              <span className="block text-sm font-semibold text-slate-900">Recipients</span>
              <span className="block text-xs text-slate-500">
                {total !== null
                  ? `${total.toLocaleString()} queued recipient${total === 1 ? "" : "s"}`
                  : "Queued recipient sample"}
              </span>
            </span>
            {send.lists.length > 0 && (
              <span className="rounded bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600">
                {send.lists.length.toLocaleString()} list{send.lists.length === 1 ? "" : "s"}
              </span>
            )}
          </span>

          <span className="mt-3 block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Lists
            </span>
            {send.lists.length > 0 ? (
              <span className="block space-y-2">
                {send.lists.map((list) => {
                  const remainingMembers = Math.max(0, list.memberCount - list.memberEmails.length);

                  return (
                    <span key={list.id} className="block rounded-md border border-slate-100 bg-slate-50 p-2">
                      <span className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <Link
                            href={`/lists/${list.id}`}
                            className="block truncate text-xs font-semibold text-slate-800 hover:text-blue-700 hover:underline"
                          >
                            {list.name}
                          </Link>
                          <span className="block truncate text-[11px] text-slate-500">
                            {list.address}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-semibold text-slate-700">
                          {list.memberCount.toLocaleString()}
                        </span>
                      </span>
                      {list.memberEmails.length > 0 ? (
                        <span className="mt-2 block max-h-24 overflow-y-auto">
                          {list.memberEmails.map((email) => (
                            <span key={email} className="block truncate text-[11px] text-slate-600">
                              {email}
                            </span>
                          ))}
                          {remainingMembers > 0 && (
                            <span className="block text-[11px] text-slate-400">
                              +{remainingMembers.toLocaleString()} more
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="mt-2 block text-[11px] text-slate-400">
                          No active recipient sample found.
                        </span>
                      )}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span className="text-xs text-slate-400">No source list recorded for this send.</span>
            )}
          </span>

          <span className="mt-3 block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Actual queued recipients
            </span>
            {send.recipientSamples.length > 0 ? (
              <span className="block max-h-44 overflow-y-auto">
                {send.recipientSamples.map((sample, index) => (
                  <span
                    key={`${sample.email}:${sample.status ?? "unknown"}:${index}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 py-0.5 text-xs"
                  >
                    <span className="truncate text-slate-700">{sample.email}</span>
                    <span className={statusClassName(sample.status)}>
                      {sample.status ?? "unknown"}
                    </span>
                    {sample.lastError && (
                      <span className="col-span-2 truncate text-red-600">
                        {sample.lastError}
                      </span>
                    )}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-xs text-slate-400">No queue recipient sample loaded.</span>
            )}
          </span>
          {remainder !== null && remainder > 0 && (
            <span className="mt-2 block text-xs text-slate-400">
              +{remainder.toLocaleString()} more
            </span>
          )}
          {send.recipientSamplesPartial && (
            <span className="mt-2 block text-xs text-amber-600">
              Recipient sample query timed out before all details loaded.
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function statusClassName(status: string | null) {
  if (status === "succeeded") return "font-medium text-green-700";
  if (status === "failed" || status === "dead") return "font-medium text-red-600";
  if (status === "pending" || status === "processing") return "font-medium text-amber-600";
  if (status === "canceled") return "font-medium text-slate-500";
  return "font-medium text-slate-400";
}

function RequeueDeadButton({ emailId, failedCount }: { emailId: string; failedCount: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleRequeue = () => {
    setResult(null);
    const fd = new FormData();
    fd.set("emailId", emailId);
    startTransition(async () => {
      try {
        const res = await requeueDeadAction(fd);
        setResult({ ok: true, message: `Requeued ${res.requeued} failed item(s)` });
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : "Requeue failed",
        });
      }
    });
  };

  return (
    <span className="flex items-center gap-2">
      {pending && (
        <span className="text-xs text-amber-700">
          Resetting failed queue rows so the worker can retry them...
        </span>
      )}
      {result && (
        <span className={result.ok ? "text-green-700" : "text-red-700"}>
          {result.message}
        </span>
      )}
      <button
        onClick={handleRequeue}
        disabled={pending}
        className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
      >
        {pending ? "Requeueing…" : `Requeue ${failedCount} failed`}
      </button>
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
        active
          ? "border-slate-800 text-slate-800"
          : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return dateStr;
  }
}

function formatCount(value: number | null): string {
  return value === null ? "..." : value.toLocaleString();
}

function CountMetric({
  value,
  stale,
  label,
  className,
  alwaysShow = false,
  title,
}: {
  value: number | null;
  stale: boolean;
  label: string;
  className: string;
  alwaysShow?: boolean;
  title?: string;
}) {
  if (!alwaysShow && !stale && (value === null || value <= 0)) return null;

  return (
    <span className={`inline-flex items-center gap-1 font-medium ${className}`} title={title}>
      {value !== null ? <span>{formatCount(value)}</span> : !stale && <span>...</span>}
      {stale && <InlineSpinner />}
      <span>{label}</span>
    </span>
  );
}

function InlineSpinner() {
  return (
    <span
      aria-label="Updating"
      className="inline-block size-3 animate-spin rounded-full border-2 border-amber-500 border-t-transparent align-[-1px]"
    />
  );
}
