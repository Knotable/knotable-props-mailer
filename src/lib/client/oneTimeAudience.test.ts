import { describe, expect, it } from "vitest";
import {
  parseOneTimeAudienceCsv,
  personalizeAudiencePreview,
  unresolvedMergeTags,
} from "./oneTimeAudience";

describe("one-time audience CSV parsing", () => {
  it("parses recipients, dedupes emails, and preserves merge fields", () => {
    const parsed = parseOneTimeAudienceCsv(
      [
        "email,name,first_name,opener,company",
        'ALICE@example.com,Alice Smith,Alice,"Loved your London note.",Knotable',
        "bad-email,Bad User,Bad,Nope,Invalid Co",
        "alice@example.com,Alice Again,Alice,Duplicate,Knotable",
        "bob@example.com,Bob Jones,Bob,,Example",
      ].join("\n"),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.submitted).toBe(4);
    expect(parsed.skippedInvalid).toBe(1);
    expect(parsed.skippedDuplicate).toBe(1);
    expect(parsed.members).toHaveLength(2);
    expect(parsed.members[0].email).toBe("alice@example.com");
    expect(parsed.members[0].mergeData.opener).toBe("Loved your London note.");
  });

  it("previews arbitrary merge tags and reports unresolved tags", () => {
    const [member] = parseOneTimeAudienceCsv(
      'email,first_name,opener\nalice@example.com,Alice,"Great seeing you."',
    ).members;

    const preview = personalizeAudiencePreview(
      "Hi {{first_name}}, {{opener}} {{unknownTag}}",
      member,
      "text",
    );

    expect(preview).toBe("Hi Alice, Great seeing you. {{unknownTag}}");
    expect(unresolvedMergeTags(preview)).toEqual(["unknownTag"]);
  });
});
