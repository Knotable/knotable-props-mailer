import { describe, expect, it } from "vitest";
import { blockedMemberMetadata, isBlockedRecipientEmail } from "./blockList";

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

describe("automated sender rules", () => {
  it("blocks the scraped inbox senders that hard-bounced in May", () => {
    for (const address of [
      "donotreply@icicibank.com",
      "invoice+statements@mail.anthropic.com",
      "events@mail.stubhub.com",
      "email@marketing.manacommon.com",
      "no-reply@accounts.google.com",
      "Do_Not_Reply@bank.com",
      "noreply42@service.io",
      "notifications@github.com",
      "MAILER-DAEMON@example.com",
      "jane@em.shop.com",
    ]) {
      expect(isBlockedRecipientEmail(address), address).toBe(true);
    }
  });

  it("keeps people, consumer mail domains and university addresses", () => {
    for (const address of [
      "a@sarva.co",
      "jane.doe@gmail.com",
      "someone@mail.com",
      "someone@email.com",
      "jo@mail.harvard.edu",
      "sam@email.ox.ac.uk",
      "eventsmanager@company.com",
      "noah@company.com",
      "info@startup.io",
    ]) {
      expect(isBlockedRecipientEmail(address), address).toBe(false);
    }
  });

  it("records why a member was blocked", () => {
    expect(blockedMemberMetadata({ name: "X" }, "noreply@x.com")).toMatchObject({ name: "X", blocked_by: "automated_sender" });
    expect(blockedMemberMetadata(null, "a@fut.io")).toMatchObject({ blocked_by: "domain_block_list" });
  });
});
