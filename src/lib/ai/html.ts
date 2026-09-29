// Minimal, chrome-free HTML for the /ai agent interface: semantic tags,
// stable ids, labeled fields, no scripts or styling to wade through.

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type Field = {
  name: string;
  label: string;
  type?: "text" | "email" | "password" | "textarea" | "hidden" | "datetime" | "number" | "checkbox" | "select";
  value?: string | number | null;
  required?: boolean;
  options?: { value: string; label: string }[];
  multiple?: boolean;
  help?: string;
};

export type ActionSpec = {
  action: string;
  label: string;
  description: string;
  fields: Field[];
  danger?: boolean;
};

export function form(spec: ActionSpec, returnTo: string): string {
  const inputs = spec.fields
    .map((field) => {
      const id = `${spec.action}-${field.name}`;
      const required = field.required ? " required" : "";
      const help = field.help ? ` <small id="${esc(id)}-help">${esc(field.help)}</small>` : "";
      if (field.type === "hidden") return `<input type="hidden" name="${esc(field.name)}" value="${esc(field.value)}">`;
      if (field.type === "textarea") {
        return `<p><label for="${esc(id)}">${esc(field.label)}</label><br><textarea id="${esc(id)}" name="${esc(field.name)}" rows="6" cols="80"${required}>${esc(field.value)}</textarea>${help}</p>`;
      }
      if (field.type === "checkbox" && field.options) {
        const boxes = field.options
          .map((option, index) => `<label><input type="checkbox" id="${esc(id)}-${index}" name="${esc(field.name)}" value="${esc(option.value)}"> ${esc(option.label)}</label>`)
          .join("<br>");
        return `<fieldset id="${esc(id)}"><legend>${esc(field.label)}</legend>${boxes}${help}</fieldset>`;
      }
      if (field.type === "checkbox") {
        return `<p><label><input type="checkbox" id="${esc(id)}" name="${esc(field.name)}" value="yes"> ${esc(field.label)}</label>${help}</p>`;
      }
      if (field.type === "select" && field.options) {
        const options = field.options
          .map((option) => `<option value="${esc(option.value)}"${String(option.value) === String(field.value ?? "") ? " selected" : ""}>${esc(option.label)}</option>`)
          .join("");
        return `<p><label for="${esc(id)}">${esc(field.label)}</label> <select id="${esc(id)}" name="${esc(field.name)}"${required}>${options}</select>${help}</p>`;
      }
      const type = field.type === "datetime" ? "datetime-local" : field.type ?? "text";
      return `<p><label for="${esc(id)}">${esc(field.label)}</label> <input id="${esc(id)}" type="${type}" name="${esc(field.name)}" value="${esc(field.value)}"${required}>${help}</p>`;
    })
    .join("\n");
  return `<form id="form-${esc(spec.action)}" method="post" action="/ai/do/${esc(spec.action)}" data-action="${esc(spec.action)}">
<h3>${esc(spec.label)}${spec.danger ? " (irreversible or sends email)" : ""}</h3>
<p>${esc(spec.description)}</p>
<input type="hidden" name="return_to" value="${esc(returnTo)}">
${inputs}
<p><button type="submit" id="submit-${esc(spec.action)}">${esc(spec.label)}</button></p>
</form>`;
}

export function table(id: string, headers: string[], rows: (string | number | null | undefined)[][], rawColumns: number[] = []): string {
  if (!rows.length) return `<p id="${esc(id)}-empty">None.</p>`;
  const head = headers.map((header) => `<th scope="col">${esc(header)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell, index) => `<td>${rawColumns.includes(index) ? String(cell ?? "") : esc(cell)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table id="${esc(id)}"><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

export function dl(id: string, entries: [string, unknown][]): string {
  return `<dl id="${esc(id)}">${entries.map(([key, value]) => `<dt>${esc(key)}</dt><dd data-key="${esc(key)}">${esc(value ?? "—")}</dd>`).join("")}</dl>`;
}

export function link(href: string, text: string, id?: string): string {
  return `<a href="${esc(href)}"${id ? ` id="${esc(id)}"` : ""}>${esc(text)}</a>`;
}

const NAV: [string, string][] = [
  ["/ai", "index"],
  ["/ai/status", "status"],
  ["/ai/campaigns", "campaigns"],
  ["/ai/campaigns/new", "new campaign"],
  ["/ai/lists", "lists"],
  ["/ai/login", "login"],
];

export function page({
  title,
  who,
  result,
  body,
  jsonHref,
}: {
  title: string;
  who: string | null;
  result?: { ok: boolean; message: string } | null;
  body: string;
  jsonHref: string;
}): string {
  const nav = NAV.map(([href, text]) => link(href, text, `nav-${text.replace(/\s+/g, "-")}`)).join(" | ");
  const resultBlock = result
    ? `<output id="result" role="status" data-ok="${result.ok ? "true" : "false"}">${result.ok ? "OK" : "ERROR"}: ${esc(result.message)}</output>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(title)} · Props Mailer AI</title>
<link rel="alternate" type="application/json" href="${esc(jsonHref)}"></head>
<body>
<nav id="nav">${nav}</nav>
<p id="whoami">${who ? `Signed in as ${esc(who)}.` : `Not signed in. ${link("/ai/login", "Sign in")}.`} JSON: ${link(jsonHref, jsonHref, "json-link")}</p>
${resultBlock}
<main id="main">
<h1>${esc(title)}</h1>
${body}
</main>
</body></html>`;
}
