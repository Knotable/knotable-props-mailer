import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireServerAuthContext } from "@/lib/authAccess";
import { getTemplate } from "@/lib/emailTemplates";
import { TemplateEditor } from "./template-editor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit template · Props" };

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  await requireServerAuthContext();
  const { id } = await params;
  const template = id === "new" ? null : await getTemplate(id);
  if (id !== "new" && !template) notFound();

  return (
    <div className="space-y-6">
      <header>
        <Link href="/email/templates" className="text-xs uppercase tracking-wide text-slate-400 hover:text-slate-600">
          ← Templates
        </Link>
        <h2 className="text-2xl font-semibold text-slate-900">{template ? template.name : "New template"}</h2>
        {template?.builtIn && (
          <p className="text-sm text-slate-500">
            Built-in template. Your edits are saved as your own version{template.overridden ? "; “Reset to default” restores the original" : ""}.
          </p>
        )}
      </header>
      <TemplateEditor template={template} />
    </div>
  );
}
