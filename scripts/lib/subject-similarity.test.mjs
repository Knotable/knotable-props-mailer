import { describe, expect, it } from "vitest";
import { isSameEmailSubject, normalizeSubject, similarCampaignIds, subjectSimilarity } from "./subject-similarity.mjs";

const invite = "LifeX webinar Oct 21: Powerful Medical + Tessel Bio on AI, data and biology";

describe("subject similarity", () => {
  it("treats identical subjects as the same email", () => {
    expect(subjectSimilarity(invite, invite)).toBe(1);
    expect(isSameEmailSubject(invite, invite)).toBe(true);
  });

  it("ignores case, spacing, smart quotes and test/reply prefixes", () => {
    expect(normalizeSubject("  [TEST]  Re:  LifeX’s   Update ")).toBe("lifex's update");
    expect(isSameEmailSubject(`[TEST] ${invite}`, invite)).toBe(true);
    expect(isSameEmailSubject(invite.toUpperCase(), invite)).toBe(true);
  });

  it("matches small edits (>= 90% similar)", () => {
    const edited = "LifeX webinar Oct 21: Powerful Medical & Tessel Bio on AI, data + biology";
    expect(subjectSimilarity(invite, edited)).toBeGreaterThanOrEqual(0.9);
    expect(isSameEmailSubject(invite, edited)).toBe(true);
    expect(isSameEmailSubject("Final Reminder: LifeX AGM: Health AI's leading CEOs", "LifeX AGM: Health AI's leading CEOs")).toBe(false);
  });

  it("does not match different emails in the same series", () => {
    expect(isSameEmailSubject(invite, "LifeX update: portfolio exits, new financings and Fund II")).toBe(false);
    expect(isSameEmailSubject("LifeX webinar Oct 21", "LifeX webinar Nov 18")).toBe(false);
  });

  it("selects only other campaigns with a matching subject", () => {
    const candidates = [
      { id: "self", subject: invite },
      { id: "copy", subject: invite },
      { id: "tweak", subject: `${invite}!` },
      { id: "other", subject: "LifeX update: portfolio exits, new financings and Fund II" },
    ];
    expect(similarCampaignIds(invite, candidates, "self")).toEqual(["copy", "tweak"]);
  });
});
