// SES event notifications carry the full header block of the original message
// (every header, twice: `headers` and `commonHeaders`). Nothing downstream
// reads them — analytics and the circuit breaker only look at the event type,
// recipient, `bounce.bounceType` and `click.link` — but they are most of each
// row's size. At ~3 events per recipient, a 185k-recipient send would store
// ~550k full events, more than a free-tier Supabase database holds. Keep only
// what identifies the message and the event-specific detail.

const MAX_TEXT = 500;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function trimStrings(value: unknown, depth = 0): Json {
  if (typeof value === "string") return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => trimStrings(item, depth + 1));
  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, trimStrings(item, depth + 1)]),
    );
  }
  return null;
}

// SES's own tags (ses:source-ip, ses:caller-identity, …) are dropped; the
// worker's tags (queue_id, campaign) are kept.
function customTags(tags: unknown): Json | undefined {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return undefined;
  const kept = Object.entries(tags as Record<string, unknown>).filter(([key]) => !key.startsWith("ses:"));
  return kept.length ? trimStrings(Object.fromEntries(kept)) : undefined;
}

const DETAIL_KEYS = [
  "delivery",
  "bounce",
  "complaint",
  "open",
  "click",
  "reject",
  "failure",
  "deliveryDelay",
  "subscription",
] as const;

export function slimSesEvent(event: Record<string, unknown>): Record<string, Json> {
  const mail = (event["mail"] ?? {}) as Record<string, unknown>;
  const slimMail: Record<string, Json> = {};
  for (const key of ["messageId", "timestamp", "destination"] as const) {
    if (mail[key] !== undefined) slimMail[key] = trimStrings(mail[key]);
  }
  const tags = customTags(mail["tags"]);
  if (tags !== undefined) slimMail.tags = tags;

  const slim: Record<string, Json> = { eventType: trimStrings(event["eventType"] ?? null), mail: slimMail };
  for (const key of DETAIL_KEYS) {
    if (event[key] !== undefined) slim[key] = trimStrings(event[key]);
  }
  return slim;
}
