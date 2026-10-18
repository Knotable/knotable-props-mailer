// Client-safe template types, built-ins and formatting (no server imports).

export type TemplateFormat = "html" | "plain";

export type EmailTemplate = {
  id: string;
  name: string;
  description: string | null;
  subject: string;
  format: TemplateFormat;
  /** HTML for format "html"; plain text (blank lines = paragraphs) for "plain". */
  body: string;
  fromAddress: string | null;
  replyTo: string | null;
  sourceEmailId: string | null;
  builtIn: boolean;
  overridden?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TemplateSummary = Pick<EmailTemplate, "id" | "name" | "description" | "format" | "subject" | "builtIn" | "overridden" | "updatedAt">;

const EPOCH = "2026-10-18T00:00:00.000Z";

export const BUILT_IN_TEMPLATES: EmailTemplate[] = [
  {
    id: "builtin-phone-note",
    name: "Quick note from my phone",
    description: "Looks like a dashed-off plain email from Amol's iPhone: no images, no styling, short lines, lowercase subject.",
    subject: "quick one",
    format: "plain",
    body: [
      "Hey {{firstName | there}} —",
      "",
      "Quick one. [One or two lines on what's happening and why it matters to them.]",
      "",
      "[link]",
      "",
      "Would be great to see you there. Shoot me a note if you have questions.",
      "",
      "Amol",
      "",
      "Sent from my iPhone",
    ].join("\n"),
    fromAddress: "Amol Sarva <amol@lifex.vc>",
    replyTo: "amol@lifex.vc",
    sourceEmailId: null,
    builtIn: true,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  },
];

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Mirrors what a phone mail client produces: one dir="ltr" div, <br> line
// breaks, bare links auto-linked, no fonts or colors forced.
export function plainTextToHtml(text: string) {
  const escaped = escapeHtml(text.replace(/\r\n?/g, "\n").trim());
  const linked = escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (url) => `<a href="${url}">${url}</a>`);
  return `<div dir="ltr">${linked.split("\n").join("<br>")}</div>`;
}

export function templateHtml(template: Pick<EmailTemplate, "format" | "body">) {
  return template.format === "plain" ? plainTextToHtml(template.body) : template.body;
}

export function normalizeTemplateInput(input: {
  name?: unknown;
  description?: unknown;
  subject?: unknown;
  format?: unknown;
  body?: unknown;
  fromAddress?: unknown;
  replyTo?: unknown;
}): { error: string } | { value: Pick<EmailTemplate, "name" | "description" | "subject" | "format" | "body" | "fromAddress" | "replyTo"> } {
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = text(input.name, 120);
  const body = typeof input.body === "string" ? input.body : "";
  const format: TemplateFormat = input.format === "plain" ? "plain" : "html";
  if (!name) return { error: "Give the template a name." };
  if (!body.trim()) return { error: "The template body is empty." };
  if (body.length > 400_000) return { error: "The template body is too large (400 KB max)." };
  return {
    value: {
      name,
      description: text(input.description, 500) || null,
      subject: text(input.subject, 300),
      format,
      body,
      fromAddress: text(input.fromAddress, 320) || null,
      replyTo: text(input.replyTo, 320) || null,
    },
  };
}

