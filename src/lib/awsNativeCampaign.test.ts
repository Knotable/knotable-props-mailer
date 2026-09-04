import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("AWS-native control-plane safety", () => {
  it("keeps app dispatch behind current admin/send permission and AWS control-state verification", () => {
    const actions = source("src/app/(dashboard)/email/aws-native/actions.ts");
    expect(actions).toContain('AWS_NATIVE_CONTROL_ENABLED !== "true"');
    expect(actions).toContain("requireAdminAuthContext");
    expect(actions).toContain("auth.canSend");
    expect(actions).toContain("getNativeCampaignStatus");
    expect(actions).toContain("status.manifestKey !== input.manifestKey");
  });

  it("binds worker dispatch to the exact batch and never uses static AWS keys", () => {
    const workflow = source(".github/workflows/ses-native-worker.yml");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("role-to-assume:");
    expect(workflow).toContain("--batch-number");
    expect(workflow).not.toContain("AWS_ACCESS_KEY_ID:");
    expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY:");
  });

  it("refuses dual queue ownership and emits per-recipient RFC 8058 headers", () => {
    const builder = source("scripts/build-ses-native-campaign.mjs");
    const worker = source("scripts/ses-native-worker.mjs");
    expect(builder).toContain("Refusing dual execution ownership");
    expect(builder).toContain("schemaVersion: 2");
    expect(worker).toContain('Name: "List-Unsubscribe-Post"');
    expect(worker).toContain('Value: "List-Unsubscribe=One-Click"');
    expect(worker).toContain("requiredHeadroom");
    expect(worker).toContain("ProductionAccessEnabled !== true");
  });

  it("records notification ambiguity instead of automatically retrying it", () => {
    const worker = source("scripts/ses-native-worker.mjs");
    expect(worker).toContain('operator_notice_state = :ambiguous');
    expect(worker).toContain("it will not be retried automatically");
    expect(worker).toContain("operator_notice_sent_at");
  });
});
