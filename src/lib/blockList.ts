import type { Json } from "@/supabase/types";
import {
  BLOCKED_EMAIL_DOMAINS as SHARED_BLOCKED_EMAIL_DOMAINS,
  recipientBlockReason,
} from "../../scripts/lib/recipient-rules.mjs";

export const BLOCKED_EMAIL_DOMAINS: readonly string[] = SHARED_BLOCKED_EMAIL_DOMAINS;

export function normalizeEmailForBlockList(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export function emailDomain(value: string | null | undefined) {
  const normalized = normalizeEmailForBlockList(value);
  const at = normalized.lastIndexOf("@");
  if (at < 0) return null;
  return normalized.slice(at + 1);
}

// Blocked domains (reminder services) and automated senders such as
// noreply@, invoice@ or anything@mail.<company>.com. See recipient-rules.mjs.
export function isBlockedRecipientEmail(value: string | null | undefined) {
  return recipientBlockReason(value) !== null;
}

export function blockedMemberMetadata(existing?: Json | null, email?: string | null): Json {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, Json>) }
      : {};

  return {
    ...base,
    blocked_by: recipientBlockReason(email) ?? "domain_block_list",
    blocked_domains: [...BLOCKED_EMAIL_DOMAINS],
  } as Json;
}
