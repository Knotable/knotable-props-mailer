import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "./lib/test-support/fake-backend.mjs";
import { AMBIGUOUS_CLAIM_PREFIX, autopilotKey, campaignContentDigest, WORKER_LEASE_KEY } from "./lib/autopilot-core.mjs";

const WORKER = fileURLToPath(new URL("./ses-bulk-worker.mjs", import.meta.url));
const HOLD = "2999-12-31T23:59:59.000Z";

let backend;
let baseUrl;

function runWorker(args = ["--mode", "autopilot"], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, ...args], {
      env: {
        PATH: process.env.PATH,
        SUPABASE_URL: baseUrl,
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        APP_BASE_URL: "https://mailer.test",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_ENDPOINT_URL: baseUrl,
        SES_BULK_MAX_RECIPIENTS_PER_SECOND: "1000",
        SES_QUOTA_RESERVE: "0",
        SES_OPERATOR_EMAIL: "ops@example.test",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`worker timed out\n${stdout}\n${stderr}`)); }, 60_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function seedCampaign({ recipients = 10, status = "sending", approve = true, digestOverride, extraRows = [] } = {}) {
  const email = {
    id: crypto.randomUUID(),
    from_address: "Sender <sender@example.test>",
    reply_to: "reply@example.test",
    subject: "Autumn update",
    html: "<p>Hello {{firstName | friend}}</p>",
    text: "Hello {{firstName | friend}}",
    status,
    tags: [],
    campaigns: [],
  };
  backend.tables.emails.push(email);
  const created = Date.parse("2026-09-01T00:00:00Z");
  for (let index = 0; index < recipients; index += 1) {
    backend.tables.mail_queue.push({
      id: crypto.randomUUID(),
      email_id: email.id,
      list_id: null,
      payload: { to: `person${index}@example.test`, toName: `Person ${index}` },
      status: "pending",
      attempts: 0,
      max_attempts: 5,
      available_at: HOLD,
      locked_at: null,
      correlation_id: null,
      ses_message_id: null,
      last_error: null,
      created_at: new Date(created + index).toISOString(),
      updated_at: new Date(created + index).toISOString(),
    });
  }
  for (const row of extraRows) backend.tables.mail_queue.push({ email_id: email.id, attempts: 0, max_attempts: 5, list_id: null, ...row });
  if (approve) {
    backend.tables.app_settings.push({
      key: autopilotKey(email.id),
      value: {
        emailId: email.id,
        approvalId: crypto.randomUUID(),
        approvedAt: new Date().toISOString(),
        approvedRecipients: recipients,
        contentSha256: digestOverride ?? campaignContentDigest(email),
        subject: email.subject,
        state: "approved",
      },
    });
  }
  return email;
}

const rowsFor = (emailId) => backend.tables.mail_queue.filter((row) => row.email_id === emailId);
const recordFor = (emailId) => backend.tables.app_settings.find((row) => row.key === autopilotKey(emailId))?.value;
const sentDestinations = () => backend.ses.bulkRequests.filter((request) => !request.dropped)
  .flatMap((request) => request.BulkEmailEntries.map((entry) => entry.Destination.ToAddresses[0]));
const count = (rows, status) => rows.filter((row) => row.status === status).length;

beforeEach(async () => {
  backend = createFakeBackend();
  baseUrl = await backend.start();
});

afterEach(async () => {
  await backend.stop();
});

