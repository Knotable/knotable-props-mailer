import { describe, expect, it } from "vitest";
import { evaluateSesCapacity, requiredSesCapacity } from "./readiness-core.mjs";

describe("150k SES readiness policy", () => {
  it("requires a 20% daily-quota buffer and enough rate for a one-hour run", () => {
    expect(requiredSesCapacity({ audience: 150_000 })).toEqual({
      requiredDailyQuota: 180_000,
      requiredSesRate: 47,
    });
  });

  it("fails either insufficient rolling headroom or send rate", () => {
    expect(evaluateSesCapacity({ audience: 150_000, max24Hour: 180_000, sentLast24Hours: 40_000, maxRate: 50 })).toMatchObject({
      quotaReady: false,
      rateReady: true,
      headroom: 140_000,
    });
    expect(evaluateSesCapacity({ audience: 150_000, max24Hour: 200_000, sentLast24Hours: 0, maxRate: 15 })).toMatchObject({
      quotaReady: true,
      rateReady: false,
    });
  });
});
