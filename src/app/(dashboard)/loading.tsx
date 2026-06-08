export default function DashboardLoading() {
  return (
    <div className="space-y-4">
      <div className="h-5 w-32 animate-pulse rounded bg-slate-200" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-24 animate-pulse rounded-xl border border-slate-200 bg-slate-50"
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
    </div>
  );
}
