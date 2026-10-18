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
        SES_CANARY_WAIT_SECONDS: "0",
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
    expect(waiting.message).toMatch(/40 still to send/);
    expect(backend.ses.notices.map((notice) => notice.Content.Simple.Subject.Data)).toEqual(["[Props Mailer] Progress: Autumn update"]);
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

  it("sends pending rows whose available_at is null", async () => {
    const email = seedCampaign({ recipients: 4 });
    for (const row of rowsFor(email.id).slice(0, 2)) row.available_at = null;
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(4);
    expect(recordFor(email.id).state).toBe("complete");
  });

  it("canary: stops a campaign whose first recipients hard-bounce heavily", async () => {
    backend.ses.bounceEvery = 5;
    const email = seedCampaign({ recipients: 600 });
    const result = await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "100", SES_CANARY_WAIT_SECONDS: "1" });
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(100);
    expect(count(rowsFor(email.id), "pending")).toBe(500);
    expect(recordFor(email.id).state).toBe("blocked");
    expect(recordFor(email.id).message).toMatch(/circuit breaker \(canary\).*Hard-bounce rate 20\.0%/);
    expect(backend.ses.notices[0].Content.Simple.Subject.Data).toMatch(/Blocked/);
  });

  it("canary: samples recipients at random instead of in queue order", async () => {
    const email = seedCampaign({ recipients: 600 });
    const rows = rowsFor(email.id);
    const result = await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "60", SES_CANARY_WAIT_SECONDS: "0" });
    expect(result.code, result.stderr).toBe(0);
    const canary = backend.ses.bulkRequests.filter((request) => !request.dropped)
      .flatMap((request) => request.BulkEmailEntries.map((entry) => entry.Destination.ToAddresses[0])).slice(0, 60);
    const positions = canary.map((address) => rows.findIndex((row) => row.payload.to === address));
    expect(positions.filter((position) => position >= 60).length).toBeGreaterThan(30);
    expect(count(rows, "succeeded")).toBe(600);
  });

  it("canary: SES suppression-list skips do not count as hard bounces", async () => {
    backend.ses.bounceEvery = 5;
    backend.ses.bounceSubType = "OnAccountSuppressionList";
    const email = seedCampaign({ recipients: 600 });
    const result = await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "100", SES_CANARY_WAIT_SECONDS: "1" });
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(600);
    expect(recordFor(email.id)).toMatchObject({ state: "complete", canaryPassed: true });
    expect(recordFor(email.id).deliverability).toMatchObject({ hardBounces: 0, suppressedSkips: expect.any(Number) });
  });

  it("canary: continues at full speed when early signals are healthy", async () => {
    backend.ses.bounceEvery = 200;
    const email = seedCampaign({ recipients: 600 });
    const result = await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "100", SES_CANARY_WAIT_SECONDS: "1" });
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(600);
    expect(recordFor(email.id)).toMatchObject({ state: "complete", canaryPassed: true });
    expect(recordFor(email.id).deliverability).toMatchObject({ accepted: 100, hardBounces: 0, complaints: 0 });
  });

  it("re-approval after a breaker trip judges only new events", async () => {
    backend.ses.bounceEvery = 5;
    const email = seedCampaign({ recipients: 600 });
    await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "100", SES_CANARY_WAIT_SECONDS: "1" });
    expect(recordFor(email.id).state).toBe("blocked");
    backend.ses.bounceEvery = 0;
    const record = recordFor(email.id);
    Object.assign(record, { state: "approved", approvalId: crypto.randomUUID(), approvedRecipients: 500, breakerBaseline: undefined, canaryPassed: undefined });
    const result = await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "100", SES_CANARY_WAIT_SECONDS: "1" });
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(600);
    expect(recordFor(email.id).state).toBe("complete");
  });

  it("cancels recipients who unsubscribed or were blocked after queueing", async () => {
    const email = seedCampaign({ recipients: 5 });
    const listId = crypto.randomUUID();
    const rows = rowsFor(email.id);
    for (const row of rows) row.list_id = listId;
    backend.tables.list_members.push(
      { list_id: listId, email: rows[0].payload.to, status: "unsubscribed" },
      { list_id: crypto.randomUUID(), email: rows[1].payload.to, status: "blocked" },
      { list_id: crypto.randomUUID(), email: rows[2].payload.to, status: "unsubscribed" },
    );
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(rows[0].status).toBe("canceled");
    expect(rows[1].status).toBe("canceled");
    expect(rows[2].status).toBe("succeeded");
    expect(sentDestinations()).not.toContain(rows[0].payload.to);
    expect(recordFor(email.id).state).toBe("complete");
  });

  it("never sends to addresses on the SES account suppression list", async () => {
    const email = seedCampaign({ recipients: 4 });
    const listId = crypto.randomUUID();
    const rows = rowsFor(email.id);
    for (const row of rows) row.list_id = listId;
    for (const row of rows) backend.tables.list_members.push({ id: crypto.randomUUID(), list_id: listId, email: row.payload.to, status: "active" });
    backend.ses.suppressed = [rows[0].payload.to.toUpperCase(), "stranger@example.test"];
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("SES suppression sync: 2 suppressed address(es) checked, 1 list member(s) unsubscribed");
    expect(rows[0].status).toBe("canceled");
    expect(rows.slice(1).every((row) => row.status === "succeeded")).toBe(true);
    expect(sentDestinations()).not.toContain(rows[0].payload.to);
    const sync = backend.tables.app_settings.find((row) => row.key === "ses_suppression_sync");
    expect(sync.value.complete).toBe(true);

    // Throttled: a second run within six hours does not call SES again.
    backend.ses.suppressed = [rows[1].payload.to];
    const again = await runWorker();
    expect(again.stdout).not.toContain("SES suppression sync:");
  });

  it("resumes a partial SES suppression pass from its page token", async () => {
    seedCampaign({ recipients: 2 });
    const target = { id: crypto.randomUUID(), list_id: crypto.randomUUID(), email: "c@x.test", status: "active" };
    backend.tables.list_members.push(target);
    backend.ses.suppressed = ["a@x.test", "b@x.test", "c@x.test"];
    backend.ses.suppressedPageSize = 1;
    const first = await runWorker(["--mode", "autopilot"], { SES_SUPPRESSION_SYNC_BUDGET_MS: "1" });
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("partial; resumes next run");
    let sync = backend.tables.app_settings.find((row) => row.key === "ses_suppression_sync");
    expect(sync.value.resumeToken).toBe("1");
    expect(target.status).toBe("active");

    seedCampaign({ recipients: 2 });
    const second = await runWorker(["--mode", "autopilot"], { SES_SUPPRESSION_SYNC_BUDGET_MS: "600000" });
    expect(second.code, second.stderr).toBe(0);
    expect(backend.ses.suppressionRequests).toEqual([0, 1, 2]);
    sync = backend.tables.app_settings.find((row) => row.key === "ses_suppression_sync");
    expect(sync.value).toMatchObject({ complete: true, resumeToken: null, totalSeenThisPass: 3 });
    expect(target.status).toBe("unsubscribed");
  });

  it("keeps sending when the SES suppression list cannot be read", async () => {
    const email = seedCampaign({ recipients: 3 });
    backend.ses.suppressed = null;
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("SES suppression sync failed");
    expect(rowsFor(email.id).every((row) => row.status === "succeeded")).toBe(true);
  });

  it("waits outside the approval's send window and names the reopening time", async () => {
    const email = seedCampaign({ recipients: 3 });
    const hour = new Date().getUTCHours();
    const pad = (value) => String(value % 24).padStart(2, "0");
    recordFor(email.id).sendWindow = `${pad(hour + 2)}:00-${pad(hour + 3)}:00 UTC`;
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    const record = recordFor(email.id);
    expect(record.state).toBe("waiting_window");
    expect(new Date(record.nextCheckAt).getUTCHours()).toBe((hour + 2) % 24);
  });

  it("alarms once when SES delivery events stop arriving mid-send", async () => {
    const email = seedCampaign({ recipients: 1_200 });
    const result = await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "0", SES_BREAKER_CHECK_SECONDS: "1", SES_BULK_MAX_RECIPIENTS_PER_SECOND: "200" });
    expect(result.code, result.stderr).toBe(0);
    const subjects = backend.ses.notices.map((notice) => notice.Content.Simple.Subject.Data);
    expect(subjects.filter((subject) => /No SES events arriving/.test(subject))).toHaveLength(1);
    expect(recordFor(email.id)).toMatchObject({ state: "complete", eventsBlindNotified: true });
  });

  it("emails a results report once when it falls due", async () => {
    backend.ses.emitDeliveries = true;
    backend.ses.bounceEvery = 10;
    const email = seedCampaign({ recipients: 50 });
    const first = await runWorker(["--mode", "autopilot"], { SES_REPORT_DELAY_HOURS: "0" });
    expect(first.code, first.stderr).toBe(0);
    const subjects = backend.ses.notices.map((notice) => notice.Content.Simple.Subject.Data);
    expect(subjects).toEqual(["[Props Mailer] Sent: Autumn update", "[Props Mailer] Results: Autumn update"]);
    const body = backend.ses.notices[1].Content.Simple.Body.Text.Data;
    expect(body).toContain("Delivered: 50 (100.0%)");
    expect(body).toContain("Bounced: 5 (10.0%)");
    expect(recordFor(email.id).report).toMatchObject({ accepted: 50, delivered: 50, bounced: 5 });
    await runWorker(["--mode", "autopilot"], { SES_REPORT_DELAY_HOURS: "0" });
    expect(backend.ses.notices).toHaveLength(2);
  });

  it("sends the results report even when one analytics query times out", async () => {
    backend.ses.emitDeliveries = true;
    seedCampaign({ recipients: 20 });
    backend.failures.metricTimeout = "opened";
    const result = await runWorker(["--mode", "autopilot"], { SES_REPORT_DELAY_HOURS: "0" });
    expect(result.code, result.stderr).toBe(0);
    const report = backend.ses.notices.find((notice) => notice.Content.Simple.Subject.Data.startsWith("[Props Mailer] Results"));
    expect(report).toBeTruthy();
    const body = report.Content.Simple.Body.Text.Data;
    expect(body).toContain("Opened (unique): unavailable (database query timed out)");
    expect(body).toContain("Delivered: 20 (100.0%)");
  });

  it("stays quiet when delivery events flow", async () => {
    backend.ses.emitDeliveries = true;
    seedCampaign({ recipients: 1_200 });
    const result = await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "0", SES_BREAKER_CHECK_SECONDS: "1", SES_BULK_MAX_RECIPIENTS_PER_SECOND: "200" });
    expect(result.code, result.stderr).toBe(0);
    expect(backend.ses.notices.map((notice) => notice.Content.Simple.Subject.Data)).toEqual(["[Props Mailer] Sent: Autumn update"]);
  });

  it("holds a scheduled campaign until its start time", async () => {
    const email = seedCampaign({ recipients: 3 });
    const record = recordFor(email.id);
    record.startAt = record.nextCheckAt = new Date(Date.now() + 3_600_000).toISOString();
    const early = await runWorker();
    expect(early.code).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    record.startAt = record.nextCheckAt = new Date(Date.now() - 1_000).toISOString();
    const onTime = await runWorker();
    expect(onTime.code, onTime.stderr).toBe(0);
    expect(count(rowsFor(email.id), "succeeded")).toBe(3);
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

  function seedListCampaign({ sendAfterPrepare, approvedMaxRecipients = 1_533 }) {
    const email = seedCampaign({ recipients: 0, status: "queued", approve: false });
    const listA = crypto.randomUUID();
    const listB = crypto.randomUUID();
    const member = (listId, address, status = "active", metadata = {}) =>
      backend.tables.list_members.push({ id: crypto.randomUUID(), list_id: listId, email: address, status, metadata });
    for (let index = 0; index < 1_500; index += 1) member(listA, `a${String(index).padStart(4, "0")}@example.test`, "active", { name: `A ${index}` });
    for (let index = 0; index < 10; index += 1) member(listB, `a${String(index).padStart(4, "0")}@example.test`);
    for (let index = 0; index < 20; index += 1) member(listB, `b${index}@example.test`);
    member(listB, "reminder@fut.io");
    member(listB, "gone@example.test", "unsubscribed");
    member(listB, "excluded@example.test");
    backend.tables.app_settings.push({
      key: autopilotKey(email.id),
      value: {
        emailId: email.id,
        approvalId: crypto.randomUUID(),
        approvedAt: new Date().toISOString(),
        approvedMaxRecipients,
        audience: { listIds: [listA, listB], excludeRecipients: ["Excluded@example.test"] },
        sendAfterPrepare,
        contentSha256: campaignContentDigest(email),
        subject: email.subject,
        state: "preparing",
      },
    });
    return email;
  }

  it("prepares a large multi-list audience in the cloud and sends it, deduplicated", async () => {
    const email = seedListCampaign({ sendAfterPrepare: true });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    const rows = rowsFor(email.id);
    // 1,500 + 20 unique list members + sender copy; overlap, blocked, unsubscribed, and excluded are skipped.
    expect(rows).toHaveLength(1_521);
    expect(count(rows, "succeeded")).toBe(1_521);
    const destinations = sentDestinations();
    expect(new Set(destinations).size).toBe(1_521);
    expect(destinations).not.toContain("reminder@fut.io");
    expect(destinations).not.toContain("gone@example.test");
    expect(destinations).not.toContain("excluded@example.test");
    expect(destinations).toContain("sender@example.test");
    expect(backend.tables.emails.find((row) => row.id === email.id).status).toBe("sent");
    expect(recordFor(email.id).state).toBe("complete");
  });

  it("prepares without sending when the operator only queued", async () => {
    const email = seedListCampaign({ sendAfterPrepare: false });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(count(rowsFor(email.id), "pending")).toBe(1_521);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(recordFor(email.id), recordFor(email.id).message).toMatchObject({ state: "prepared", approvedRecipients: 1_521 });
    expect(backend.tables.emails.find((row) => row.id === email.id).status).toBe("queued");
  });

  it("skips recipients a same-subject campaign already reached, but not test sends or the sender copy", async () => {
    const now = new Date().toISOString();
    const earlier = seedCampaign({ recipients: 0, status: "sent", approve: false });
    earlier.created_at = now;
    earlier.subject = "Autumn update!";
    const sentRow = (to, extra = {}) => ({ id: crypto.randomUUID(), status: "succeeded", payload: { to }, available_at: now, campaign_label: `${earlier.id}:2026-10-16`, ...extra });
    earlier.id && backend.tables.mail_queue.push(
      { email_id: earlier.id, ...sentRow("person0@example.test") },
      { email_id: earlier.id, ...sentRow("person1@example.test") },
      { email_id: earlier.id, ...sentRow("person2@example.test", { campaign_label: `test:${earlier.id}:2026-10-16` }) },
      { email_id: earlier.id, ...sentRow("sender@example.test") },
    );
    const unrelated = seedCampaign({ recipients: 0, status: "sent", approve: false });
    unrelated.created_at = now;
    unrelated.subject = "Winter results";
    backend.tables.mail_queue.push({ email_id: unrelated.id, ...sentRow("person3@example.test") });

    const email = seedCampaign({ recipients: 5, extraRows: [{ id: crypto.randomUUID(), status: "pending", payload: { to: "sender@example.test" }, available_at: HOLD }] });
    email.created_at = now;
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    const destinations = sentDestinations();
    expect(destinations).not.toContain("person0@example.test");
    expect(destinations).not.toContain("person1@example.test");
    expect(destinations).toEqual(expect.arrayContaining(["person2@example.test", "person3@example.test", "person4@example.test", "sender@example.test"]));
    const skipped = rowsFor(email.id).filter((row) => row.status === "canceled");
    expect(skipped).toHaveLength(2);
    expect(skipped[0].last_error).toMatch(new RegExp(`same-subject email \\(campaign ${earlier.id}\\)`));
    expect(recordFor(email.id).state).toBe("complete");
  });

  it("refuses to prepare on top of unsent rows left by a queue for other lists", async () => {
    const email = seedListCampaign({ sendAfterPrepare: true, approvedMaxRecipients: 1_000_000 });
    const staleList = crypto.randomUUID();
    for (let index = 0; index < 25; index += 1) {
      backend.tables.mail_queue.push({
        id: crypto.randomUUID(),
        email_id: email.id,
        list_id: staleList,
        status: "pending",
        payload: { to: `stale${index}@example.test` },
        dedupe_hash: `stale-${email.id}-${index}`,
        available_at: "2999-12-31T23:59:59Z",
        attempts: 0,
        max_attempts: 5,
      });
    }
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(rowsFor(email.id)).toHaveLength(25);
    expect(recordFor(email.id).state).toBe("blocked");
    expect(recordFor(email.id).message).toMatch(/earlier queue for other lists/);
  });

  it("leaves an unqueued draft alone when preparation finishes", async () => {
    const email = seedListCampaign({ sendAfterPrepare: true });
    backend.tables.emails.find((row) => row.id === email.id).status = "draft";
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(backend.tables.emails.find((row) => row.id === email.id).status).toBe("draft");
    expect(recordFor(email.id).state).toBe("paused");
  });

  it("blocks when preparation yields more recipients than approved", async () => {
    const email = seedListCampaign({ sendAfterPrepare: true, approvedMaxRecipients: 100 });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(backend.ses.bulkRequests).toHaveLength(0);
    expect(recordFor(email.id).state).toBe("blocked");
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

  it("records every recipient's outcome on the delivery ledger at checkpoint time", async () => {
    const email = seedCampaign({ recipients: 60 });
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    const ledger = backend.tables.email_deliveries.filter((row) => row.email_id === email.id);
    expect(ledger).toHaveLength(60);
    expect(ledger.every((row) => row.outcome === 1)).toBe(true);
    expect(new Set(ledger.map((row) => row.recipient_hash)).size).toBe(60);
  });

  it("flags deliveries on the ledger instead of storing event rows, and the blind alarm stays quiet", async () => {
    backend.ses.flagDeliveries = true;
    const email = seedCampaign({ recipients: 1_200 });
    const result = await runWorker(["--mode", "autopilot"], { SES_CANARY_RECIPIENTS: "0", SES_BREAKER_CHECK_SECONDS: "1", SES_BULK_MAX_RECIPIENTS_PER_SECOND: "200" });
    expect(result.code, result.stderr).toBe(0);
    expect(backend.ses.notices.map((notice) => notice.Content.Simple.Subject.Data)).toEqual(["[Props Mailer] Sent: Autumn update"]);
    expect(backend.tables.provider_events.filter((row) => row.event_type === "delivered")).toHaveLength(0);
    const flagged = backend.tables.email_deliveries.filter((row) => row.email_id === email.id && (row.flags & 1));
    expect(flagged.length).toBeGreaterThan(0);
  });

  it("compacts a finished, reported campaign into the ledger archive and deletes its queue rows", async () => {
    const email = seedCampaign({ recipients: 60 });
    expect((await runWorker()).code).toBe(0);
    // Not compacted before its report has gone out.
    expect(rowsFor(email.id)).toHaveLength(60);
    recordFor(email.id).reportSentAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(rowsFor(email.id)).toHaveLength(0);
    expect(backend.tables.email_deliveries.filter((row) => row.email_id === email.id)).toHaveLength(0);
    expect(backend.tables.email_delivery_archive.find((row) => row.email_id === email.id)).toMatchObject({ recipients: 60 });
    expect(backend.tables.email_history_rollups.find((row) => row.email_id === email.id)).toMatchObject({ succeeded: 60 });
    expect(recordFor(email.id)).toMatchObject({ state: "complete", compaction: { status: "compacted", queueRowsDeleted: 60, archivedRecipients: 60 } });
    expect(recordFor(email.id).compactedAt).toBeTruthy();
    expect(result.stdout).not.toContain("@example.test");
    // Idempotent: a later run does nothing more.
    const again = await runWorker();
    expect(again.code, again.stderr).toBe(0);
    expect(backend.tables.email_delivery_archive).toHaveLength(1);
  });

  it("does not compact while SES has not been reported on, or when compaction is switched off", async () => {
    const email = seedCampaign({ recipients: 20 });
    expect((await runWorker()).code).toBe(0);
    recordFor(email.id).reportSentAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect((await runWorker(["--mode", "autopilot"], { SES_COMPACT_HISTORY: "off" })).code).toBe(0);
    expect(rowsFor(email.id)).toHaveLength(20);
    expect(recordFor(email.id).compactedAt).toBeUndefined();
  });

  it("never re-sends to recipients a compacted campaign already reached when it is queued again", async () => {
    const email = seedListCampaign({ sendAfterPrepare: true });
    expect((await runWorker()).code).toBe(0);
    const firstWave = sentDestinations().length;
    expect(firstWave).toBe(1_521);
    recordFor(email.id).reportSentAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect((await runWorker()).code).toBe(0);
    expect(rowsFor(email.id)).toHaveLength(0);
    expect(backend.tables.email_delivery_archive[0].recipients).toBe(1_521);

    // Operator queues the same campaign again after adding three people to a list.
    const approval = backend.tables.app_settings.find((row) => row.key === autopilotKey(email.id));
    const audience = { ...approval.value.audience };
    const listId = audience.listIds[0];
    for (const address of ["late1@example.test", "late2@example.test", "late3@example.test"]) {
      backend.tables.list_members.push({ id: crypto.randomUUID(), list_id: listId, email: address, status: "active", metadata: {} });
    }
    backend.tables.emails.find((row) => row.id === email.id).status = "queued";
    approval.value = {
      emailId: email.id,
      approvalId: crypto.randomUUID(),
      approvedAt: new Date().toISOString(),
      approvedMaxRecipients: 50,
      audience,
      sendAfterPrepare: true,
      contentSha256: campaignContentDigest(email),
      subject: email.subject,
      state: "preparing",
    };
    const second = await runWorker();
    expect(second.code, second.stderr).toBe(0);
    const secondWave = sentDestinations().slice(firstWave);
    expect(secondWave.sort()).toEqual(["late1@example.test", "late2@example.test", "late3@example.test"]);
    expect(recordFor(email.id).state).toBe("complete");
  });
});

describe("automatic audience sequencing", { timeout: 90_000 }, () => {
  function link(child, parent, delayMinutes = 0) {
    Object.assign(recordFor(child.id), { state: "waiting_campaign", afterCampaign: { emailId: parent.id, approvalId: recordFor(parent.id).approvalId, delayMinutes } });
    // Distinct content avoids the independent same-subject duplicate guard.
    child.subject = `Next stage ${child.id}`;
    recordFor(child.id).contentSha256 = campaignContentDigest(child);
  }

  it("finishes three approved audiences in order in one run without another click", async () => {
    const first = seedCampaign({ recipients: 2 });
    const second = seedCampaign({ recipients: 2 });
    const third = seedCampaign({ recipients: 2 });
    link(second, first);
    link(third, second);
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    for (const email of [first, second, third]) expect(recordFor(email.id).state).toBe("complete");
    const campaignOrder = backend.ses.bulkRequests.map(request => request.BulkEmailEntries[0].ReplacementTags.find(tag => tag.Name === "campaign_id")?.Value);
    expect(campaignOrder).toEqual([first.id, second.id, third.id]);
  });

  it("keeps the next audience held for 12 hours, then resumes automatically on a later worker", async () => {
    const first = seedCampaign({ recipients: 2 });
    const second = seedCampaign({ recipients: 2 });
    link(second, first, 720);
    expect((await runWorker()).code).toBe(0);
    expect(recordFor(first.id).state).toBe("complete");
    expect(recordFor(second.id).state).toBe("waiting_campaign");
    expect(count(rowsFor(second.id), "pending")).toBe(2);
    recordFor(first.id).completedAt = new Date(Date.now() - 721 * 60_000).toISOString();
    // A campaign-scoped invocation must still load its predecessor's record.
    const result = await runWorker(["--mode", "autopilot", "--email-id", second.id]);
    expect(result.code, result.stderr).toBe(0);
    expect(recordFor(second.id).state).toBe("complete");
  });

  it.each(["paused", "canceled", "blocked", "replaced", "missing"])("does not send the next audience after an earlier approval is %s", async (failure) => {
    const first = seedCampaign({ recipients: 2 });
    const second = seedCampaign({ recipients: 2 });
    link(second, first);
    if (failure === "replaced") recordFor(first.id).approvalId = crypto.randomUUID();
    else if (failure === "missing") backend.tables.app_settings = backend.tables.app_settings.filter(row => row.key !== autopilotKey(first.id));
    else recordFor(first.id).state = failure;
    const result = await runWorker();
    expect(result.code, result.stderr).toBe(0);
    expect(recordFor(second.id).state).toBe("blocked");
    expect(count(rowsFor(second.id), "pending")).toBe(2);
    const childRequests = backend.ses.bulkRequests.filter(request =>
      request.BulkEmailEntries.some(entry =>
        entry.ReplacementTags.some(tag => tag.Name === "campaign_id" && tag.Value === second.id)));
    expect(childRequests).toHaveLength(0);
  });
});
