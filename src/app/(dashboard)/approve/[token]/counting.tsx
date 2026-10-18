"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function CountingSpinner({ className = "", label = "Counting recipients…" }: { className?: string; label?: string }) {
  return (
    <div role="status" aria-live="polite" className={`flex items-center gap-2 py-2 text-sm text-slate-600 ${className}`}>
      <Loader2 aria-hidden="true" className="size-5 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

// The database was too busy for ~40 s; keep spinning and retry automatically.
export function RetryCountSoon({ className = "" }: { className?: string }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setTimeout(() => router.refresh(), 4_000);
    return () => clearTimeout(timer);
  }, [router]);
  return <CountingSpinner className={className} label="Database is busy — still counting recipients…" />;
}
