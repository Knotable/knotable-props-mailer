"use client";

import { useEffect, useState } from "react";

type EmailPreviewProps = {
  id: string;
  subject: string;
};

export function EmailPreview({ id, subject }: EmailPreviewProps) {
  const [hovered, setHovered] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const previewUrl = `/api/email/preview/${encodeURIComponent(id)}`;

  useEffect(() => {
    if (!fullscreen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen]);

  return (
    <>
      <div
        className="relative shrink-0 self-start"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label={`Preview email: ${subject || "no subject"}`}
          className="group relative flex h-16 w-24 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm outline-none ring-blue-500 transition hover:border-blue-300 hover:shadow-md focus-visible:ring-2"
          onClick={() => setFullscreen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setFullscreen(true);
            }
          }}
        >
          <iframe
            src={previewUrl}
            title={`${subject || "Email"} thumbnail`}
            sandbox="allow-same-origin"
            tabIndex={-1}
            className="pointer-events-none h-[420px] w-[640px] origin-top-left scale-[.15]"
          />
          <span className="absolute inset-0 flex items-center justify-center bg-slate-900/0 text-[10px] font-semibold text-white opacity-0 transition group-hover:bg-slate-900/35 group-hover:opacity-100">
            View preview
          </span>
        </div>

        {hovered && (
          <div className="absolute left-0 top-full z-40 pt-2">
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              className="block w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white p-2 text-left shadow-2xl outline-none ring-blue-500 focus-visible:ring-2"
              aria-label={`Open fullscreen preview for ${subject || "email"}`}
            >
              <iframe
                src={previewUrl}
                title={`${subject || "Email"} hover preview`}
                sandbox="allow-same-origin"
                tabIndex={-1}
                className="pointer-events-none h-80 w-full border-0 bg-white"
              />
              <span className="block px-1 pt-2 text-xs font-semibold text-slate-700">
                Click to open fullscreen
              </span>
            </button>
          </div>
        )}
      </div>

      {fullscreen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/75 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={`Fullscreen email preview: ${subject || "no subject"}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFullscreen(false);
          }}
        >
          <div className="flex h-full max-h-[min(900px,92vh)] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
              <p className="min-w-0 truncate text-sm font-semibold text-slate-800">
                {subject || "(no subject)"}
              </p>
              <button
                type="button"
                onClick={() => setFullscreen(false)}
                className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
            <iframe
              src={previewUrl}
              title={`${subject || "Email"} fullscreen preview`}
              sandbox="allow-same-origin"
              className="min-h-0 w-full flex-1 border-0 bg-white"
            />
          </div>
        </div>
      )}
    </>
  );
}
