import { describe, expect, it } from "vitest";
import { assertSendReadySubject, subjectPlaceholderTerms } from "./subjectReadiness";

describe("send-ready subjects", () => {
  it("blocks draft and test markers regardless of case", () => {
    expect(subjectPlaceholderTerms("Draft v2: Portfolio news")).toEqual(["draft"]);
    expect(subjectPlaceholderTerms("TEST — August newsletter")).toEqual(["test"]);
  });

  it("allows normal subjects and version-like text without a placeholder marker", () => {
    expect(subjectPlaceholderTerms("The science budget survived. The operating system changed.")).toEqual([]);
    expect(subjectPlaceholderTerms("LifeX v2 portfolio update")).toEqual([]);
  });

  it("returns an actionable blocking error", () => {
    expect(() => assertSendReadySubject("Placeholder draft")).toThrow(
      "Subject is not send-ready: remove placeholder terms draft, placeholder.",
    );
  });
});
