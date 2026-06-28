export type RecipientPersonalization = {
  email: string;
  name?: string;
  firstName?: string;
};

type RecipientPersonalizationInput = {
  email: string;
  displayName?: string | null;
};

type EmailContent = {
  subject: string;
  html: string;
  text?: string;
};

const MERGE_TAG_RE = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*\|\s*([^{}]*?))?\s*\}\}/g;

function normalizeValue(value: string | null | undefined) {
  return value
    ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || undefined;
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

function firstNameFromDisplayName(displayName: string | undefined) {
  if (!displayName) return undefined;
  const [first] = displayName.split(/\s+/);
  return first?.replace(/[,:;]+$/g, "") || undefined;
}

export function buildRecipientPersonalization(
  input: RecipientPersonalizationInput,
): RecipientPersonalization {
  const name = normalizeValue(input.displayName);

  return {
    email: normalizeValue(input.email)?.toLowerCase() ?? input.email.trim().toLowerCase(),
    name,
    firstName: firstNameFromDisplayName(name),
  };
}

function resolveMergeTag(
  rawKey: string,
  rawFallback: string | undefined,
  personalization: RecipientPersonalization,
) {
  const key = normalizeTokenName(rawKey);
  const fallback = rawFallback === undefined ? undefined : (normalizeValue(rawFallback) ?? "");

  if (["email", "recipientemail", "to"].includes(key)) {
    return personalization.email;
  }

  if (["name", "fullname", "recipientname", "toname", "displayname"].includes(key)) {
    return personalization.name ?? fallback ?? "there";
  }

  if (["firstname", "first", "recipientfirstname"].includes(key)) {
    return personalization.firstName ?? fallback ?? "there";
  }

  return null;
}

function personalize(
  input: string,
  personalization: RecipientPersonalization,
  encode: (value: string) => string,
) {
  return input.replace(MERGE_TAG_RE, (match, key: string, fallback: string | undefined) => {
    const value = resolveMergeTag(key, fallback, personalization);
    return value === null ? match : encode(value);
  });
}

export function personalizeText(input: string, personalization: RecipientPersonalization) {
  return personalize(input, personalization, (value) => value);
}

export function personalizeHtml(input: string, personalization: RecipientPersonalization) {
  return personalize(input, personalization, escapeHtml);
}

export function personalizeEmailContent(
  content: EmailContent,
  personalization: RecipientPersonalization,
): EmailContent {
  return {
    subject: personalizeText(content.subject, personalization),
    html: personalizeHtml(content.html, personalization),
    text: content.text ? personalizeText(content.text, personalization) : undefined,
  };
}
