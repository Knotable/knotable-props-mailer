import { describe, expect, it } from "vitest";
import {
  findRecentDuplicateRecipients,
  findRecentTwinEmailIds,
  makeContentFingerprint,
  makeDedupeHash,
  recentDuplicateCutoffIso,
  // @ts-expect-error -- shared JS helper, no type declarations
} from "../../scripts/lib/queue-rows.mjs";

const SINCE = "2026-10-16T00:00:00.000Z";

describe("makeContentFingerprint", () => {
  it("ignores whitespace and case, but not wording", () => {
    expect(makeContentFingerprint("Hi  there", "<p>A   B</p>")).toBe(makeContentFingerprint("hi there", "<p>a b</p>"));
    expect(makeContentFingerprint("Hi", "<p>A</p>")).not.toBe(makeContentFingerprint("Hi", "<p>B</p>"));
  });
});

describe("recentDuplicateCutoffIso", () => {
  it("is 12 hours back", () => {
    const now = Date.parse("2026-10-16T12:00:00.000Z");
    expect(recentDuplicateCutoffIso(now)).toBe("2026-10-16T00:00:00.000Z");
  });
});

// Minimal PostgREST-shaped stub: records the filters a query applied.
function stubClient(handlers: Record<string, (filters: Record<string, unknown[][]>) => unknown>) {
  return {
    from(table: string) {
      const filters: Record<string, unknown[][]> = {};
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "gte", "in", "order", "limit"]) {
        builder[method] = (...args: unknown[]) => {
          (filters[method] ??= []).push(args);
          return builder;
        };
      }
      builder.then = (resolve: (value: unknown) => unknown) => resolve(handlers[table](filters));
      return builder;
    },
  };
}

describe("findRecentTwinEmailIds", () => {
  const twin = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";

  it("keeps only same-content drafts that delivered inside the window", async () => {
    const client = stubClient({
      emails: () => ({
        data: [
          { id: twin, subject: "Batch", html: "<p>Body</p>" },
          { id: other, subject: "Batch", html: "<p>Different</p>" },
        ],
        error: null,
      }),
      mail_queue: (filters) => {
        const emailId = filters.eq.find((args) => args[0] === "email_id")?.[1];
        return { count: emailId === twin ? 3 : 0, error: null };
      },
    });

    expect(
      await findRecentTwinEmailIds(client, { emailId: "self", subject: "Batch", html: "<p>Body</p>", sinceIso: SINCE }),
    ).toEqual([twin]);
  });

  it("surfaces lookup failures instead of sending anyway", async () => {
    const client = stubClient({ emails: () => ({ data: null, error: { message: "timeout" } }) });
    await expect(
      findRecentTwinEmailIds(client, { emailId: "self", subject: "Batch", html: "<p>Body</p>", sinceIso: SINCE }),
    ).rejects.toThrow(/recent duplicate sends/);
  });
});

describe("findRecentDuplicateRecipients", () => {
  const twin = "11111111-1111-4111-8111-111111111111";

  it("returns the recipients a twin draft already delivered to", async () => {
    const client = stubClient({
      mail_queue: () => ({ data: [{ dedupe_hash: makeDedupeHash(twin, "a@b.co") }], error: null }),
    });

    expect(
      await findRecentDuplicateRecipients(client, {
        twinEmailIds: [twin],
        recipients: ["a@b.co", "c@d.co"],
        sinceIso: SINCE,
      }),
    ).toEqual(new Set(["a@b.co"]));
  });

  it("does nothing without twins", async () => {
    const client = stubClient({});
    expect(
      await findRecentDuplicateRecipients(client, { twinEmailIds: [], recipients: ["a@b.co"], sinceIso: SINCE }),
    ).toEqual(new Set());
  });
});
