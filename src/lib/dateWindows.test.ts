import { describe, expect, it } from "vitest";
import { buildSendSchedule } from "./dailyQuota";
import { isoDateDaysAgo, isoDaysAgo } from "./dateWindows";

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
