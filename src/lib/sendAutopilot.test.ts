import { describe, expect, it } from "vitest";
import * as workerCore from "../../scripts/lib/autopilot-core.mjs";
import {
  ACTIVE_AUTOPILOT_STATES,
  AUTOPILOT_KEY_PREFIX,
  autopilotKey,
  campaignContentDigest,
  describeAutopilot,
  type AutopilotRecord,
} from "./sendAutopilot";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const base: AutopilotRecord = { emailId: "e", approvalId: "a", approvedAt: "2026-09-28T11:00:00Z", state: "approved" };

describe("send autopilot contract", () => {
  it("matches the worker's key format, active states, and content digest", () => {
    expect(AUTOPILOT_KEY_PREFIX).toBe(workerCore.AUTOPILOT_KEY_PREFIX);
    expect(autopilotKey("x")).toBe(workerCore.autopilotKey("x"));
    expect([...ACTIVE_AUTOPILOT_STATES]).toEqual(workerCore.ACTIVE_STATES);
    const email = { from_address: "A <a@x.co>", reply_to: "r@x.co", subject: "Hi — there", html: "<p>é</p>", text: null };
    expect(campaignContentDigest(email)).toBe(workerCore.campaignContentDigest(email));
  });

  it("labels live, stale, waiting, and terminal states for operators", () => {
    expect(describeAutopilot({ ...base, state: "running", heartbeatAt: new Date(NOW - 30_000).toISOString() }, NOW)).toMatchObject({ label: "Sending", live: true });
    expect(describeAutopilot({ ...base, state: "running", heartbeatAt: new Date(NOW - 10 * 60_000).toISOString() }, NOW)).toMatchObject({ label: "Restarting", tone: "amber" });
    expect(describeAutopilot({ ...base, state: "waiting_quota" }, NOW)?.label).toBe("Waiting for SES quota");
    expect(describeAutopilot({ ...base, state: "blocked", message: "Content changed" }, NOW)).toMatchObject({ tone: "red", detail: "Content changed" });
    expect(describeAutopilot({ ...base, state: "complete" }, NOW)?.label).toBe("Sent");
    expect(describeAutopilot(null, NOW)).toBeNull();
  });
});
