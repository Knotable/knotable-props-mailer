"use client";

import { useState } from "react";

type SendItem = {
  email_id: string;
  subject: string;
  from_address: string;
  status: string;
  sent: number;
  failed: number;
  pending: number;
  first_sent: string | null;
  lists: { id: string; name: string; address: string }[];
  created_at: string | null;
};

type PreviewMode = "html" | "source" | null;

export function SendsClient({ sends }: { sends: SendItem[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<Record<string, PreviewMode>>({});
  const [sourceContent, setSourceContent] = useState<Record<string, string>>({});
  const [loadingSource, setLoadingSource] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) => {
    setExpanded((prev) => (prev === id ? null : id));
  };

  const setMode = async (id: string, mode: PreviewMode) => {
    setPreviewMode((prev) => ({ ...prev, [id]: mode }));

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
        const total = send.sent + send.failed + send.pending;

        return (
          <div
            key={send.email_id}
            className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
          >
            {/* ── Row header ── */}
            <button
              onClick={() => toggleExpand(send.email_id)}
              className="w-full text-left px-5 py-4 flex items-start gap-4 hover:bg-slate-50 transition-colors"
            >
              {/* Chevron */}
              <span className="mt-0.5 text-slate-400 shrink-0">
                {isOpen ? "▾" : "▸"}
              </span>

              {/* Main info */}
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-slate-800 truncate">{send.subject}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  From: {send.from_address}
                  {send.first_sent && (
                    <> · Sent {formatDate(send.first_sent)}</>
                  )}
                </p>
                {send.lists.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {send.lists.map((l) => (
                      <span
                        key={l.id}
                        className="inline-block text-xs bg-slate-100 text-slate-600 rounded px-2 py-0.5"
                      >
                        {l.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Stats */}
              <div className="shrink-0 text-right">
                <div className="flex gap-3 text-xs">
                  <span className="text-green-700 font-medium">
                    {send.sent.toLocaleString()} sent
                  </span>
                  {send.failed > 0 && (
                    <span className="text-red-600 font-medium">
                      {send.failed.toLocaleString()} failed
                    </span>
                  )}
                  {send.pending > 0 && (
                    <span className="text-amber-600 font-medium">
                      {send.pending.toLocaleString()} pending
                    </span>
                  )}
                </div>
                {total > 0 && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    {total.toLocaleString()} total recipients
                  </p>
                )}
              </div>
            </button>

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
                    <iframe
                      src={`/api/email/preview/${send.email_id}`}
                      className="w-full border-0"
                      style={{ height: "520px" }}
                      title={`Preview: ${send.subject}`}
                      sandbox="allow-same-origin"
                    />
                  </div>
                )}

                {mode === "source" && (
                  <div className="bg-slate-950 p-4 overflow-auto max-h-96">
                    {loadingSource[send.email_id] ? (
                      <p className="text-slate-400 text-xs">Loading…</p>
                    ) : (
                      <pre className="text-xs text-green-400 whitespace-pre-wrap break-all font-mono">
                        {sourceContent[send.email_id] ?? ""}
                      </pre>
                    )}
                  </div>
                )}

                {/* Send details */}
                <div className="px-5 py-3 bg-slate-50 text-xs text-slate-500 flex flex-wrap gap-4 border-t border-slate-100">
                  <span>ID: <code className="font-mono text-slate-700">{send.email_id}</code></span>
                  <span>Status: <code className="font-mono text-slate-700">{send.status}</code></span>
                  {send.first_sent && <span>First sent: {send.first_sent}</span>}
                  {send.lists.length > 0 && (
                    <span>
                      Lists: {send.lists.map((l) => `${l.name} (${l.address})`).join(", ")}
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
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}
