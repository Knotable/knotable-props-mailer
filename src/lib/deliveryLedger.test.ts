import { describe, expect, it, vi } from "vitest";
import { findAcceptedRecipients, firstTagUuid, isMissingFunction, markDeliveryAccepted, recordDeliveryEvent, type LedgerClient } from "./deliveryLedger";

const EMAIL = "11111111-1111-4111-8111-111111111111";

function client(result: { data?: unknown; error?: { code?: string; message?: string } | null } | Error): LedgerClient & { rpc: ReturnType<typeof vi.fn> } {
  return {
    rpc: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return { data: result.data ?? null, error: result.error ?? null };
    }),
  };
}

describe("recordDeliveryEvent", () => {
  it("reports flagged only when the database folded the event into the ledger", async () => {
    const c = client({ data: "flagged" });
    expect(await recordDeliveryEvent(c, { emailId: EMAIL, recipient: "a@b.co", eventType: "delivered" })).toBe("flagged");
    expect(c.rpc).toHaveBeenCalledWith("record_delivery_event", { p_email_id: EMAIL, p_recipient: "a@b.co", p_event_type: "delivered" });
    expect(await recordDeliveryEvent(client({ data: "row" }), { emailId: EMAIL, recipient: "a@b.co", eventType: "clicked" })).toBe("row");
  });

  it("falls back to storing a row when the migration is missing, the call fails, or ids are absent", async () => {
    expect(await recordDeliveryEvent(client({ error: { code: "PGRST202", message: "Could not find the function" } }), { emailId: EMAIL, recipient: "a@b.co", eventType: "opened" })).toBe("row");
    expect(await recordDeliveryEvent(client(new Error("network")), { emailId: EMAIL, recipient: "a@b.co", eventType: "opened" })).toBe("row");
    const untouched = client({ data: "flagged" });
    expect(await recordDeliveryEvent(untouched, { emailId: null, recipient: "a@b.co", eventType: "opened" })).toBe("row");
    expect(await recordDeliveryEvent(untouched, { emailId: EMAIL, recipient: null, eventType: "opened" })).toBe("row");
    expect(untouched.rpc).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("never throws when marking a recovered send", async () => {
    await expect(markDeliveryAccepted(client(new Error("boom")), EMAIL, "a@b.co")).resolves.toBeUndefined();
    const skipped = client({});
    await markDeliveryAccepted(skipped, EMAIL, null);
    expect(skipped.rpc).not.toHaveBeenCalled();
  });

  it("recognises a missing database function", () => {
    expect(isMissingFunction({ code: "42883" })).toBe(true);
    expect(isMissingFunction({ code: "PGRST202" })).toBe(true);
    expect(isMissingFunction({ message: "function public.x does not exist" })).toBe(true);
    expect(isMissingFunction({ code: "57014", message: "statement timeout" })).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });

  it("reads uuid tags in SES's array form and rejects junk", () => {
    expect(firstTagUuid({ campaign_id: [EMAIL] }, "campaign_id")).toBe(EMAIL);
    expect(firstTagUuid({ campaign_id: EMAIL }, "campaign_id")).toBe(EMAIL);
    expect(firstTagUuid({ campaign_id: ["not-a-uuid"] }, "campaign_id")).toBeNull();
    expect(firstTagUuid(undefined, "campaign_id")).toBeNull();
    expect(firstTagUuid({}, "campaign_id")).toBeNull();
  });
});

describe("findAcceptedRecipients", () => {
  it("returns the addresses the database says were already accepted", async () => {
    const c = client({ data: ["a@b.co", { delivery_accepted_among: "c@d.co" }, 7] });
    expect(await findAcceptedRecipients(c, EMAIL, ["a@b.co", "c@d.co", "e@f.co"])).toEqual(new Set(["a@b.co", "c@d.co"]));
    expect(c.rpc).toHaveBeenCalledWith("delivery_accepted_among", { p_email_id: EMAIL, p_recipients: ["a@b.co", "c@d.co", "e@f.co"] });
  });

  it("does nothing for an empty page and is empty before the migration is applied", async () => {
    const untouched = client({ data: ["x"] });
    expect(await findAcceptedRecipients(untouched, EMAIL, [])).toEqual(new Set());
    expect(untouched.rpc).not.toHaveBeenCalled();
    expect(await findAcceptedRecipients(client({ error: { code: "PGRST202", message: "Could not find the function" } }), EMAIL, ["a@b.co"])).toEqual(new Set());
  });

  it("fails loudly on any other error rather than risk a duplicate send", async () => {
    await expect(findAcceptedRecipients(client({ error: { code: "57014", message: "statement timeout" } }), EMAIL, ["a@b.co"])).rejects.toThrow(/already sent/);
  });
});
