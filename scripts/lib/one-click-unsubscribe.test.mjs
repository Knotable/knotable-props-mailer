import { describe, expect, it } from "vitest";
import { generateUnsubscribeKey, listUnsubscribeHeaders, unsubscribeUrl, verifyUnsubscribe } from "./one-click-unsubscribe.mjs";

const secret = generateUnsubscribeKey();
const emailId = "11111111-2222-3333-4444-555555555555";
const listId = "aaaaaaaa-2222-3333-4444-555555555555";

function parts(url) {
  const parsed = new URL(url);
  return { emailId: parsed.searchParams.get("c"), listId: parsed.searchParams.get("l"), encodedRecipient: parsed.searchParams.get("r"), signature: parsed.searchParams.get("s") };
}

describe("one-click unsubscribe links", () => {
  it("refuses to sign a link without a list", () => {
    expect(() => unsubscribeUrl({ baseUrl: "https://mailer.test", secret, emailId, listId: null, recipient: "a@b.co" })).toThrow();
  });

  it("round-trips a signed link to the normalized recipient", () => {
    const url = unsubscribeUrl({ baseUrl: "https://mailer.test/", secret, emailId, listId, recipient: " Jane@Example.com " });
    expect(url.startsWith("https://mailer.test/api/unsubscribe?")).toBe(true);
    expect(verifyUnsubscribe({ secret, ...parts(url) })).toBe("jane@example.com");
  });

  it("rejects tampered recipients, lists, campaigns, signatures and keys", () => {
    const good = parts(unsubscribeUrl({ baseUrl: "https://mailer.test", secret, emailId, listId, recipient: "jane@example.com" }));
    const other = Buffer.from("boss@example.com").toString("base64url");
    expect(verifyUnsubscribe({ secret, ...good, encodedRecipient: other })).toBeNull();
    expect(verifyUnsubscribe({ secret, ...good, emailId: "99999999-2222-3333-4444-555555555555" })).toBeNull();
    expect(verifyUnsubscribe({ secret, ...good, listId: "bbbbbbbb-2222-3333-4444-555555555555" })).toBeNull();
    expect(verifyUnsubscribe({ secret, ...good, listId: null })).toBeNull();
    expect(verifyUnsubscribe({ secret, ...good, signature: "0".repeat(64) })).toBeNull();
    expect(verifyUnsubscribe({ secret, ...good, signature: "abc" })).toBeNull();
    expect(verifyUnsubscribe({ secret: generateUnsubscribeKey(), ...good })).toBeNull();
    expect(verifyUnsubscribe({ secret: "", ...good })).toBeNull();
  });

  it("builds RFC 8058 headers with a mailto fallback", () => {
    expect(listUnsubscribeHeaders({ url: "https://m.test/u?x=1", replyTo: "r@m.test" })).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://m.test/u?x=1>, <mailto:r@m.test?subject=Unsubscribe>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
    expect(listUnsubscribeHeaders({ url: null, replyTo: "r@m.test" })).toEqual([
      { Name: "List-Unsubscribe", Value: "<mailto:r@m.test?subject=Unsubscribe>" },
    ]);
    expect(listUnsubscribeHeaders({ url: null, replyTo: null })).toEqual([]);
  });
});
