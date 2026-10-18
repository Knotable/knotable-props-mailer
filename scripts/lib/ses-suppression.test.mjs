import { describe, expect, it } from "vitest";
import { chunk, normalizeSuppressedAddresses, suppressionSyncDue } from "./ses-suppression.mjs";

describe("SES suppression sync helpers", () => {
  it("normalizes and dedupes suppressed addresses", () => {
    expect(normalizeSuppressedAddresses([
      { EmailAddress: " Gone@Example.com " },
      { EmailAddress: "gone@example.com" },
      { EmailAddress: "not-an-address" },
      {},
    ])).toEqual(["gone@example.com"]);
  });

  it("runs at most every six hours, and immediately the first time", () => {
    const now = Date.parse("2026-10-18T03:00:00Z");
    expect(suppressionSyncDue(null, now)).toBe(true);
    expect(suppressionSyncDue({ attemptedAt: "2026-10-18T00:00:00Z" }, now)).toBe(false);
    expect(suppressionSyncDue({ attemptedAt: "2026-10-17T20:00:00Z" }, now)).toBe(true);
    expect(suppressionSyncDue({ attemptedAt: "2026-10-18T02:59:00Z", resumeToken: "page-18" }, now)).toBe(true);
    expect(suppressionSyncDue({ attemptedAt: "2026-10-18T02:59:00Z", complete: false, error: null }, now)).toBe(true);
    expect(suppressionSyncDue({ attemptedAt: "2026-10-18T02:59:00Z", complete: true }, now)).toBe(false);
  });

  it("chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
