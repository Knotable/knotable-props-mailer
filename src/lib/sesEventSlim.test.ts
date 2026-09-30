import { describe, expect, it } from "vitest";
import { slimSesEvent } from "./sesEventSlim";

const headers = Array.from({ length: 20 }, (_, i) => ({ name: `X-Header-${i}`, value: "v".repeat(200) }));

function sesEvent(eventType: string, detail: Record<string, unknown>) {
  return {
    eventType,
    mail: {
      timestamp: "2026-09-30T12:00:00.000Z",
      source: "Amol <a@sarva.co>",
      sourceArn: "arn:aws:ses:us-east-1:123:identity/sarva.co",
      sendingAccountId: "123",
      messageId: "0100-abc",
      destination: ["person@example.com"],
      headersTruncated: false,
      headers,
      commonHeaders: { from: ["a@sarva.co"], to: ["person@example.com"], subject: "Hello" },
      tags: {
        "ses:configuration-set": ["knotable-tracking"],
        "ses:source-ip": ["1.2.3.4"],
        queue_id: ["11111111-1111-4111-8111-111111111111"],
      },
    },
    ...detail,
  };
}

describe("slimSesEvent", () => {
  it("keeps what the breaker and analytics read, drops the header dump", () => {
    const bounce = slimSesEvent(sesEvent("Bounce", {
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "person@example.com", diagnosticCode: "x".repeat(2000) }],
      },
    }));
    expect(bounce.eventType).toBe("Bounce");
    expect(bounce.mail).toEqual({
      messageId: "0100-abc",
      timestamp: "2026-09-30T12:00:00.000Z",
      destination: ["person@example.com"],
      tags: { queue_id: ["11111111-1111-4111-8111-111111111111"] },
    });
    const detail = bounce.bounce as { bounceType: string; bouncedRecipients: Array<{ diagnosticCode: string }> };
    expect(detail.bounceType).toBe("Permanent");
    expect(detail.bouncedRecipients[0].diagnosticCode.length).toBeLessThanOrEqual(501);

    const click = slimSesEvent(sesEvent("Click", { click: { link: "https://lifex.vc/agm", timestamp: "t" } }));
    expect((click.click as { link: string }).link).toBe("https://lifex.vc/agm");
  });

  it("is a small fraction of the original size", () => {
    const original = sesEvent("Delivery", { delivery: { timestamp: "t", recipients: ["person@example.com"], smtpResponse: "250 ok" } });
    const slim = slimSesEvent(original);
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(original).length / 5);
  });
});
