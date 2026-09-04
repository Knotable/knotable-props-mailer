import crypto from "node:crypto";

const TERMINAL_STATES = new Set(["ACCEPTED", "DEAD", "CANCELED"]);

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function recipientHash(email) {
  return crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

export function campaignApprovalDigest(manifest) {
  const approval = {
    schemaVersion: manifest.schemaVersion,
    sourceListIds: manifest.source?.listIds ?? [],
    campaign: manifest.campaign,
    recipients: {
      count: manifest.recipients?.count,
      key: manifest.recipients?.key,
      sha256: manifest.recipients?.sha256,
    },
    batches: manifest.batches,
  };
  return crypto.createHash("sha256").update(JSON.stringify(approval)).digest("hex");
}

export function campaignConfirmation(campaignId, approvalSha256) {
  return `send:${campaignId}:${approvalSha256.slice(0, 12)}`;
}

export function batchConfirmation(campaignId, approvalSha256, batchNumber) {
  return `${campaignConfirmation(campaignId, approvalSha256)}:batch:${batchNumber}`;
}

export function batchRecordKey(batchNumber) {
  if (!Number.isSafeInteger(batchNumber) || batchNumber < 1) throw new Error("Batch number must be a positive integer.");
  return `!BATCH#${String(batchNumber).padStart(3, "0")}`;
}

export function planRecipientBatches(audience, batchCount = 3) {
  if (!Number.isSafeInteger(audience) || audience < 1) throw new Error("Audience must be a positive integer.");
  if (!Number.isSafeInteger(batchCount) || batchCount < 1 || batchCount > audience) {
    throw new Error("Batch count must be a positive integer no larger than the audience.");
  }
  const baseSize = Math.floor(audience / batchCount);
  const remainder = audience % batchCount;
  let startOrdinal = 0;
  return Array.from({ length: batchCount }, (_, index) => {
    const count = baseSize + (index < remainder ? 1 : 0);
    const batch = {
      batchNumber: index + 1,
      startOrdinal,
      endOrdinal: startOrdinal + count,
      count,
    };
    startOrdinal += count;
    return batch;
  });
}

export function batchForOrdinal(batches, ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return null;
  return batches.find((batch) => ordinal >= batch.startOrdinal && ordinal < batch.endOrdinal) ?? null;
}

export function unsubscribeSignature({ secret, campaignId, email }) {
  if (!secret) throw new Error("Unsubscribe signing secret is required.");
  return crypto
    .createHmac("sha256", secret)
    .update(`v1\n${campaignId}\n${normalizeEmail(email)}`)
    .digest("hex");
}

export function oneClickUnsubscribeUrl({ baseUrl, secret, campaignId, email }) {
  const normalized = normalizeEmail(email);
  const url = new URL(baseUrl);
  url.searchParams.set("campaign", campaignId);
  url.searchParams.set("recipient", Buffer.from(normalized, "utf8").toString("base64url"));
  url.searchParams.set("signature", unsubscribeSignature({ secret, campaignId, email: normalized }));
  return url.toString();
}

export function validateCampaignManifest(value, expectedCampaignId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Campaign manifest must be a JSON object.");
  if (value.schemaVersion !== 2) throw new Error(`Unsupported campaign manifest schemaVersion ${value.schemaVersion}.`);
  if (!value.campaign || value.campaign.id !== expectedCampaignId) throw new Error("Campaign manifest id does not match --campaign-id.");
  for (const key of ["fromAddress", "subject", "html"]) {
    if (typeof value.campaign[key] !== "string" || !value.campaign[key].trim()) throw new Error(`Campaign manifest is missing campaign.${key}.`);
  }
  if (!value.recipients || !Number.isInteger(value.recipients.count) || value.recipients.count < 1) {
    throw new Error("Campaign manifest recipients.count must be a positive integer.");
  }
  if (typeof value.recipients.key !== "string" || !value.recipients.key.trim()) throw new Error("Campaign manifest is missing recipients.key.");
  if (!/^[0-9a-f]{64}$/i.test(value.recipients.sha256 ?? "")) throw new Error("Campaign manifest has an invalid recipients.sha256.");
  const expectedBatches = planRecipientBatches(value.recipients.count, Math.min(3, value.recipients.count));
  if (JSON.stringify(value.batches) !== JSON.stringify(expectedBatches)) {
    throw new Error("Campaign manifest must contain the canonical three-batch recipient partition.");
  }
  if (!/^[0-9a-f]{64}$/i.test(value.approvalSha256 ?? "")) throw new Error("Campaign manifest has an invalid approvalSha256.");
  const expectedApproval = campaignApprovalDigest(value);
  if (value.approvalSha256 !== expectedApproval) throw new Error("Campaign manifest approval digest does not match its content and audience.");
  return value;
}

export function validateRecipient(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recipient line must be a JSON object.");
  const email = normalizeEmail(value.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid recipient address: ${value.email ?? "(missing)"}`);
  const merge = value.merge && typeof value.merge === "object" && !Array.isArray(value.merge) ? value.merge : {};
  return {
    email,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined,
    merge,
    sourceListIds: Array.isArray(value.sourceListIds) ? value.sourceListIds.filter((item) => typeof item === "string") : [],
  };
}

export function summarizeCampaignState(items) {
  const summary = { accepted: 0, claimed: 0, retry: 0, dead: 0, canceled: 0, other: 0 };
  for (const item of items) {
    const key = String(item.status ?? "").toLowerCase();
    if (Object.hasOwn(summary, key)) summary[key] += 1;
    else summary.other += 1;
  }
  return summary;
}

export function isTerminalState(status) {
  return TERMINAL_STATES.has(String(status ?? "").toUpperCase());
}

export function classifyNativeSesResult(result, attempts, maxAttempts) {
  if (result?.Status === "SUCCESS" && result.MessageId) {
    return { status: "ACCEPTED", sesMessageId: result.MessageId, error: null };
  }
  const message = [result?.Status, result?.Error].filter(Boolean).join(": ") || "SES returned no result";
  const permanent = ["ACCOUNT_SUSPENDED", "MAIL_FROM_DOMAIN_NOT_VERIFIED", "MESSAGE_REJECTED"].includes(result?.Status);
  return {
    status: permanent || attempts >= maxAttempts ? "DEAD" : "RETRY",
    sesMessageId: null,
    error: message,
  };
}
