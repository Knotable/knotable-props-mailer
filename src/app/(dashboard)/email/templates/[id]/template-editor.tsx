"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { FormStatusButton } from "@/components/form-status-button";
import { templateHtml, type EmailTemplate, type TemplateFormat } from "@/lib/emailTemplateCore";
import { deleteTemplateAction, saveTemplateAction, type TemplateFormState } from "../actions";

const input = "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";

export function TemplateEditor({ template }: { template: EmailTemplate | null }) {
  const [state, save] = useActionState<TemplateFormState, FormData>(saveTemplateAction, {});
  const [format, setFormat] = useState<TemplateFormat>(template?.format ?? "html");
  const [body, setBody] = useState(template?.body ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <form action={save} className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          {template && <input type="hidden" name="id" value={template.id} />}
          <label className="block text-sm font-medium text-slate-700">
            Name
            <input name="name" required defaultValue={template?.name ?? ""} className={input} />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Description <span className="font-normal text-slate-400">(optional)</span>
            <input name="description" defaultValue={template?.description ?? ""} className={input} />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Subject
            <input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Merge tags like {{firstName | friend}} work" className={input} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              From <span className="font-normal text-slate-400">(optional)</span>
              <input name="fromAddress" defaultValue={template?.fromAddress ?? ""} placeholder="Amol Sarva <amol@lifex.vc>" className={input} />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Reply-To <span className="font-normal text-slate-400">(optional)</span>
              <input name="replyTo" defaultValue={template?.replyTo ?? ""} className={input} />
            </label>
          </div>
          <fieldset className="text-sm">
            <legend className="font-medium text-slate-700">Format</legend>
            <div className="mt-1 flex gap-4">
              {(["html", "plain"] as const).map((value) => (
                <label key={value} className="inline-flex items-center gap-2 text-slate-700">
                  <input type="radio" name="format" value={value} checked={format === value} onChange={() => setFormat(value)} />
                  {value === "html" ? "Designed (HTML)" : "Plain text, phone style"}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-medium text-slate-700">
            {format === "html" ? "HTML" : "Text"}
            <textarea
              name="body"
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={format === "html" ? 22 : 14}
              spellCheck={format === "plain"}
              className={`${input} ${format === "html" ? "font-mono text-xs" : ""}`}
            />
            {format === "plain" && (
              <span className="mt-1 block text-xs font-normal text-slate-500">
                Sent as a bare phone-style message: no fonts, colors or images. Links are made clickable automatically.
              </span>
            )}
          </label>
          {state.error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</div>}
          <div className="flex flex-wrap gap-2">
            <FormStatusButton type="submit" pendingLabel="Saving…" className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
              Save template
            </FormStatusButton>
            {template && (
              <Link href={`/email/composer?template=${template.id}`} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700">
                Use in Composer
              </Link>
            )}
          </div>
        </form>
        {template && (!template.builtIn || template.overridden) && (
          <form action={deleteTemplateAction}>
            <input type="hidden" name="id" value={template.id} />
            <FormStatusButton type="submit" pendingLabel="Removing…" className="text-sm text-red-700 underline">
              {template.builtIn ? "Reset to default" : "Delete template"}
            </FormStatusButton>
          </form>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white lg:sticky lg:top-4 lg:self-start">
        <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span className="font-medium">Preview</span>
          {subject && <span className="block truncate text-slate-500">Subject: {subject}</span>}
        </div>
        <iframe title="Template preview" sandbox="" srcDoc={body ? (format === "plain" ? `<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;margin:16px">${templateHtml({ format, body })}</body>` : templateHtml({ format, body })) : ""} className="h-[70vh] w-full" />
      </div>
    </div>
  );
}
