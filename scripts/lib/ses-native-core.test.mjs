import { describe, expect, it } from "vitest";
import {
  batchConfirmation,
  batchForOrdinal,
  batchRecordKey,
  campaignConfirmation,
  campaignApprovalDigest,
  classifyNativeSesResult,
  normalizeEmail,
  oneClickUnsubscribeUrl,
  planRecipientBatches,
  recipientHash,
  summarizeCampaignState,
  validateCampaignManifest,
  validateRecipient,
} from "./ses-native-core.mjs";

describe("SES native worker core", () => {
  it("normalizes recipients and creates stable hashes", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(recipientHash("Ada@Example.COM")).toBe(recipientHash(" ada@example.com "));
  });

  it("binds confirmation to the campaign and immutable recipient manifest", () => {
    expect(campaignConfirmation("campaign-1", "abcdef1234567890")).toBe("send:campaign-1:abcdef123456");
    expect(batchConfirmation("campaign-1", "abcdef1234567890", 2)).toBe("send:campaign-1:abcdef123456:batch:2");
    expect(batchRecordKey(2)).toBe("!BATCH#002");
  });

  it("creates canonical non-overlapping batch boundaries", () => {
    const batches = planRecipientBatches(10, 3);
    expect(batches).toEqual([
      { batchNumber: 1, startOrdinal: 0, endOrdinal: 4, count: 4 },
      { batchNumber: 2, startOrdinal: 4, endOrdinal: 7, count: 3 },
      { batchNumber: 3, startOrdinal: 7, endOrdinal: 10, count: 3 },
    ]);
    expect(batchForOrdinal(batches, 0)?.batchNumber).toBe(1);
    expect(batchForOrdinal(batches, 4)?.batchNumber).toBe(2);
    expect(batchForOrdinal(batches, 9)?.batchNumber).toBe(3);
    expect(batchForOrdinal(batches, 10)).toBeNull();
  });

  it("creates a signed recipient-specific one-click unsubscribe URL", () => {
    const url = new URL(oneClickUnsubscribeUrl({
      baseUrl: "https://unsubscribe.example.com/",
      secret: "test-secret",
      campaignId: "campaign-1",
      email: " Ada@Example.COM ",
    }));
    expect(url.searchParams.get("recipient")).toBe(Buffer.from("ada@example.com").toString("base64url"));
    expect(url.searchParams.get("signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates campaign and recipient records", () => {
    const value = {
      schemaVersion: 2,
      source: { listIds: ["list-1"] },
      campaign: { id: "campaign-1", fromAddress: "Sender <sender@example.com>", subject: "Hello", html: "<p>Hello</p>" },
      recipients: { count: 1, key: "campaigns/campaign-1/recipients.ndjson.gz", sha256: "a".repeat(64) },
      batches: planRecipientBatches(1, 1),
    };
    value.approvalSha256 = campaignApprovalDigest(value);
    const manifest = validateCampaignManifest(value, "campaign-1");
    expect(manifest.recipients.count).toBe(1);
    expect(validateRecipient({ email: "Ada@Example.com", merge: { company: "Analytical Engines" } })).toMatchObject({ email: "ada@example.com" });
  });

  it("summarizes durable states and classifies SES outcomes", () => {
    expect(summarizeCampaignState([{ status: "ACCEPTED" }, { status: "CLAIMED" }, { status: "RETRY" }])).toMatchObject({ accepted: 1, claimed: 1, retry: 1 });
    expect(classifyNativeSesResult({ Status: "SUCCESS", MessageId: "m-1" }, 1, 5)).toMatchObject({ status: "ACCEPTED" });
    expect(classifyNativeSesResult({ Status: "ACCOUNT_THROTTLED", Error: "slow" }, 1, 5)).toMatchObject({ status: "RETRY" });
  });
});
