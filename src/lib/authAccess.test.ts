import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createBypassCookieValue,
  isBypassConfigured,
  isValidBypassCookieValue,
  verifyBypassPassword,
} from "./authAccess";

const originalPasswordHash = process.env.BYPASS_PASSWORD_SHA256;
const originalHmacKey = process.env.BYPASS_COOKIE_HMAC_KEY;

afterEach(() => {
  if (originalPasswordHash === undefined) delete process.env.BYPASS_PASSWORD_SHA256;
  else process.env.BYPASS_PASSWORD_SHA256 = originalPasswordHash;
  if (originalHmacKey === undefined) delete process.env.BYPASS_COOKIE_HMAC_KEY;
  else process.env.BYPASS_COOKIE_HMAC_KEY = originalHmacKey;
});

describe("bypass authentication configuration", () => {
  it("fails closed when either server-side secret is missing", () => {
    delete process.env.BYPASS_PASSWORD_SHA256;
    delete process.env.BYPASS_COOKIE_HMAC_KEY;
    expect(isBypassConfigured()).toBe(false);
    expect(verifyBypassPassword("anything")).toBe(false);
    expect(isValidBypassCookieValue("9999999999999.fake")).toBe(false);
    expect(() => createBypassCookieValue()).toThrow(/disabled/);
  });

  it("accepts only the configured password and a valid unexpired cookie", () => {
    process.env.BYPASS_PASSWORD_SHA256 = createHash("sha256").update("correct horse battery staple").digest("hex");
    process.env.BYPASS_COOKIE_HMAC_KEY = "ab".repeat(32);
    expect(isBypassConfigured()).toBe(true);
    expect(verifyBypassPassword("wrong")).toBe(false);
    expect(verifyBypassPassword("correct horse battery staple")).toBe(true);
    const cookie = createBypassCookieValue(Date.now() + 60_000);
    expect(isValidBypassCookieValue(cookie)).toBe(true);
    expect(isValidBypassCookieValue(createBypassCookieValue(Date.now() - 1))).toBe(false);
  });

  it("refuses to reuse the password hash as the cookie-signing key", () => {
    const passwordHash = createHash("sha256").update("a different password").digest("hex");
    process.env.BYPASS_PASSWORD_SHA256 = passwordHash;
    process.env.BYPASS_COOKIE_HMAC_KEY = passwordHash;
    expect(isBypassConfigured()).toBe(false);
    expect(verifyBypassPassword("a different password")).toBe(false);
  });
});
