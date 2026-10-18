import Link from "next/link";
import type { Metadata } from "next";
import { FileText, Pencil, Plus, Smartphone } from "lucide-react";
import { requireServerAuthContext } from "@/lib/authAccess";
import { listTemplates } from "@/lib/emailTemplates";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { FormStatusButton } from "@/components/form-status-button";
import { templateFromCampaignAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Templates · Props" };

type Props = { searchParams: Promise<{ saved?: string; deleted?: string; error?: string }> };

export default async function TemplatesPage({ searchParams }: Props) {
  await requireServerAuthContext();
  const { saved, deleted, error } = await searchParams;
  const [templates, { data: recent }] = await Promise.all([
    listTemplates(),
    getSupabaseAdmin()
      .from("emails")
      .select("id, subject, status, created_at")
      .in("status", ["sent", "sending", "queued"])
      .order("created_at", { ascending: false })
      .limit(40),
  ]);
  const savedName = saved ? templates.find((t) => t.id === saved)?.name : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Email</p>
          <h2 className="text-2xl font-semibold text-slate-900">Templates</h2>
          <p className="text-sm text-slate-500">Starting points for new emails. Pick one from the Composer’s template menu.</p>
        </div>
        <Link
          href="/email/templates/new"
          className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
        >
          <Plus aria-hidden="true" className="size-4" /> New template
        </Link>
      </header>

      {savedName && <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">Saved “{savedName}”.</div>}
      {deleted && <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">Template removed.</div>}
      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error.slice(0, 300)}</div>}

      <ul className="grid gap-3 sm:grid-cols-2">
        {templates.map((template) => (
          <li key={template.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start gap-3">
              {template.format === "plain" ? (
                <Smartphone aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-slate-500" />
              ) : (
                <FileText aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-violet-600" />
              )}
              <div className="min-w-0 flex-1">
                <p className="break-words font-semibold text-slate-900">{template.name}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {template.format === "plain" ? "Plain text" : "HTML"}
                  {template.builtIn ? (template.overridden ? " · built-in, edited" : " · built-in") : ""}
                  {" · updated "}
                  {template.updatedAt.slice(0, 10)}
                </p>
                {template.subject && <p className="mt-2 break-words text-sm text-slate-700">Subject: {template.subject}</p>}
                {template.description && <p className="mt-1 break-words text-sm text-slate-500">{template.description}</p>}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={`/email/composer?template=${template.id}`}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
              >
                Use in Composer
              </Link>
              <Link
                href={`/email/templates/${template.id}`}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700"
              >
                <Pencil aria-hidden="true" className="size-3.5" /> Edit
              </Link>
            </div>
          </li>
        ))}
      </ul>

      <form action={templateFromCampaignAction} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm font-medium text-slate-700">Save a past email as a template</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <select name="emailId" required defaultValue="" className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="" disabled>Choose a sent or queued email…</option>
            {(recent ?? []).map((email) => (
              <option key={email.id} value={email.id}>
                {String(email.created_at ?? "").slice(0, 10)} · {email.subject}
              </option>
            ))}
          </select>
          <input name="name" placeholder="Template name (optional)" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm sm:w-64" />
          <FormStatusButton type="submit" pendingLabel="Saving…" className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            Save as template
          </FormStatusButton>
        </div>
      </form>
    </div>
  );
}
