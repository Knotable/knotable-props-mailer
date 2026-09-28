import { describe, expect, it } from "vitest";
import {
  autopilotKey,
  availableQuota,
  campaignContentDigest,
  classifySendException,
  createBackoff,
  createPacer,
  effectiveRate,
  emailIdFromKey,
  formatDuration,
  isRecordDue,
  orderDueRecords,
} from "./autopilot-core.mjs";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

describe("autopilot core", () => {
  it("round-trips control record keys", () => {
    const id = "0949ffd6-044c-42e9-97ba-585a72281c6a";
    expect(emailIdFromKey(autopilotKey(id))).toBe(id);
    expect(emailIdFromKey("daily_send_limit")).toBeNull();
  });

  it("changes the content digest when any sent field changes", () => {
    const base = { from_address: "a@x.co", reply_to: null, subject: "Hi", html: "<p>x</p>", text: "x" };
    const digest = campaignContentDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(campaignContentDigest({ ...base })).toBe(digest);
    for (const field of ["from_address", "reply_to", "subject", "html", "text"]) {
      expect(campaignContentDigest({ ...base, [field]: "changed" })).not.toBe(digest);
    }
  });

  it("schedules only active, unowned, un-deferred records, oldest approval first", () => {
    const records = [
      { emailId: "b", state: "approved", approvedAt: "2026-09-28T10:00:00Z" },
      { emailId: "a", state: "approved", approvedAt: "2026-09-28T09:00:00Z" },
      { emailId: "live", state: "running", heartbeatAt: minutesAgo(1) },
      { emailId: "crashed", state: "running", heartbeatAt: minutesAgo(10), approvedAt: "2026-09-28T11:00:00Z" },
      { emailId: "quota", state: "waiting_quota", nextCheckAt: minutesAgo(-5) },
      { emailId: "quota-ready", state: "waiting_quota", nextCheckAt: minutesAgo(1), approvedAt: "2026-09-28T11:30:00Z" },
      { emailId: "done", state: "complete" },
      { emailId: "paused", state: "paused" },
    ];
    expect(orderDueRecords(records, NOW, 3 * 60_000).map((record) => record.emailId)).toEqual(["a", "b", "crashed", "quota-ready"]);
    expect(isRecordDue({ state: "blocked" }, NOW)).toBe(false);
  });

  it("keeps a quota reserve and never goes negative", () => {
    expect(availableQuota({ max24HourSend: 65_400, sentLast24Hours: 60_000, reserve: 500 })).toBe(4_900);
    expect(availableQuota({ max24HourSend: 65_400, sentLast24Hours: 65_300, reserve: 500 })).toBe(0);
  });

  it("stays below 90% of the SES rate", () => {
    expect(effectiveRate({ sesMaxSendRate: 15, requestedRate: 13 })).toBe(13);
    expect(effectiveRate({ sesMaxSendRate: 15, requestedRate: 50 })).toBe(13.5);
    expect(effectiveRate({ sesMaxSendRate: 15, requestedRate: undefined })).toBe(13.5);
  });

  it("paces sends as a token bucket that credits time spent elsewhere", async () => {
    let clock = 0;
    const waits = [];
    const pacer = createPacer(10, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    await pacer.take(10);
    await pacer.take(10);
    expect(waits).toEqual([1000]);
    clock += 5_000;
    await pacer.take(10);
    expect(waits).toEqual([1000]);
  });

  it("backs off exponentially while the database is slow and resets when healthy", () => {
    const backoff = createBackoff({ slowMs: 1_000, basePauseMs: 10, maxPauseMs: 40, healthyToReset: 2 });
    expect(backoff.observe({ latencyMs: 5_000 })).toBe(10);
    expect(backoff.observe({ latencyMs: 100, retried: true })).toBe(20);
    expect(backoff.observe({ latencyMs: 5_000 })).toBe(40);
    expect(backoff.observe({ latencyMs: 5_000 })).toBe(40);
    expect(backoff.observe({ latencyMs: 10 })).toBe(0);
    expect(backoff.observe({ latencyMs: 10 })).toBe(0);
    expect(backoff.currentPauseMs).toBe(0);
  });

  it("never treats a response-less SES failure as safe to retry", () => {
    expect(classifySendException({ name: "TimeoutError", message: "socket hang up", $metadata: {} }).kind).toBe("ambiguous");
    expect(classifySendException({ code: "ECONNREFUSED", message: "refused" }).kind).toBe("retryable");
    expect(classifySendException({ name: "TooManyRequestsException", message: "Maximum sending rate exceeded", $metadata: { httpStatusCode: 400 } }).kind).toBe("retryable");
    expect(classifySendException({ name: "LimitExceededException", message: "Daily message quota exceeded", $metadata: { httpStatusCode: 400 } }).kind).toBe("quota");
    expect(classifySendException({ name: "BadRequestException", message: "Illegal address", $metadata: { httpStatusCode: 400 } }).kind).toBe("rejected");
    expect(classifySendException({ name: "InternalFailure", message: "oops", $metadata: { httpStatusCode: 500 } }).kind).toBe("retryable");
  });

  it("formats ETAs", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(3_900)).toBe("1h 5m");
  });
});

describe("deliverability guards", () => {
  it("trips on complaint or hard-bounce spikes only after a meaningful sample", async () => {
    const { evaluateDeliverability } = await import("./autopilot-core.mjs");
    expect(evaluateDeliverability({ accepted: 100, hardBounces: 50, complaints: 5 }).trip).toBe(false);
    expect(evaluateDeliverability({ accepted: 1_000, hardBounces: 20, complaints: 1 }).trip).toBe(false);
    expect(evaluateDeliverability({ accepted: 1_000, hardBounces: 90, complaints: 0 })).toMatchObject({ trip: true, reason: expect.stringMatching(/Hard-bounce/) });
    expect(evaluateDeliverability({ accepted: 1_000, hardBounces: 0, complaints: 4 })).toMatchObject({ trip: true, reason: expect.stringMatching(/Complaint/) });
  });

  it("cancels recipients suppressed on their own list or blocked anywhere", async () => {
    const { lateSuppressedIds } = await import("./autopilot-core.mjs");
    const items = [
      { id: "1", list_id: "A", payload: { to: "Gone@x.co" } },
      { id: "2", list_id: "A", payload: { to: "other-list@x.co" } },
      { id: "3", list_id: null, payload: { to: "blocked@x.co" } },
      { id: "4", list_id: "A", payload: { to: "fine@x.co" } },
    ];
    const inactive = [
      { list_id: "A", email: "gone@x.co", status: "unsubscribed" },
      { list_id: "B", email: "other-list@x.co", status: "unsubscribed" },
      { list_id: "Z", email: "blocked@x.co", status: "blocked" },
    ];
    expect([...lateSuppressedIds(items, inactive)].sort()).toEqual(["1", "3"]);
  });
});
