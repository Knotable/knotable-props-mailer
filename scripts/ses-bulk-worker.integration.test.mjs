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
});