describe("SES autopilot worker (end to end against fakes)", { timeout: 90_000 }, () => {
  it("drains an approved campaign exactly once, marks it sent, and notifies the operator", async () => {
    const email = seedCampaign({ recipients: 120 });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    const rows = rowsFor(email.id);
    expect(count(rows, "succeeded")).toBe(120);
    const destinations = sentDestinations();
    expect(destinations).toHaveLength(120);
    expect(new Set(destinations).size).toBe(120);
    expect(backend.tables.emails[0].status).toBe("sent");
    expect(recordFor(email.id).state).toBe("complete");
    expect(backend.ses.notices).toHaveLength(1);
    expect(backend.ses.notices[0].Destination.ToAddresses).toEqual(["ops@example.test"]);
    expect(backend.tables.app_settings.find((row) => row.key === WORKER_LEASE_KEY).value.token).toBeNull();
    expect(result.stdout).not.toContain("@example.test");
  });

  it("never sends a campaign that is 'sending' but has no app approval", async () => {
    const email = seedCampaign({ recipients: 5, approve: false });
    const result = await runWorker();
    expect(result.code).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(count(rowsFor(email.id), "pending")).toBe(5);
  });

  it("parks stale claims from a crashed worker as ambiguous and never resends them", async () => {
    const lockedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const stale = [0, 1, 2].map((index) => ({
      id: crypto.randomUUID(),
      payload: { to: `stale${index}@example.test` },
      status: "processing",
      locked_at: lockedAt,
      correlation_id: "ses-bulk:old-run",
      available_at: HOLD,
      created_at: lockedAt,
    }));
    const email = seedCampaign({ recipients: 7, extraRows: stale });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    const rows = rowsFor(email.id);
    expect(count(rows, "succeeded")).toBe(7);
    const parked = rows.filter((row) => row.status === "dead");
    expect(parked).toHaveLength(3);
    expect(parked.every((row) => row.last_error.startsWith(AMBIGUOUS_CLAIM_PREFIX))).toBe(true);
    expect(sentDestinations().some((address) => address.startsWith("stale"))).toBe(false);
    expect(recordFor(email.id).state).toBe("complete");
  });

  it("waits for fresh claims instead of racing another worker", async () => {
    const lockedAt = new Date(Date.now() - 60_000).toISOString();
    const email = seedCampaign({
      recipients: 4,
      extraRows: [{ id: crypto.randomUUID(), payload: { to: "inflight@example.test" }, status: "processing", locked_at: lockedAt, correlation_id: "ses-bulk:live", available_at: HOLD, created_at: lockedAt }],
    });
    const result = await runWorker();
    expect(result.code).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(recordFor(email.id).state).toBe("waiting_reconcile");
    expect(Date.parse(recordFor(email.id).nextCheckAt)).toBeGreaterThan(Date.now());
  });

  it("sends what the SES rolling quota allows, then waits and resumes on a later run", async () => {
    backend.ses.quota = { Max24HourSend: 1_000, MaxSendRate: 1_000, SentLast24Hours: 940 };
    const email = seedCampaign({ recipients: 100 });
    const first = await runWorker();
    expect(first.code, first.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(60);
    expect(count(rowsFor(email.id), "pending")).toBe(40);
    const waiting = recordFor(email.id);
    expect(waiting.state).toBe("waiting_quota");
    expect(backend.tables.emails[0].status).toBe("sending");

    backend.ses.quota.SentLast24Hours = 0;
    waiting.nextCheckAt = new Date(Date.now() - 1_000).toISOString();
    const second = await runWorker();
    expect(second.code, second.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(100);
    expect(new Set(sentDestinations()).size).toBe(100);
    expect(recordFor(email.id).state).toBe("complete");
  });

  it("blocks when the email content changed after approval", async () => {
    const email = seedCampaign({ recipients: 3, digestOverride: "0".repeat(64) });
    const result = await runWorker();
    expect(result.code).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(recordFor(email.id).state).toBe("blocked");
    expect(backend.ses.notices).toHaveLength(1);
  });

  it("stops when the operator paused the campaign", async () => {
    const email = seedCampaign({ recipients: 3, status: "queued" });
    const result = await runWorker();
    expect(result.code).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(recordFor(email.id).state).toBe("paused");
  });

  it("retries SES throttling rejections without duplicate delivery", async () => {
    backend.ses.throttleNext = 2;
    const email = seedCampaign({ recipients: 30 });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(30);
    expect(sentDestinations()).toHaveLength(30);
  });

  it("treats a dropped SES connection as ambiguous and never resends those recipients", async () => {
    backend.ses.dropConnectionNext = 1;
    const email = seedCampaign({ recipients: 60 });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    const rows = rowsFor(email.id);
    const dropped = backend.ses.bulkRequests.find((request) => request.dropped).BulkEmailEntries.map((entry) => entry.Destination.ToAddresses[0]);
    expect(dropped.length).toBeGreaterThan(0);
    expect(count(rows, "dead")).toBe(dropped.length);
    expect(count(rows, "succeeded")).toBe(60 - dropped.length);
    expect(sentDestinations().filter((address) => dropped.includes(address))).toHaveLength(0);
  });

  it("recovers from a failed checkpoint response", async () => {
    backend.failures.finalizeNext = 1;
    const email = seedCampaign({ recipients: 10 });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(10);
    expect(sentDestinations()).toHaveLength(10);
  });

  it("keeps recipients retryable when SES reports the account daily quota", async () => {
    backend.ses.entryStatus = "ACCOUNT_DAILY_QUOTA_EXCEEDED";
    const email = seedCampaign({ recipients: 5 });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    const rows = rowsFor(email.id);
    expect(count(rows, "pending")).toBe(5);
    expect(count(rows, "dead")).toBe(0);
    expect(recordFor(email.id).state).toBe("waiting_quota");
  });

  it("supports a one-shot manual send dispatch", async () => {
    const email = seedCampaign({ recipients: 8, status: "queued", approve: false });
    const result = await runWorker(["--mode", "send", "--email-id", email.id, "--confirmation", `send:${email.id}`]);
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(8);
    expect(recordFor(email.id).state).toBe("complete");
  });

  it("exits without sending while another worker holds a live lease", async () => {
    backend.tables.app_settings.push({ key: WORKER_LEASE_KEY, value: { token: "other", expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const email = seedCampaign({ recipients: 3 });
    const result = await runWorker();
    expect(result.code).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(count(rowsFor(email.id), "pending")).toBe(3);
  });

  it("drains several approved campaigns oldest-approval first in one run", async () => {
    const first = seedCampaign({ recipients: 5 });
    const second = seedCampaign({ recipients: 5 });
    recordFor(second.id).approvedAt = "2026-09-28T09:00:00.000Z";
    recordFor(first.id).approvedAt = "2026-09-28T10:00:00.000Z";
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(recordFor(first.id).state).toBe("complete");
    expect(recordFor(second.id).state).toBe("complete");
    const order = backend.ses.bulkRequests.map((request) => request.BulkEmailEntries[0].ReplacementTags.find((tag) => tag.Name === "campaign_id").Value);
    expect(order[0]).toBe(second.id);
  });
});
