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
