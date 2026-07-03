"use client";

import { Clock3, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

type DataFreshnessProps = {
  timestamp: string | null | undefined;
  loading?: boolean;
  className?: string;
};

function relativeAge(timestamp: string, now: number) {
  const ageMs = Math.max(0, now - new Date(timestamp).getTime());
  const minutes = Math.floor(ageMs / 60_000);

  if (minutes < 1) return { compact: "now", label: "just now" };
  if (minutes < 60) {
    return {
      compact: `${minutes}m`,
      label: `${minutes} minute${minutes === 1 ? "" : "s"} ago`,
    };
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return {
      compact: `${hours}h`,
      label: `${hours} hour${hours === 1 ? "" : "s"} ago`,
    };
  }

  const days = Math.floor(hours / 24);
  return {
    compact: `${days}d`,
    label: `${days} day${days === 1 ? "" : "s"} ago`,
  };
}

export function DataFreshness({ timestamp, loading = false, className = "" }: DataFreshnessProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const age = timestamp && now !== null ? relativeAge(timestamp, now) : { compact: "--", label: "recently" };
  const Icon = loading ? RefreshCw : Clock3;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/70 px-2 py-0.5 text-xs font-medium normal-case tracking-normal text-slate-500 ${className}`}
      title={timestamp ? `Data generated ${new Date(timestamp).toLocaleString()}` : "Data timestamp unavailable"}
      aria-label={loading ? `Refreshing data, last updated ${age.label}` : `Data updated ${age.label}`}
    >
      <Icon
        aria-hidden="true"
        className={`size-3.5 shrink-0 ${loading ? "animate-spin text-blue-600" : "text-slate-400"}`}
      />
      <span aria-hidden="true">{loading ? "sync" : age.compact}</span>
    </span>
  );
}
