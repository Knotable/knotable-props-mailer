import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeAnalyticsFailure, formatCampaignMetric } from "./analyticsAvailability";

describe("analytics availability", () => {
  it("distinguishes a statement timeout from a missing migration", () => {
    expect(describeAnalyticsFailure({ code: "57014", message: "canceling statement due to statement timeout" })).toMatchObject({
      kind: "timeout",
      code: "57014",
    });
    expect(describeAnalyticsFailure({ code: "PGRST202", message: "Could not find the function" })).toMatchObject({
      kind: "missing",
      code: "PGRST202",
    });
  });

  it("never renders unavailable campaign totals as zero", () => {
    expect(formatCampaignMetric(0, false)).toBe("—");
    expect(formatCampaignMetric(0, true)).toBe("0");
    expect(formatCampaignMetric(0, true, true)).toBe("—");
    expect(formatCampaignMetric(12_399, true)).toBe("12,399");
  });

  it("ships a set-based replacement for the timed-out recent analytics RPC", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260904_set_based_recent_analytics.sql"),
      "utf8",
    );
    expect(migration).toContain("live_queue as materialized");
    expect(migration).toContain("live_events as materialized");
    expect(migration).not.toContain("join lateral");
  });
});
