// Shared by the app's queue action and the autopilot worker's cloud queue
// preparation, so both build byte-identical mail_queue rows (and dedupe hashes).
import crypto from "node:crypto";

export const QUEUE_HOLD_AT = "2999-12-31T23:59:59.000Z";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function makeDedupeHash(emailId, recipientEmail) {
  return crypto.createHash("sha256").update(`${emailId}:${String(recipientEmail).toLowerCase().trim()}`).digest("hex");
}

export function makeSenderCopyDedupeHash(emailId, senderEmail) {
  return crypto.createHash("sha256").update(`${emailId}:sender-copy:${String(senderEmail).toLowerCase().trim()}`).digest("hex");
}

export function extractEmailAddress(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const angleMatch = trimmed.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/);
  const candidate = (angleMatch?.[1] ?? trimmed).trim().toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

function jsonRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function listMemberToName(metadata) {
  const record = jsonRecord(metadata);
  for (const key of ["toName", "display_name", "displayName", "full_name", "fullName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const rank = typeof record.rank === "number" || typeof record.rank === "string" ? String(record.rank).trim() : "";
  if (name && rank) return `${name} #${rank}`;
  return name || undefined;
}

export function listMemberToMergeData(metadata) {
  const record = jsonRecord(metadata);
  const directMerge = jsonRecord(record.merge);
  const mergeData = jsonRecord(record.merge_data);
  const source = Object.keys(directMerge).length > 0 ? directMerge : mergeData;
  const entries = Object.entries(source).flatMap(([key, value]) => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return [];
    const text = String(value).trim();
    if (!key.trim() || !text) return [];
    return [[key, text]];
  });
  const name = listMemberToName(metadata);
  if (name && !entries.some(([key]) => key === "name")) entries.push(["name", name]);
  const firstName = typeof record.first_name === "string"
    ? record.first_name.trim()
    : typeof record.firstName === "string"
      ? record.firstName.trim()
      : "";
  if (firstName && !entries.some(([key]) => key === "first_name")) entries.push(["first_name", firstName]);
  return Object.fromEntries(entries);
}

export function buildMemberQueueRow({ emailId, listId, email, member, campaignLabel }) {
  return {
    email_id: emailId,
    list_id: listId,
    payload: {
      to: member.email,
      toName: listMemberToName(member.metadata),
      merge: listMemberToMergeData(member.metadata),
      tags: email.tags ?? [],
      campaigns: email.campaigns ?? [],
    },
    status: "pending",
    available_at: QUEUE_HOLD_AT,
    send_date: null,
    campaign_label: campaignLabel,
    dedupe_hash: makeDedupeHash(emailId, member.email),
  };
}

export function buildSenderCopyQueueRow({ emailId, email, senderEmail, campaignLabel }) {
  return {
    email_id: emailId,
    list_id: null,
    payload: {
      to: senderEmail,
      subject: `[SENDER COPY] ${email.subject}`,
      tags: email.tags ?? [],
      campaigns: [...(email.campaigns ?? []), "sender-copy"],
    },
    status: "pending",
    available_at: QUEUE_HOLD_AT,
    send_date: null,
    campaign_label: campaignLabel,
    dedupe_hash: makeSenderCopyDedupeHash(emailId, senderEmail),
  };
}

// ── Same-content suppression ────────────────────────────────────────────────
// Two guarantees, enforced here rather than by an operator checkbox:
//  1. Nobody is queued twice inside one send, however many of the selected
//     lists they appear on — makeDedupeHash ignores list_id, and mail_queue
//     has a unique index on dedupe_hash, so overlapping lists collapse.
//  2. Nobody receives the same content twice within 12 hours, even when it is
//     sent from a different draft (a duplicated campaign sent as batch 2 or 3).
//     Content identity is the fingerprint below, not the draft id.

export const RECENT_DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;

// Twin candidates are found by exact subject; this bounds how many are read.
const TWIN_CANDIDATE_LIMIT = 100;

export function makeContentFingerprint(subject, html) {
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return crypto.createHash("sha256").update(`${normalize(subject)}\n${normalize(html)}`).digest("hex");
}

export function recentDuplicateCutoffIso(now = Date.now()) {
  return new Date(now - RECENT_DUPLICATE_WINDOW_MS).toISOString();
}

// Other drafts whose content is byte-for-byte this content (after whitespace
// normalization) and that accepted at least one recipient since `sinceIso`.
export async function findRecentTwinEmailIds(supabase, { emailId, subject, html, sinceIso }) {
  const fingerprint = makeContentFingerprint(subject, html);
  const { data: candidates, error } = await supabase
    .from("emails")
    .select("id, subject, html")
    .eq("subject", subject)
    .neq("id", emailId)
    .order("updated_at", { ascending: false })
    .limit(TWIN_CANDIDATE_LIMIT);
  if (error) throw new Error(`Could not check for recent duplicate sends: ${error.message}`);

  const twins = [];
  for (const candidate of candidates ?? []) {
    if (makeContentFingerprint(candidate.subject, candidate.html) !== fingerprint) continue;
    const { count, error: countError } = await supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", candidate.id)
      .eq("status", "succeeded")
      .gte("updated_at", sinceIso);
    if (countError) throw new Error(`Could not check for recent duplicate sends: ${countError.message}`);
    if (count) twins.push(candidate.id);
  }
  return twins;
}

// Of `recipients`, those one of `twinEmailIds` already delivered to since
// `sinceIso`. Looked up by dedupe hash, which is uniquely indexed.
export async function findRecentDuplicateRecipients(supabase, { twinEmailIds, recipients, sinceIso }) {
  const duplicates = new Set();
  if (!twinEmailIds.length || !recipients.length) return duplicates;

  for (const twinId of twinEmailIds) {
    const byHash = new Map();
    for (const recipient of recipients) byHash.set(makeDedupeHash(twinId, recipient), recipient);
    const hashes = [...byHash.keys()];
    for (let index = 0; index < hashes.length; index += 100) {
      const { data, error } = await supabase
        .from("mail_queue")
        .select("dedupe_hash")
        .eq("status", "succeeded")
        .gte("updated_at", sinceIso)
        .in("dedupe_hash", hashes.slice(index, index + 100));
      if (error) throw new Error(`Could not check for recent duplicate sends: ${error.message}`);
      for (const row of data ?? []) {
        const recipient = byHash.get(row.dedupe_hash);
        if (recipient) duplicates.add(recipient);
      }
    }
  }
  return duplicates;
}
