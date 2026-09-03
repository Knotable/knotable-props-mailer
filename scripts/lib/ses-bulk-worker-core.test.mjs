import { describe, expect, it } from "vitest";
import {
  assertSendReadySubject,
  classifySesResult,
  compileTemplate,
  recipientData,
} from "./ses-bulk-worker-core.mjs";

describe("SES bulk worker core", () => {
  it("blocks draft-like subjects", () => {
    expect(() => assertSendReadySubject("LifeX Draft v2")).toThrow(/not send-ready/);
  });

  it("compiles fallback merge tags and a recipient-specific tracking pixel", () => {
    const template = compileTemplate({
      subject: "Hello {{firstName | friend}}",
      html: "<body><p>{{name | there}}</p></body>",
      text: "Hello {{email}}",
      appBaseUrl: "https://mailer.example/",
    });
    const data = template.replacementData(recipientData({ to: "A@Example.com", toName: "Ada Lovelace" }, "queue-123"));
    expect(template.content.Subject).toBe("Hello {{s0}}");
    expect(template.content.Html).toContain("/api/email/open/{{h1}}");
    expect(data).toMatchObject({ s0: "Ada", h0: "Ada Lovelace", h1: "queue-123", t0: "a@example.com" });
  });

  it("omits the Vercel tracking pixel for the AWS-native execution plane", () => {
    const template = compileTemplate({
      subject: "Hello {{firstName | friend}}",
      html: "<p>Hello</p>",
      text: "Hello",
    });
    expect(template.content.Html).toBe("<p>Hello</p>");
    expect(template.content.Html).not.toContain("/api/email/open/");
  });

  it("maps accepted and exhausted SES results to durable outcomes", () => {
    expect(classifySesResult({ Status: "SUCCESS", MessageId: "ses-1" }, { id: "q1", attempts: 0, max_attempts: 5 })).toMatchObject({ outcome: "succeeded" });
    expect(classifySesResult({ Status: "ACCOUNT_THROTTLED", Error: "slow" }, { id: "q2", attempts: 4, max_attempts: 5 })).toMatchObject({ outcome: "dead" });
  });
});
