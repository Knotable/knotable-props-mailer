"use client";

import Link from "next/link";
import { Clock3, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  CAMPAIGN_ANALYTICS_METRICS,
  emptyCampaignAnalyticsSnapshot,
  isCampaignAnalyticsFresh,
  metricRate,
  type CampaignAnalyticsMetric,
  type CampaignAnalyticsSnapshot,
} from "@/lib/lazyAnalytics";

export type CampaignAnalyticsSeed = {
  emailId: string;
  subject: string;
  status: string;
  createdAt: string | null;
};

type RowState = {
  snapshot: CampaignAnalyticsSnapshot | null;
  status: "waiting" | "loading" | "ready" | "error";
  loadingMetric: CampaignAnalyticsMetric | null;
  error: string | null;
};

type MetricResponse = {
  metric?: CampaignAnalyticsMetric;
  values?: Partial<CampaignAnalyticsSnapshot>;
  error?: string;
  code?: string | null;
};

const CACHE_PREFIX = "props-mailer:campaign-analytics:v1:";

function cacheKey(emailId: string) {
  return `${CACHE_PREFIX}${emailId}`;
}

function readCachedSnapshot(emailId: string): CampaignAnalyticsSnapshot | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(cacheKey(emailId)) ?? "null") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const snapshot = value as CampaignAnalyticsSnapshot;
    return typeof snapshot.refreshedAt === "string" ? snapshot : null;
  } catch {
    return null;
  }
}

