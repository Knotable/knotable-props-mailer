import type { Json } from "@/supabase/types";

export const BLOCK_LIST_NAME = "Block List";
export const BLOCK_LIST_ADDRESS = "block-list@props.local";
export const BLOCKED_EMAIL_DOMAINS = ["followupthen.com", "fut.io"] as const;

export function normalizeEmailForBlockList(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export function emailDomain(value: string | null | undefined) {
  const normalized = normalizeEmailForBlockList(value);
  const at = normalized.lastIndexOf("@");
  if (at < 0) return null;
  return normalized.slice(at + 1);
}

export function isBlockedRecipientEmail(value: string | null | undefined) {
  const domain = emailDomain(value);
  return domain ? BLOCKED_EMAIL_DOMAINS.includes(domain as (typeof BLOCKED_EMAIL_DOMAINS)[number]) : false;
}

export function blockedMemberMetadata(existing?: Json | null): Json {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, Json>) }
      : {};

  return {
    ...base,
    blocked_by: "domain_block_list",
    blocked_domains: [...BLOCKED_EMAIL_DOMAINS],
  } as Json;
}
