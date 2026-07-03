import { Loader2 } from "lucide-react";

type ProgressStatusProps = {
  title: string;
  detail?: string;
  tone?: "blue" | "slate" | "amber";
};

export function ProgressStatus({
  title,
  detail,
  tone = "blue",
}: ProgressStatusProps) {
  const tones = {
    blue: {
      border: "border-blue-200",
      bg: "bg-blue-50",
      text: "text-blue-900",
      muted: "text-blue-700",
      bar: "bg-blue-600",
    },
    slate: {
      border: "border-slate-200",
      bg: "bg-slate-50",
      text: "text-slate-900",
      muted: "text-slate-600",
      bar: "bg-slate-700",
    },
    amber: {
      border: "border-amber-200",
      bg: "bg-amber-50",
      text: "text-amber-900",
      muted: "text-amber-700",
      bar: "bg-amber-600",
    },
  };
  const color = tones[tone];

  return (
    <div
      role="status"
      aria-live="polite"
      className={`overflow-hidden rounded-lg border ${color.border} ${color.bg}`}
      title={detail ? `${title}. ${detail}` : title}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex items-center gap-3">
          <span className={`grid size-8 shrink-0 place-items-center rounded-full bg-white/70 ${color.text}`}>
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          </span>
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${color.text}`}>{title}</p>
            {detail && <p className={`hidden text-xs sm:block ${color.muted}`}>{detail}</p>}
            {detail && <span className="sr-only sm:hidden">{detail}</span>}
          </div>
        </div>
      </div>
      <div className="h-1 w-full bg-white/70">
        <div className={`h-full w-1/3 animate-pulse ${color.bar}`} />
      </div>
    </div>
  );
}
