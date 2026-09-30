// Per-recipient delivery state lives in `email_deliveries` (hot, while a
// campaign sends) and `email_delivery_archive` (compact, afterwards) instead of
// one queue row plus ~2 event rows per recipient forever. See
// supabase/migrations/20260930_delivery_ledger.sql.
//
// Every helper here degrades to the previous behaviour when the migration has
// not been applied yet, so deploying the code first is safe.

export type LedgerClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

export type LedgerResult = "flagged" | "row";

// The generated Supabase types are stale (many RPCs resolve to `never`), so the
// helpers accept any client and use only its untyped `rpc`.
const ledger = (client: unknown) => client as LedgerClient;

const MISSING_FUNCTION_CODES = new Set(["42883", "PGRST202"]);

export function isMissingFunction(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return MISSING_FUNCTION_CODES.has(error.code ?? "") || /could not find the function|does not exist/i.test(error.message ?? "");
}

// 'flagged': the event was folded into the delivery ledger; do NOT store a
// provider_events row. 'row': the caller must store it (no ledger row yet,
// already-compacted campaign, evidence-bearing event type, or the migration is
// not applied).
export async function recordDeliveryEvent(
  client: unknown,
  event: { emailId: string | null; recipient: string | null; eventType: string },
): Promise<LedgerResult> {
  if (!event.emailId || !event.recipient) return "row";
  try {
    const { data, error } = await ledger(client).rpc("record_delivery_event", {
      p_email_id: event.emailId,
      p_recipient: event.recipient,
      p_event_type: event.eventType,
    });
    if (error) return "row";
    return data === "flagged" ? "flagged" : "row";
  } catch {
    return "row";
  }
}

// A worker-parked ambiguous row that SES's Send event later proved delivered.
export async function markDeliveryAccepted(client: unknown, emailId: string, recipient: string | null): Promise<void> {
  if (!recipient) return;
  try {
    await ledger(client).rpc("mark_delivery_accepted", { p_email_id: emailId, p_recipient: recipient });
  } catch {
    // Best effort: the queue row is already corrected.
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// SES returns message tags as { name: [value, ...] }. The bulk worker sets
// queue_id and campaign_id on every message, so events can be attributed to a
// campaign without touching (possibly already compacted) queue rows.
export function firstTagUuid(tags: unknown, name: string): string | null {
  if (!tags || typeof tags !== "object") return null;
  const value = (tags as Record<string, unknown>)[name];
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && UUID_RE.test(candidate)) return candidate;
  }
  return null;
}

// Of these addresses, the ones SES already accepted for this campaign (hot
// ledger or compact archive). Queueing a finished or compacted campaign again
// must skip them, since its queue rows, and with them the dedupe hashes, may be
// gone. Returns an empty set before the migration is applied; any other failure
// throws so a recipient is never re-sent because a lookup silently failed.
export async function findAcceptedRecipients(client: unknown, emailId: string, addresses: string[]): Promise<Set<string>> {
  if (!addresses.length) return new Set();
  const { data, error } = await ledger(client).rpc("delivery_accepted_among", { p_email_id: emailId, p_recipients: addresses });
  if (error) {
    if (isMissingFunction(error)) return new Set();
    throw new Error(`Could not check which recipients were already sent: ${error.message ?? "unknown error"}`);
  }
  // PostgREST returns a set of scalars as bare values or one-key objects.
  const values = (Array.isArray(data) ? data : []).map((item) =>
    item && typeof item === "object" ? Object.values(item as Record<string, unknown>)[0] : item,
  );
  return new Set(values.filter((value): value is string => typeof value === "string"));
}
