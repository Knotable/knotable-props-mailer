import { describe, expect, it } from "vitest";
import { campaignContentDigest, findStreetAddressMentions, privacyWarning } from "./campaignGovernance";

describe("campaign governance", () => {
  it("binds a digest to every approval-relevant content field", () => {
    const base = { from: "A <a@example.com>", replyTo: null, subject: "Hello", html: "<p>10:00am</p>", text: "10:00am", tags: ["news"], campaigns: ["event"] };
    expect(campaignContentDigest(base)).not.toBe(campaignContentDigest({ ...base, html: "<p>11:00am</p>" }));
  });

  it("flags likely precise street addresses without flagging a venue name", () => {
    expect(findStreetAddressMentions("Meet at 123 Main Street, New York.")).toContain("123 Main Street");
    expect(privacyWarning("Meet at LifeX, 123 Main Street.")).toContain("Location shared with registered guests");
    expect(privacyWarning("Meet at LifeX in Manhattan.")).toBeNull();
  });
});
