// Recipient rules shared by the app (src/lib/blockList.ts) and the SES worker
// (scripts/lib/ses-bulk-worker-core.mjs), so import, queueing and sending
// agree on who is never mailed.

export const BLOCKED_EMAIL_DOMAINS = ["followupthen.com", "fut.io"];

// Mailbox names that belong to machines, not people. Lists scraped from an
// inbox are full of these; they hard-bounce or never read, which is what
// pushed the SES account into review (2026-09-29).
const AUTOMATED_LOCAL_PARTS = new Set([
  "noreply", "donotreply", "donotrespond", "noresponse",
  "mailerdaemon", "postmaster", "bounce", "bounces",
  "notification", "notifications", "notify", "alert", "alerts",
  "invoice", "invoices", "billing", "receipt", "receipts", "statement", "statements",
  "newsletter", "newsletters", "marketing", "promotions", "offers", "deals",
  "digest", "updates", "automated", "auto", "system", "events", "email",
]);

// Sending subdomains of email service providers (mail.stubhub.com,
// marketing.manacommon.com, em.example.com). Only matched with at least three
// labels, so consumer domains such as mail.com and email.com stay allowed.
const AUTOMATED_SUBDOMAIN_PREFIXES = new Set([
  "mail", "email", "e", "em", "emails", "mailer", "mailing", "mg", "mkt",
  "marketing", "news", "newsletter", "newsletters", "notify", "notifications",
  "bounce", "bounces", "reply", "sendgrid", "sg", "mc",
]);
// Universities give real people addresses like jo@mail.harvard.edu.
const ACADEMIC_DOMAIN = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/;

export function normalizeEmailAddress(value) {
  return String(value ?? "").trim().toLowerCase();
}

function splitAddress(value) {
  const normalized = normalizeEmailAddress(value);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  return { local: normalized.slice(0, at), domain: normalized.slice(at + 1) };
}

export function isAutomatedSenderAddress(value) {
  const parts = splitAddress(value);
  if (!parts) return false;
  // "invoice+statements", "no-reply", "do_not_reply", "noreply-42" all
  // collapse to a bare mailbox name.
  const base = parts.local.split("+")[0].replace(/[-_.]/g, "").replace(/\d+$/, "");
  if (AUTOMATED_LOCAL_PARTS.has(base)) return true;
  if (/^(noreply|donotreply)/.test(base)) return true;
  const labels = parts.domain.split(".");
  return labels.length >= 3 && AUTOMATED_SUBDOMAIN_PREFIXES.has(labels[0]) && !ACADEMIC_DOMAIN.test(parts.domain);
}

// Why an address is never mailed, or null if it may be.
export function recipientBlockReason(value) {
  const parts = splitAddress(value);
  if (!parts) return null;
  if (BLOCKED_EMAIL_DOMAINS.includes(parts.domain)) return "domain_block_list";
  if (isAutomatedSenderAddress(value)) return "automated_sender";
  return null;
}
