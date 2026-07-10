export type ParsedAudienceMember = {
  email: string;
  name?: string;
  firstName?: string;
  mergeData: Record<string, string>;
  sourceRow: number;
};

export type AudienceParseResult = {
  headers: string[];
  members: ParsedAudienceMember[];
  submitted: number;
  skippedInvalid: number;
  skippedDuplicate: number;
  errors: string[];
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_KEYS = new Set(["email", "emailaddress", "recipient", "recipientemail", "to"]);
const NAME_KEYS = new Set(["name", "fullname", "displayname", "recipientname", "toname"]);
const FIRST_NAME_KEYS = new Set(["firstname", "first", "givenname", "recipientfirstname"]);
const MERGE_TAG_RE = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*\|\s*([^{}]*?))?\s*\}\}/g;

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields.map((field) => field.trim());
}

function normalizeKey(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function compactKey(value: string) {
  return normalizeKey(value).replace(/_/g, "");
}

function normalizeValue(value: string | undefined) {
  return value
    ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
}

export function parseOneTimeAudienceCsv(input: string): AudienceParseResult {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      headers: [],
      members: [],
      submitted: 0,
      skippedInvalid: 0,
      skippedDuplicate: 0,
      errors: ["CSV is empty."],
    };
  }

  const headers = parseCsvLine(lines[0]).map((header) => normalizeKey(header));
  const compactHeaders = headers.map(compactKey);
  const emailIndex = compactHeaders.findIndex((header) => EMAIL_KEYS.has(header));
  if (emailIndex === -1) {
    return {
      headers,
      members: [],
      submitted: Math.max(0, lines.length - 1),
      skippedInvalid: Math.max(0, lines.length - 1),
      skippedDuplicate: 0,
      errors: ["CSV needs a header row with an email column."],
    };
  }

  const seen = new Set<string>();
  let skippedInvalid = 0;
  let skippedDuplicate = 0;
  const members: ParsedAudienceMember[] = [];

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const fields = parseCsvLine(lines[lineIndex]);
    const email = normalizeValue(fields[emailIndex]).toLowerCase();

    if (!EMAIL_RE.test(email)) {
      skippedInvalid += 1;
      continue;
    }
    if (seen.has(email)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(email);

    const mergeData: Record<string, string> = {};
    let name: string | undefined;
    let firstName: string | undefined;

    headers.forEach((header, index) => {
      if (!header) return;
      const value = normalizeValue(fields[index]);
      if (!value) return;

      mergeData[header] = value;
      const compact = compactKey(header);
      if (NAME_KEYS.has(compact)) name = value;
      if (FIRST_NAME_KEYS.has(compact)) firstName = value;
    });

    mergeData.email = email;
    if (name) mergeData.name = name;
    if (firstName) mergeData.first_name = firstName;

    members.push({
      email,
      name,
      firstName,
      mergeData,
      sourceRow: lineIndex + 1,
    });
  }

  return {
    headers,
    members,
    submitted: Math.max(0, lines.length - 1),
    skippedInvalid,
    skippedDuplicate,
    errors: [],
  };
}

function normalizeTokenName(value: string) {
  return value.replace(/[_.-]/g, "").toLowerCase();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolvePreviewTag(rawKey: string, rawFallback: string | undefined, member: ParsedAudienceMember) {
  const compactKey = normalizeTokenName(rawKey);
  const key = normalizeKey(rawKey);
  const fallback = rawFallback?.trim();

  if (EMAIL_KEYS.has(compactKey)) return member.email;
  if (NAME_KEYS.has(compactKey)) return member.name || member.mergeData.name || fallback || "there";
  if (FIRST_NAME_KEYS.has(compactKey)) return member.firstName || member.mergeData.first_name || fallback || "there";

  const mergeValue = member.mergeData[key]
    ?? Object.entries(member.mergeData).find(
      ([mergeKey]) => normalizeTokenName(mergeKey) === normalizeTokenName(key),
    )?.[1];

  return mergeValue || fallback || null;
}

export function personalizeAudiencePreview(
  input: string,
  member: ParsedAudienceMember,
  mode: "html" | "text" = "text",
) {
  return input.replace(MERGE_TAG_RE, (match, key: string, fallback: string | undefined) => {
    const value = resolvePreviewTag(key, fallback, member);
    if (value === null) return match;
    return mode === "html" ? escapeHtml(value) : value;
  });
}

export function unresolvedMergeTags(input: string) {
  return [...input.matchAll(MERGE_TAG_RE)]
    .map((match) => match[1])
    .filter((value, index, all) => all.indexOf(value) === index);
}
