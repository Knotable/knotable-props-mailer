import { describe, expect, it } from "vitest";
import { EMPTY_ACTIVITY, getFlaggedEventActivity, laterOf, summarizeCounters } from "./eventActivity";

const rows = [
  { day: "2026-09-30", event_type: "delivered", events: 120, updated_at: "2026-09-30T12:00:00Z" },
  { day: "2026-09-30", event_type: "opened", events: "30", updated_at: "2026-09-30T12:05:00Z" },
  { day: "2026-09-10", event_type: "opened", events: 70, updated_at: "2026-09-10T08:00:00Z" },
];

describe("summarizeCounters", () => {
  it("separates the recent window from all-time and tracks the latest event", () => {
    const activity = summarizeCounters(rows, "2026-09-23T00:00:00Z");
    expect(activity.total).toBe(220);
    expect(activity.recent).toBe(150);
    expect(activity.totalByType.opened).toBe(100);
    expect(activity.recentByType.opened).toBe(30);
    expect(activity.latestAt).toBe("2026-09-30T12:05:00Z");
  });

  it("is empty for no rows", () => {
    expect(summarizeCounters([], "2026-09-23T00:00:00Z")).toEqual(EMPTY_ACTIVITY);
  });
});

describe("getFlaggedEventActivity", () => {
  it("reads the counter table", async () => {
    const client = { from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) };
    expect((await getFlaggedEventActivity(client, "2026-09-23T00:00:00Z")).recent).toBe(150);
  });

  it("returns zeros when the table is missing or the call throws", async () => {
    const missing = { from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: null, error: { code: "42P01" } }) }) }) }) };
    expect(await getFlaggedEventActivity(missing, "2026-09-23T00:00:00Z")).toEqual(EMPTY_ACTIVITY);
    const broken = { from: () => { throw new Error("boom"); } };
    expect(await getFlaggedEventActivity(broken, "2026-09-23T00:00:00Z")).toEqual(EMPTY_ACTIVITY);
  });
});

describe("laterOf", () => {
  it("picks the later timestamp and tolerates nulls", () => {
    expect(laterOf("2026-09-30T00:00:00Z", "2026-09-29T00:00:00Z")).toBe("2026-09-30T00:00:00Z");
    expect(laterOf(null, "2026-09-29T00:00:00Z")).toBe("2026-09-29T00:00:00Z");
    expect(laterOf(undefined, null)).toBeNull();
  });
});
