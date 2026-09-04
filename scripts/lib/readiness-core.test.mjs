import { describe, expect, it } from "vitest";
import { evaluateSesCapacity, planCampaignBatches, requiredSesCapacity } from "./readiness-core.mjs";

describe("approval-gated SES batch policy", () => {
  it("partitions 150k deterministically into three 50k approval batches", () => {
    expect(planCampaignBatches({ audience: 150_000 })).toEqual([
      { batchNumber: 1, size: 50_000, releaseState: "READY_FOR_APPROVAL" },
      { batchNumber: 2, size: 50_000, releaseState: "QUEUED_FOR_APPROVAL" },
      { batchNumber: 3, size: 50_000, releaseState: "QUEUED_FOR_APPROVAL" },
    ]);
  });

  it("assigns remainder recipients without overlap or omission", () => {
    const plan = planCampaignBatches({ audience: 10, batches: 3 });
    expect(plan.map((batch) => batch.size)).toEqual([4, 3, 3]);
    expect(plan.reduce((sum, batch) => sum + batch.size, 0)).toBe(10);
  });

  it("requires a 20% batch quota buffer and enough rate for a 75-minute batch", () => {
    expect(requiredSesCapacity({ audience: 50_000, maxDurationMinutes: 75 })).toEqual({
      requiredDailyQuota: 60_000,
      requiredRollingHeadroom: 50_001,
      requiredSesRate: 13,
    });
  });

  it("fails either insufficient rolling headroom or send rate", () => {
    expect(evaluateSesCapacity({ audience: 50_000, max24Hour: 60_000, sentLast24Hours: 20_000, maxRate: 15, maxDurationMinutes: 75 })).toMatchObject({
      quotaReady: false,
      rateReady: true,
      headroom: 40_000,
    });
    expect(evaluateSesCapacity({ audience: 50_000, max24Hour: 65_400, sentLast24Hours: 0, maxRate: 10, maxDurationMinutes: 75 })).toMatchObject({
      quotaReady: true,
      rateReady: false,
    });
    expect(evaluateSesCapacity({ audience: 50_000, max24Hour: 65_400, sentLast24Hours: 15_400, maxRate: 15, maxDurationMinutes: 75 })).toMatchObject({
      quotaReady: false,
      headroom: 50_000,
      requiredRollingHeadroom: 50_001,
    });
  });
});