function latestTimestamp(left: string | null, right: string | null | undefined) {
  if (!left) return right ?? null;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function formatMetric(value: number | null, zeroAsDash = false) {
  if (value === null) return "—";
  if (zeroAsDash && value === 0) return "—";
  return value.toLocaleString();
}

function formatAge(timestamp: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function CampaignAnalyticsList({ campaigns }: { campaigns: CampaignAnalyticsSeed[] }) {
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      campaigns.map((campaign) => [
        campaign.emailId,
        { snapshot: null, status: "waiting", loadingMetric: null, error: null } satisfies RowState,
      ]),
    ),
  );
  const [queue, setQueue] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState(Date.now());
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const nextQueue: string[] = [];
    const nextRows: Record<string, RowState> = {};
    for (const campaign of campaigns) {
      const cached = readCachedSnapshot(campaign.emailId);
      const fresh = cached ? isCampaignAnalyticsFresh(cached) : false;
      nextRows[campaign.emailId] = {
        snapshot: cached,
        status: fresh ? "ready" : "waiting",
        loadingMetric: null,
        error: null,
      };
      if (!fresh) nextQueue.push(campaign.emailId);
    }
    setRows(nextRows);
    setQueue(nextQueue);
    setHydrated(true);
  }, [campaigns]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hydrated || activeId || queue.length === 0) return;
    const emailId = queue[0];
    setQueue((current) => current.slice(1));
    setActiveId(emailId);
    const controller = new AbortController();
    controllerRef.current = controller;

    const refresh = async () => {
      let snapshot = rows[emailId]?.snapshot ?? emptyCampaignAnalyticsSnapshot();
      setRows((current) => ({
        ...current,
        [emailId]: { ...current[emailId], status: "loading", loadingMetric: "queue", error: null },
      }));

      try {
        for (const metric of CAMPAIGN_ANALYTICS_METRICS) {
          setRows((current) => ({
            ...current,
            [emailId]: { ...current[emailId], status: "loading", loadingMetric: metric, error: null },
          }));
          const response = await fetch(
            `/api/email/analytics/${encodeURIComponent(emailId)}?metric=${metric}`,
            { cache: "no-store", signal: controller.signal },
          );
          const payload = (await response.json()) as MetricResponse;
          if (!response.ok || !payload.values) {
            throw new Error(
              payload.code ? `${payload.error ?? "Refresh failed"} (${payload.code})` : payload.error ?? "Refresh failed",
            );
          }
          const values: Partial<CampaignAnalyticsSnapshot> = payload.values;
          snapshot = {
            ...snapshot,
            ...values,
            lastActivityAt: latestTimestamp(snapshot.lastActivityAt, values.lastActivityAt),
          };
          setRows((current) => ({
            ...current,
            [emailId]: {
              ...current[emailId],
              snapshot,
              status: "loading",
              loadingMetric: metric,
              error: null,
            },
          }));
        }

        snapshot = { ...snapshot, refreshedAt: new Date().toISOString() };
        window.localStorage.setItem(cacheKey(emailId), JSON.stringify(snapshot));
        setRows((current) => ({
          ...current,
          [emailId]: { snapshot, status: "ready", loadingMetric: null, error: null },
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        setRows((current) => ({
          ...current,
          [emailId]: {
            ...current[emailId],
            snapshot,
            status: "error",
            loadingMetric: null,
            error: error instanceof Error ? error.message : "Refresh failed",
          },
        }));
      } finally {
        if (!controller.signal.aborted) {
          controllerRef.current = null;
          setActiveId(null);
        }
      }
    };

    void refresh();
  }, [activeId, hydrated, queue, rows]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const requestRefresh = (emailId: string) => {
    if (activeId === emailId) return;
    setRows((current) => ({
      ...current,
      [emailId]: { ...current[emailId], status: "waiting", loadingMetric: null, error: null },
    }));
    setQueue((current) => [emailId, ...current.filter((queuedId) => queuedId !== emailId)]);
  };

  if (campaigns.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
        No campaigns sent yet.
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
        Campaigns refresh sequentially while this page remains open. Browser-cached results remain visible for 15 minutes;
        every row shows when it was refreshed and can be moved to the front with <strong>Update now</strong>.
      </div>

      <div className="space-y-3 md:hidden">
        {campaigns.map((campaign) => {
          const row = rows[campaign.emailId];
          const snapshot = row?.snapshot;
          return (
            <article key={campaign.emailId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/email/sends/${campaign.emailId}`} className="break-words text-sm font-semibold text-slate-900 hover:text-blue-700 hover:underline">
                    {campaign.subject || "Untitled campaign"}
                  </Link>
                  <p className="mt-1 truncate text-xs text-slate-500">{snapshot?.listName ?? "List pending"}</p>
                </div>
                <StatusBadge status={campaign.status} />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <MiniMetric label="sent" value={snapshot?.sent ?? null} tone="green" />
                <MiniMetric label="opened" value={snapshot?.opened ?? null} tone="blue" />
                <MiniMetric label="clicked" value={snapshot?.clicked ?? null} tone="blue" />
                <MiniMetric label="pending" value={snapshot?.pending ?? null} tone="amber" />
                <MiniMetric label="failed" value={snapshot?.failed ?? null} tone="red" />
                <MiniMetric label="bounced" value={snapshot?.bounced ?? null} tone="amber" />
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <RatePill label="open" value={metricRate(snapshot?.opened ?? null, snapshot?.sent ?? null)} />
                <RatePill label="click" value={metricRate(snapshot?.clicked ?? null, snapshot?.sent ?? null)} />
                <RatePill label="bounce" value={metricRate(snapshot?.bounced ?? null, snapshot?.sent ?? null)} />
              </div>
              <RefreshControl row={row} now={now} onRefresh={() => requestRefresh(campaign.emailId)} />
            </article>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 md:block">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">List</th>
              <th className="px-4 py-3 text-right">SES accepted</th>
              <th className="px-4 py-3 text-right">Delivered</th>
              <th className="px-4 py-3 text-right">Pending</th>
              <th className="px-4 py-3 text-right">Failed</th>
              <th className="px-4 py-3 text-right">Opens</th>
              <th className="px-4 py-3 text-right">Clicks</th>
              <th className="px-4 py-3 text-right">Bounces</th>
              <th className="px-4 py-3 text-right">Complaints</th>
              <th className="px-4 py-3">Refresh</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {campaigns.map((campaign) => {
              const row = rows[campaign.emailId];
              const snapshot = row?.snapshot;
              return (
                <tr key={campaign.emailId} className="bg-white hover:bg-slate-50">
                  <td className="max-w-xs truncate px-4 py-3 font-medium text-slate-800">
                    <Link href={`/email/sends/${campaign.emailId}`} className="hover:text-blue-700 hover:underline">
                      {campaign.subject || <span className="italic text-slate-400">untitled</span>}
                    </Link>
                  </td>
                  <td className="max-w-48 truncate px-4 py-3 text-slate-600">{snapshot?.listName ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatMetric(snapshot?.sent ?? null)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatMetric(snapshot?.delivered ?? null)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatMetric(snapshot?.pending ?? null, true)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatMetric(snapshot?.failed ?? null, true)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatMetric(snapshot?.opened ?? null)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatMetric(snapshot?.clicked ?? null)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatMetric(snapshot?.bounced ?? null, true)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatMetric(snapshot?.complained ?? null, true)}</td>
                  <td className="min-w-44 px-4 py-3"><RefreshControl row={row} now={now} onRefresh={() => requestRefresh(campaign.emailId)} compact /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RefreshControl({ row, now, onRefresh, compact = false }: { row: RowState | undefined; now: number; onRefresh: () => void; compact?: boolean }) {
  const loading = row?.status === "loading";
  const waiting = row?.status === "waiting";
  const label = loading
    ? `Loading ${row.loadingMetric ?? "stats"}…`
    : waiting
      ? "Waiting to refresh"
      : row?.status === "error"
        ? `Refresh failed${row.error ? `: ${row.error}` : ""}`
        : row?.snapshot
          ? `Updated ${formatAge(row.snapshot.refreshedAt, now)}`
          : "Not updated";
  return (
    <div className={`${compact ? "" : "mt-4 border-t border-slate-100 pt-3"} flex flex-wrap items-center justify-between gap-2 text-xs`} aria-live="polite">
      <span className={`inline-flex min-w-0 items-center gap-1.5 ${row?.status === "error" ? "text-amber-700" : "text-slate-500"}`} title={row?.error ?? undefined}>
        {loading ? <RefreshCw className="size-3.5 shrink-0 animate-spin text-blue-600" /> : <Clock3 className="size-3.5 shrink-0" />}
        <span className={compact ? "max-w-36 truncate" : ""}>{label}</span>
      </span>
      <button type="button" onClick={onRefresh} disabled={loading} className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
        {row?.status === "error" ? "Retry" : waiting ? "Queued" : "Update now"}
      </button>
    </div>
  );
}

function MiniMetric({ label, value, tone }: { label: string; value: number | null; tone: "green" | "blue" | "amber" | "red" }) {
  const toneClasses = { green: "text-emerald-700", blue: "text-blue-700", amber: "text-amber-700", red: "text-red-700" };
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-2">
      <p className={`text-base font-semibold tabular-nums ${toneClasses[tone]}`}>{formatMetric(value)}</p>
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
    </div>
  );
}

function RatePill({ label, value }: { label: string; value: number | null }) {
  return <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 font-medium text-slate-600">{label} {value === null ? "—" : `${value}%`}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const statusClass = status === "sent" ? "bg-emerald-50 text-emerald-700" : status === "queued" || status === "sending" ? "bg-blue-50 text-blue-700" : status === "failed" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600";
  return <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${statusClass}`}>{status}</span>;
}
