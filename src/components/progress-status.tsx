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
    >
      <div className="px-4 py-3">
        <p className={`text-sm font-semibold ${color.text}`}>{title}</p>
        {detail && <p className={`mt-1 text-xs ${color.muted}`}>{detail}</p>}
      </div>
      <div className="h-1 w-full bg-white/70">
        <div className={`h-full w-1/3 animate-pulse ${color.bar}`} />
      </div>
    </div>
  );
}
