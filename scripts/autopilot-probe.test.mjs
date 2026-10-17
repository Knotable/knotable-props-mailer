import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createFakeBackend } from "./lib/test-support/fake-backend.mjs";
let backend;
let url;
let scratch;
beforeEach(async () => { backend = createFakeBackend(); url = await backend.start(); scratch = await mkdtemp(path.join(tmpdir(), "props-probe-test-")); });
afterEach(async () => { await backend.stop(); await rm(scratch, { recursive: true, force: true }); });
function seed(value) { backend.tables.app_settings.push({ key: `send_autopilot:${value.emailId}`, value }); }
async function probe(env = {}) {
  const output = path.join(scratch, "output");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/autopilot-probe.mjs"], { env: { PATH: process.env.PATH, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: "service", GITHUB_OUTPUT: output, ...env }, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`probe exited ${code}`)));
  });
  return (await readFile(output, "utf8")).trim();
}
it("wakes cleanup after the report even when there is no send due", async () => {
  seed({ emailId: "done", state: "complete", reportSentAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  expect(await probe()).toBe("due=true");
});
it("honors disabled cleanup", async () => {
  seed({ emailId: "done", state: "complete", reportSentAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  expect(await probe({ SES_COMPACT_HISTORY: "off" })).toBe("due=false");
});
it("does not start an idle worker while a successor waits for completion", async () => {
  seed({ emailId: "parent", approvalId: "a", state: "running", heartbeatAt: new Date().toISOString() });
  seed({ emailId: "child", state: "waiting_campaign", afterCampaign: { emailId: "parent", approvalId: "a", delayMinutes: 0 } });
  expect(await probe()).toBe("due=false");
});
it("wakes the successor after completion and the delay", async () => {
  seed({ emailId: "parent", approvalId: "a", state: "complete", completedAt: new Date(Date.now() - 13 * 3_600_000).toISOString() });
  seed({ emailId: "child", state: "waiting_campaign", afterCampaign: { emailId: "parent", approvalId: "a", delayMinutes: 720 } });
  expect(await probe()).toBe("due=true");
});
