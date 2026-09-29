import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createBypassCookieValue,
  isBypassConfigured,
  isValidBypassCookieValue,
  verifyBypassPassword,
} from "./authAccess";
import { isValidBypassCookieValue as isValidOnEdge } from "./authAccessEdge";
import { clearBypassSecretsCache } from "./bypassSecrets";

const saved = { ...process.env };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  clearBypassSecretsCache();
  delete process.env.BYPASS_PASSWORD_SHA256;
  delete process.env.BYPASS_COOKIE_HMAC_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  clearBypassSecretsCache();
});

describe("bypass authentication configuration", () => {
  it("fails closed when no secrets are configured anywhere", async () => {
    expect(await isBypassConfigured()).toBe(false);
    expect(await verifyBypassPassword("anything")).toBe(false);
    expect(await isValidBypassCookieValue(`9999999999999.${"a".repeat(64)}`)).toBe(false);
    await expect(createBypassCookieValue()).rejects.toThrow(/disabled/);
  });

  it("accepts only the configured password and a valid unexpired cookie (env)", async () => {
    process.env.BYPASS_PASSWORD_SHA256 = sha("correct horse battery staple");
    process.env.BYPASS_COOKIE_HMAC_KEY = "ab".repeat(32);
    expect(await isBypassConfigured()).toBe(true);
    expect(await verifyBypassPassword("wrong")).toBe(false);
    expect(await verifyBypassPassword("correct horse battery staple")).toBe(true);
    const cookie = await createBypassCookieValue(Date.now() + 60_000);
    expect(await isValidBypassCookieValue(cookie)).toBe(true);
    expect(await isValidOnEdge(cookie)).toBe(true);
    expect(await isValidBypassCookieValue(await createBypassCookieValue(Date.now() - 1))).toBe(false);
    expect(await isValidBypassCookieValue(cookie.replace(/.$/, (c) => (c === "0" ? "1" : "0")))).toBe(false);
  });

  it("refuses to reuse the password hash as the cookie-signing key", async () => {
    const passwordHash = sha("a different password");
    process.env.BYPASS_PASSWORD_SHA256 = passwordHash;
    process.env.BYPASS_COOKIE_HMAC_KEY = passwordHash;
    expect(await isBypassConfigured()).toBe(false);
    expect(await verifyBypassPassword("a different password")).toBe(false);
  });

  it("falls back to the service-role-only app_settings row when env vars are absent", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { value: { passwordSha256: sha("from database"), cookieHmacKey: "cd".repeat(32) } },
    ])));
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifyBypassPassword("from database")).toBe(true);
    expect(await verifyBypassPassword("nope")).toBe(false);
    const cookie = await createBypassCookieValue(Date.now() + 60_000);
    expect(await isValidOnEdge(cookie)).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("app_settings?key=eq.bypass_auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
