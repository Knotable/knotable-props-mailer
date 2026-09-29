import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "./lib/test-support/fake-backend.mjs";

const SCRIPT = fileURLToPath(new URL("./sync-bypass-password.mjs", import.meta.url));
let backend;
let baseUrl;
// Async spawn: the fake server lives in this process and must keep serving.
const run = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, SUPABASE_URL: baseUrl, SUPABASE_SERVICE_ROLE_KEY: "service", GITHUB_ACTIONS: "true", ...env },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.on("exit", (status) => resolve({ status, stdout }));
});
const row = () => backend.tables.app_settings.find((candidate) => candidate.key === "bypass_auth")?.value;

beforeEach(async () => {
  backend = createFakeBackend();
  baseUrl = await backend.start();
});
afterEach(async () => backend.stop());

describe("bypass password sync from the GitHub secret", () => {
  it("stores the hash, is a no-op when unchanged, and rotates the cookie key on change", async () => {
    const first = await run({ BYPASS_PASSWORD: "pw1" });
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain("pw1");
    expect(row().passwordSha256).toBe(crypto.createHash("sha256").update("pw1").digest("hex"));
    const key = row().cookieHmacKey;
    expect((await run({ BYPASS_PASSWORD: "pw1" })).stdout).toContain("already in sync");
    expect(row().cookieHmacKey).toBe(key);
    await run({ BYPASS_PASSWORD: "pw2" });
    expect(row().passwordSha256).toBe(crypto.createHash("sha256").update("pw2").digest("hex"));
    expect(row().cookieHmacKey).not.toBe(key);
  });

  it("leaves everything alone when the secret is unset or Supabase is unreachable", async () => {
    expect((await run({ BYPASS_PASSWORD: "" })).status).toBe(0);
    expect(row()).toBeUndefined();
    const offline = await run({ BYPASS_PASSWORD: "pw", SUPABASE_URL: "http://127.0.0.1:9" });
    expect(offline.status).toBe(0);
    expect(offline.stdout).toContain("::warning::");
  });
});
