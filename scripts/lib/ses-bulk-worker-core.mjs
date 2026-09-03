const MERGE_TAG_RE = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*\|\s*([^{}]*?))?\s*\}\}/g;

export const BLOCKED_EMAIL_DOMAINS = new Set(["followupthen.com", "fut.io"]);

export function subjectPlaceholderTerms(subject) {
  const patterns = [
    [/\bdrafts?\b/i, "draft"],
    [/\btests?(?:ing)?\b/i, "test"],
    [/\bplaceholders?\b/i, "placeholder"],
    [/\bsamples?\b/i, "sample"],
    [/\buntitled\b/i, "untitled"],
    [/\b(?:todo|tbd)\b/i, "TODO/TBD"],
    [/\blorem ipsum\b/i, "lorem ipsum"],
  ];
  return patterns.filter(([pattern]) => pattern.test(subject)).map(([, label]) => label);
}

export function assertSendReadySubject(subject) {
  const terms = subjectPlaceholderTerms(subject);
  if (terms.length) throw new Error(`Subject is not send-ready: remove ${terms.join(", ")}.`);
}

function normalize(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizedKey(value) {
  return value.replace(/[_.-]/g, "").toLowerCase();
}

function mergeKey(value) {
  return value.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

export function recipientData(payload, queueId) {
  const email = normalize(payload.to).toLowerCase();
  const name = normalize(payload.toName) || undefined;
  const firstName = name?.split(/\s+/)[0]?.replace(/[,:;]+$/g, "") || undefined;
  const merge = Object.fromEntries(
    Object.entries(payload.merge ?? {}).flatMap(([key, value]) => {
      if (!["string", "number", "boolean"].includes(typeof value)) return [];
      const keyValue = mergeKey(key);
      const normalized = normalize(value);
      return keyValue && normalized ? [[keyValue, normalized]] : [];
    }),
  );
  return { email, name, firstName, merge, queueId };
}

export function isBlockedRecipient(email) {
  const normalized = normalize(email).toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at >= 0 && BLOCKED_EMAIL_DOMAINS.has(normalized.slice(at + 1));
}

function resolve(rawKey, rawFallback, data) {
  const key = normalizedKey(rawKey);
  const fallback = rawFallback === undefined ? undefined : normalize(rawFallback);
  if (["email", "recipientemail", "to"].includes(key)) return data.email;
  if (["name", "fullname", "recipientname", "toname", "displayname"].includes(key)) return data.name ?? fallback ?? "there";
  if (["firstname", "first", "recipientfirstname"].includes(key)) return data.firstName ?? fallback ?? "there";
  if (["queueid", "queue_id"].includes(key)) return data.queueId;
  const wanted = mergeKey(rawKey);
  const value = data.merge[wanted] ?? Object.entries(data.merge).find(([candidate]) => normalizedKey(candidate) === normalizedKey(wanted))?.[1];
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Unresolved merge tag: ${rawKey}`);
}

function compilePart(input, prefix, html) {
  let index = 0;
  const tokens = [];
  const template = input.replace(MERGE_TAG_RE, (_match, key, fallback) => {
    const token = `${prefix}${index++}`;
    tokens.push({ token, key, fallback, html });
    return `{{${token}}}`;
  });
  return { template, tokens };
}

export function compileTemplate({ subject, html, text, appBaseUrl }) {
  const base = appBaseUrl?.replace(/\/+$/, "");
  const pixel = base
    ? `<img src="${base}/api/email/open/{{queueId}}" width="1" height="1" alt="" style="border:0;width:1px;height:1px;display:block;opacity:0;" aria-hidden="true" />`
    : "";
  const trackedHtml = pixel
    ? /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, `${pixel}</body>`)
      : `${html}\n${pixel}`
    : html;
  const subjectPart = compilePart(subject, "s", false);
  const htmlPart = compilePart(trackedHtml, "h", true);
  const textPart = text ? compilePart(text, "t", false) : { template: undefined, tokens: [] };
  const tokens = [...subjectPart.tokens, ...htmlPart.tokens, ...textPart.tokens];
  return {
    content: { Subject: subjectPart.template, Html: htmlPart.template, ...(textPart.template ? { Text: textPart.template } : {}) },
    replacementData(data) {
      return Object.fromEntries(tokens.map(({ token, key, fallback, html: isHtml }) => {
        const value = resolve(key, fallback, data);
        return [token, isHtml ? escapeHtml(value) : value];
      }));
    },
  };
}

export function classifySesResult(result, item) {
  if (result?.Status === "SUCCESS" && result.MessageId) {
    return { id: item.id, outcome: "succeeded", ses_message_id: result.MessageId, last_error: null };
  }
  const message = [result?.Status, result?.Error].filter(Boolean).join(": ") || "SES returned no result";
  const permanent = ["ACCOUNT_SUSPENDED", "MAIL_FROM_DOMAIN_NOT_VERIFIED", "MESSAGE_REJECTED"].includes(result?.Status);
  const exhausted = item.attempts + 1 >= item.max_attempts;
  return { id: item.id, outcome: permanent || exhausted ? "dead" : "retry", ses_message_id: null, last_error: message };
}
