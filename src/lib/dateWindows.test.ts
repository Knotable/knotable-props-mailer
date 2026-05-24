import { describe, expect, it } from "vitest";
import { buildSendSchedule } from "./dailyQuota";
import { isoDateDaysAgo, isoDaysAgo } from "./dateWindows";
import { parseUuid } from "./ids";
import {
  buildQueueReleaseConfirmation,
  describeQueueReleasePreflight,
  isQueueReleaseConfirmed,
} from "./queueReleaseGuard";

describe("date window helpers", () => {
  const fixedNow = Date.UTC(2026, 4, 4, 12, 0, 0);

  it("returns deterministic ISO timestamps for day windows", () => {
    expect(isoDaysAgo(30, fixedNow)).toBe("2026-04-04T12:00:00.000Z");
    expect(isoDaysAgo(90, fixedNow)).toBe("2026-02-03T12:00:00.000Z");
  });

  it("returns deterministic UTC dates for day windows", () => {
    expect(isoDateDaysAgo(30, fixedNow)).toBe("2026-04-04");
  });
});

describe("buildSendSchedule", () => {
  it("uses remaining quota on the first day, then full daily windows", () => {
    expect(buildSendSchedule(12, 8, "2026-05-04", 10)).toEqual([
      { date: "2026-05-04", count: 2 },
      { date: "2026-05-05", count: 10 },
    ]);
  });

  it("starts on the next day when today's quota is exhausted", () => {
    expect(buildSendSchedule(3, 10, "2026-05-04", 10)).toEqual([
      { date: "2026-05-05", count: 3 },
    ]);
  });
});

describe("queue release guard", () => {
  const emailId = "696a333a-4909-41e8-ad3e-81c2e11b39db";

  it("requires the release token to match the exact email id", () => {
    expect(buildQueueReleaseConfirmation(emailId)).toBe(`release:${emailId}`);
    expect(isQueueReleaseConfirmed(emailId, `release:${emailId}`)).toBe(true);
    expect(isQueueReleaseConfirmed(emailId, "release:aacdd257-4604-4f0c-b13d-54add0aff534")).toBe(false);
    expect(isQueueReleaseConfirmed(emailId, null)).toBe(false);
  });

  it("summarizes preflight counts for release errors and audit context", () => {
    expect(
      describeQueueReleasePreflight({
        pendingDue: 12,
        pendingHeld: 6_111,
        processing: 1,
      }),
    ).toBe("6,124 active queue rows; 12 due; 6,111 held; 1 processing");
  });
});

describe("id helpers", () => {
  it("parses trimmed UUIDs and rejects loose 36-character shapes", () => {
    expect(parseUuid(" 696a333a-4909-41e8-ad3e-81c2e11b39db ")).toBe(
      "696a333a-4909-41e8-ad3e-81c2e11b39db",
    );
    expect(parseUuid("696a333a4909-41e8-ad3e-81c2e11b39db-")).toBeNull();
    expect(parseUuid("not-a-uuid")).toBeNull();
    expect(parseUuid(null)).toBeNull();
  });
});
