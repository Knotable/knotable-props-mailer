import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAMPAIGN_ANALYTICS_METRICS,
  emptyCampaignAnalyticsSnapshot,
  isCampaignAnalyticsFresh,
  metricRate,
} from "./lazyAnalytics";

describe("lazy campaign analytics", () => {
  it("refreshes one bounded metric sequence per campaign", () => {
    expect(CAMPAIGN_ANALYTICS_METRICS).toEqual([
      "queue",
      "delivered",
      "opened",
      "clicked",
      "bounced",
      "complained",
    ]);
  });

  it("uses a transparent fifteen-minute browser cache", () => {
    const snapshot = emptyCampaignAnalyticsSnapshot("2026-09-04T12:00:00.000Z");
    expect(isCampaignAnalyticsFresh(snapshot, new Date("2026-09-04T12:14:59.000Z").getTime())).toBe(true);
    expect(isCampaignAnalyticsFresh(snapshot, new Date("2026-09-04T12:15:00.000Z").getTime())).toBe(false);
  });

  it("does not invent rates without an accepted denominator", () => {
    expect(metricRate(50, 100)).toBe(50);
    expect(metricRate(null, 100)).toBeNull();
    expect(metricRate(2, 0)).toBeNull();
  });

  it("keeps service-role analytics behind an explicit admin endpoint", () => {
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/email/analytics/[emailId]/route.ts"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260904_lazy_campaign_analytics.sql"),
      "utf8",
    );
    expect(route).toContain("requireAdminAuthContext");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });
});
