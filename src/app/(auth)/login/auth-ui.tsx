import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Mail } from "lucide-react";

export const pickParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";

export const inputClass =
  "mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 py-2 text-base text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 sm:text-sm";

export const primaryButtonClass =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 disabled:opacity-60";

export const linkClass =
  "font-medium text-slate-900 underline underline-offset-4 hover:text-slate-700";

type AuthCardProps = {
  title: string;
  eyebrow?: string;
  description: string;
  children: ReactNode;
};

export function AuthCard({
  title,
  eyebrow = "Knotable Props",
  description,
  children,
}: AuthCardProps) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-100 px-3 py-4 sm:px-4">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-lg sm:space-y-6 sm:rounded-2xl sm:p-8">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-400">{eyebrow}</p>
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          <p className="text-sm text-slate-500">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

type AuthMessageProps = {
  tone?: "error" | "success";
  icon?: "check" | "mail";
  children: ReactNode;
};

export function AuthMessage({ tone = "error", icon = "check", children }: AuthMessageProps) {
  const isError = tone === "error";
  const Icon = isError ? AlertCircle : icon === "mail" ? Mail : CheckCircle2;

  return (
    <div
      className={
        isError
          ? "flex gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          : "flex gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
      }
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
