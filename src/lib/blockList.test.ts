import { describe, expect, it } from "vitest";
import { isBlockedRecipientEmail } from "./blockList";

describe("block list domain rules", () => {
  it("blocks follow-up reminder service domains", () => {
    expect(isBlockedRecipientEmail("person@followupthen.com")).toBe(true);
    expect(isBlockedRecipientEmail("PERSON@FUT.IO")).toBe(true);
  });

  it("does not block unrelated or lookalike domains", () => {
    expect(isBlockedRecipientEmail("person@example.com")).toBe(false);
    expect(isBlockedRecipientEmail("person@notfut.io")).toBe(false);
    expect(isBlockedRecipientEmail("person@sub.followupthen.com")).toBe(false);
  });
});
