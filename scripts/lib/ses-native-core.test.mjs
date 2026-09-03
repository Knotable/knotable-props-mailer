import { describe, expect, it } from "vitest";
import {
  campaignConfirmation,
  campaignApprovalDigest,
  classifyNativeSesResult,
  normalizeEmail,
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
  });

  it("validates campaign and recipient records", () => {
    const value = {
      schemaVersion: 1,
      source: { listIds: ["list-1"] },
      campaign: { id: "campaign-1", fromAddress: "Sender <sender@example.com>", subject: "Hello", html: "<p>Hello</p>" },
      recipients: { count: 1, key: "campaigns/campaign-1/recipients.ndjson.gz", sha256: "a".repeat(64) },
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
