import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createFakeBackend } from "../../scripts/lib/test-support/fake-backend.mjs";
import { buildQueueReleaseConfirmation } from "./queueReleaseGuard";
import { sendQueuedEmailAction } from "@/app/(dashboard)/email/actions";

const mocks = vi.hoisted(() => ({ db: undefined, canSend: vi.fn() }));
vi.mock("@/lib/supabaseAdmin", () => ({ getSupabaseAdmin: () => mocks.db }));
vi.mock("@/lib/authAccess", () => ({ requireCanSendAuthContext: mocks.canSend, getServerAuthContext: mocks.canSend }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/emailProvider", () => ({ sendEmail: vi.fn() }));

const parent = "10000000-0000-4000-8000-000000000001";
const child = "10000000-0000-4000-8000-000000000002";
const approval = "20000000-0000-4000-8000-000000000001";
let backend;
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({ id: child, releaseConfirmation: buildQueueReleaseConfirmation(child), expectedRecipients: "3", afterCampaignId: parent, afterApprovalId: approval, afterDelayMinutes: "720" })) data.set(key, value);
  return data;
}

beforeEach(async () => {
  vi.stubEnv("GITHUB_ACTIONS_DISPATCH_TOKEN", "");
  mocks.canSend.mockResolvedValue({ userId: "operator", email: "operator@example.test" });
  backend = createFakeBackend();
  const url = await backend.start();
  mocks.db = createClient(url, "service", { auth: { persistSession: false } });
  backend.tables.emails.push(
    { id: parent, status: "sending", subject: "Earlier audience" },
    { id: child, status: "queued", subject: "October update", html: "<p>Hello</p>", from_address: "sender@example.test" },
  );
  backend.tables.app_settings.push({ key: `send_autopilot:${parent}`, value: { emailId: parent, approvalId: approval, state: "approved", subject: "Earlier audience" } });
  for (let index = 0; index < 3; index++) backend.tables.mail_queue.push({ id: String(index), email_id: child, status: "pending", available_at: "2999-12-31T00:00:00Z" });
});
afterEach(async () => { await backend.stop(); vi.unstubAllEnvs(); });

it("persists an exact-count delayed approval without releasing recipient rows", async () => {
  const result = await sendQueuedEmailAction(form());
  expect(result.error).toBeUndefined();
  const value = backend.tables.app_settings.find((row) => row.key === `send_autopilot:${child}`)?.value;
  expect(value).toMatchObject({ state: "waiting_campaign", approvedRecipients: 3, afterCampaign: { emailId: parent, approvalId: approval, delayMinutes: 720 } });
  expect(backend.tables.mail_queue.every((row) => row.status === "pending")).toBe(true);
});

describe("sequence approval validation", () => {
  it.each(["count", "replaced", "self", "delay", "cycle", "permission"])("refuses %s errors without recording approval", async (failure) => {
    const data = form();
    if (failure === "count") data.set("expectedRecipients", "4");
    if (failure === "replaced") data.set("afterApprovalId", "20000000-0000-4000-8000-000000000099");
    if (failure === "self") data.set("afterCampaignId", child);
    if (failure === "delay") data.set("afterDelayMinutes", "-1");
    if (failure === "cycle") backend.tables.app_settings[0].value.afterCampaign = { emailId: child, approvalId: approval, delayMinutes: 0 };
    if (failure === "permission") mocks.canSend.mockRejectedValue(new Error("Send permission required"));
    expect((await sendQueuedEmailAction(data)).error).toBeTruthy();
    expect(backend.tables.app_settings.some((row) => row.key === `send_autopilot:${child}`)).toBe(false);
  });
});
