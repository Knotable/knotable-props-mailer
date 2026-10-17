import { describe, expect, it } from "vitest";
import {
  SEND_REQUEST_TTL_MS,
  buildSendRequest,
  checkSendRequest,
  hashApprovalToken,
  isWellFormedToken,
  newApprovalToken,
} from "./sendApprovalRequests";

const base = {
  tokenHash: "h",
  emailId: "0e06c37c-a76f-4201-92cf-fa2a29e48f77",
  subject: "LifeX webinar Oct 21",
  requestedBy: "a@sarva.co",
  unsentAtRequest: 184_239,
  contentSha256: "abc",
};

describe("send approval requests", () => {
  it("issues unguessable, well-formed tokens and stores only their hash", () => {
    const a = newApprovalToken();
    const b = newApprovalToken();
    expect(a).not.toBe(b);
    expect(isWellFormedToken(a)).toBe(true);
    expect(hashApprovalToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApprovalToken(a)).not.toContain(a);
    expect(isWellFormedToken("../../etc")).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
  });

  it("builds a pending request that expires in 24 hours", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const request = buildSendRequest({ ...base, sendWindow: " 07:00-21:00 America/New_York ", note: "  batch 3  ", nowMs: now });
    expect(request.status).toBe("pending");
    expect(Date.parse(request.expiresAt) - now).toBe(SEND_REQUEST_TTL_MS);
    expect(request.sendWindow).toBe("07:00-21:00 America/New_York");
    expect(request.note).toBe("batch 3");
    expect(request.sendAt).toBeNull();
  });

  it("allows a fresh pending request with unchanged content", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const request = buildSendRequest({ ...base, nowMs: now });
    expect(checkSendRequest(request, "abc", now + 60_000)).toEqual({ ok: true });
  });

  it("refuses missing, expired, already-decided, and content-changed requests", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const request = buildSendRequest({ ...base, nowMs: now });
    expect(checkSendRequest(null, "abc", now)).toMatchObject({ ok: false, reason: "missing" });
    expect(checkSendRequest(request, "abc", now + SEND_REQUEST_TTL_MS)).toMatchObject({ ok: false, reason: "expired" });
    expect(checkSendRequest({ ...request, status: "approved" }, "abc", now)).toMatchObject({ ok: false, reason: "decided" });
    expect(checkSendRequest({ ...request, status: "approving" }, "abc", now)).toMatchObject({ ok: false, reason: "decided" });
    expect(checkSendRequest(request, "edited", now)).toMatchObject({ ok: false, reason: "content_changed" });
  });
});
