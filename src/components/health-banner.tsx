"use client";

import { useEffect, useState } from "react";
import type { HealthCheck, HealthReport } from "@/app/api/health/route";

const DISMISSED_KEY = "health_banner_dismissed_v1";
const REPORT_CACHE_KEY = "health_banner_report_v1";
const REPORT_TTL_MS = 5 * 60 * 1000;
const HEALTH_FETCH_DELAY_MS = 1200;

type CachedReport = {
  savedAt: number;
  report: HealthReport;
};

function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function getInitialState() {
  const prev = readJson<{ critical?: number }>(DISMISSED_KEY);
  const cached = readJson<CachedReport>(REPORT_CACHE_KEY);
  const isFresh = cached && Date.now() - cached.savedAt < REPORT_TTL_MS;
  const report = isFresh ? cached.report : null;
  const dismissed = Boolean(
    report && prev && report.critical <= (prev.critical ?? 0),
  );
  return { report, dismissed, hasFreshCache: Boolean(isFresh) };
}

export function HealthBanner() {
  const [initialState] = useState(getInitialState);
  const [report, setReport] = useState<HealthReport | null>(initialState.report);
  const [dismissed, setDismissed] = useState(initialState.dismissed);
  const [expanded, setExpanded] = useState(false);
  const [checking, setChecking] = useState(!initialState.hasFreshCache);

  useEffect(() => {
    if (initialState.hasFreshCache) return;

    const prev = readJson<{ critical?: number }>(DISMISSED_KEY);
    const controller = new AbortController();
    const load = () => {
      fetch("/api/health", { signal: controller.signal })
        .then((r) => r.json())
        .then((data: HealthReport) => {
          setReport(data);
          sessionStorage.setItem(
            REPORT_CACHE_KEY,
            JSON.stringify({ savedAt: Date.now(), report: data }),
          );
          // Only dismiss if the user already dismissed AND critical count hasn't grown.
          if (prev && data.critical <= (prev.critical ?? 0)) {
            setDismissed(true);
          }
        })
        .catch(() => undefined)
        .finally(() => setChecking(false));
    };

    const timeout = window.setTimeout(load, HEALTH_FETCH_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [initialState.hasFreshCache]);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem(
      DISMISSED_KEY,
      JSON.stringify({ critical: report?.critical ?? 0 }),
    );
  };

  if (!report && checking) {
    return (
      <div className="border-b border-blue-100 bg-blue-50 text-sm text-blue-900">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-600" />
          <span className="font-medium">Checking production health...</span>
          <span className="text-xs text-blue-700">
            Waiting for queue, settings, and webhook readiness checks.
          </span>
        </div>
      </div>
    );
  }

  if (!report || (report.ok && report.warnings === 0)) return null;
  if (dismissed) return null;

  const failing = report.checks.filter((c) => !c.ok);
  const criticals = failing.filter((c) => c.severity === "critical");
  const warnings = failing.filter((c) => c.severity === "warning");
  const hasCritical = criticals.length > 0;

  return (
    <div
      className={`border-b text-sm ${
        hasCritical
          ? "border-red-200 bg-red-50 text-red-900"
          : "border-amber-200 bg-amber-50 text-amber-900"
      }`}
    >
      {/* ── Summary row ── */}
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
        <span className="text-base">{hasCritical ? "🔴" : "🟡"}</span>
        <span className="flex-1 font-medium">
          {hasCritical
            ? `${criticals.length} critical issue${criticals.length !== 1 ? "s" : ""} — some features will fail`
            : `${warnings.length} warning${warnings.length !== 1 ? "s" : ""} — some features are degraded`}
        </span>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="rounded px-2 py-0.5 text-xs font-medium underline underline-offset-2 hover:no-underline"
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
        <button
          onClick={handleDismiss}
          className="ml-1 rounded px-2 py-0.5 text-xs opacity-60 hover:opacity-100"
          title="Dismiss until next critical issue"
        >
          ✕
        </button>
      </div>

      {/* ── Detail panel ── */}
      {expanded && (
        <div className="mx-auto max-w-6xl space-y-3 px-4 pb-4 pt-1">
          {criticals.length > 0 && (
            <IssueGroup title="Critical — will cause errors" color="red" items={criticals} />
          )}
          {warnings.length > 0 && (
            <IssueGroup title="Warnings — degraded features" color="amber" items={warnings} />
          )}
          <p className="text-xs opacity-60">
            Tell Claude: &quot;Fix the health banner issues&quot; and paste what you see above.
          </p>
        </div>
      )}
    </div>
  );
}

function IssueGroup({
  title,
  color,
  items,
}: {
  title: string;
  color: "red" | "amber";
  items: HealthCheck[];
}) {
  return (
    <div>
      <p
        className={`mb-1 text-xs font-semibold uppercase tracking-wide ${
          color === "red" ? "text-red-700" : "text-amber-700"
        }`}
      >
        {title}
      </p>
      <div className="space-y-2">
        {items.map((c) => (
          <IssueRow key={c.id} check={c} color={color} />
        ))}
      </div>
    </div>
  );
}

function IssueRow({ check, color }: { check: HealthCheck; color: "red" | "amber" }) {
  const [showFix, setShowFix] = useState(false);

  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        color === "red"
          ? "border-red-200 bg-white/60"
          : "border-amber-200 bg-white/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">{check.label}</span>
          <span className="mx-2 opacity-40">·</span>
          <span className="opacity-80">{check.message}</span>
        </div>
        {check.fix && (
          <button
            onClick={() => setShowFix((s) => !s)}
            className="shrink-0 text-xs underline underline-offset-2 hover:no-underline"
          >
            {showFix ? "hide fix" : "how to fix"}
          </button>
        )}
      </div>
      {showFix && check.fix && (
        <pre className="mt-2 whitespace-pre-wrap rounded bg-black/5 p-2 font-mono text-xs leading-relaxed">
          {check.fix}
        </pre>
      )}
    </div>
  );
}
