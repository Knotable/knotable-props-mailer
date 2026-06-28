import { describe, expect, it } from "vitest";
import {
  buildRecipientPersonalization,
  personalizeEmailContent,
  personalizeHtml,
  personalizeText,
} from "./personalization";

describe("recipient personalization", () => {
  it("renders recipient name, first name, and email merge tags", () => {
    const recipient = buildRecipientPersonalization({
      email: "JON@EXAMPLE.COM",
      displayName: "Jon Smith",
    });

    expect(personalizeText("Hello {{firstName}} / {{name}} / {{email}}", recipient)).toBe(
      "Hello Jon / Jon Smith / jon@example.com",
    );
  });

  it("supports common merge tag aliases", () => {
    const recipient = buildRecipientPersonalization({
      email: "nancy@example.com",
      displayName: "Nancy Doe",
    });

    expect(
      personalizeText("Hi {{first_name}}, {{recipient.name}} <{{recipient.email}}>", recipient),
    ).toBe("Hi Nancy, Nancy Doe <nancy@example.com>");
  });

  it("escapes recipient values in HTML content", () => {
    const recipient = buildRecipientPersonalization({
      email: "jon@example.com",
      displayName: "Jon <Boss>",
    });

    expect(personalizeHtml("<p>Hello {{name}}</p>", recipient)).toBe(
      "<p>Hello Jon &lt;Boss&gt;</p>",
    );
  });

  it("uses greeting fallbacks when a recipient has no stored name", () => {
    const recipient = buildRecipientPersonalization({ email: "no-name@example.com" });

    expect(personalizeText("Hello {{firstName}}", recipient)).toBe("Hello there");
    expect(personalizeText("Hello {{firstName|friend}}", recipient)).toBe("Hello friend");
  });

  it("leaves unknown tags untouched", () => {
    const recipient = buildRecipientPersonalization({
      email: "jon@example.com",
      displayName: "Jon",
    });

    expect(personalizeText("Visit {{unsubscribeUrl}}", recipient)).toBe("Visit {{unsubscribeUrl}}");
  });

  it("personalizes subject, html, and text together", () => {
    const recipient = buildRecipientPersonalization({
      email: "nancy@example.com",
      displayName: "Nancy Doe",
    });

    expect(
      personalizeEmailContent(
        {
          subject: "For {{firstName}}",
          html: "<p>Hello {{name}}</p>",
          text: "Hello {{name}}",
        },
        recipient,
      ),
    ).toEqual({
      subject: "For Nancy",
      html: "<p>Hello Nancy Doe</p>",
      text: "Hello Nancy Doe",
    });
  });
});
