import { createHash } from "node:crypto";

export type CampaignContent = {
  from: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string | null;
  tags: string[];
  campaigns: string[];
};

/** A stable identifier for the exact content approved for a campaign. */
export function campaignContentDigest(content: CampaignContent): string {
  return createHash("sha256")
    .update(JSON.stringify({
      from: content.from.trim(),
      replyTo: content.replyTo?.trim() || null,
      subject: content.subject,
      html: content.html,
      text: content.text ?? null,
      tags: [...content.tags].sort(),
      campaigns: [...content.campaigns].sort(),
    }))
    .digest("hex");
}

const STREET_ADDRESS_RE = /(?:^|[\s>])(?:\d{1,5}\s+(?:[A-Za-z0-9.'’-]+\s+){0,5}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|place|pl\.?|court|ct\.?|way)\b)/gim;

/** Finds likely precise street addresses in rendered campaign copy. */
export function findStreetAddressMentions(content: string): string[] {
  return [...new Set(Array.from(content.matchAll(STREET_ADDRESS_RE), (match) => match[0].trim()))];
}

export function privacyWarning(content: string): string | null {
  const matches = findStreetAddressMentions(content);
  return matches.length
    ? `Possible precise street address: ${matches.slice(0, 2).join("; ")}. Use “Location shared with registered guests” for broad reminders unless publication is intentional.`
    : null;
}

export const campaignLifecycle = [
  "Draft",
  "Preparing audience",
  "Held",
  "Worker queued",
  "Sending",
  "SES accepted",
  "Delivered",
] as const;
