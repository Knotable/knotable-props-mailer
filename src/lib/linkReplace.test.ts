import { describe, expect, it } from "vitest";
import { replaceLink } from "./linkReplace";

describe("replaceLink", () => {
  it("replaces plain and HTML-escaped occurrences", () => {
    const html = '<a href="https://chat.whatsapp.com/OLD">join</a> https://chat.whatsapp.com/OLD';
    expect(replaceLink(html, "https://chat.whatsapp.com/OLD", "https://chat.whatsapp.com/NEW?a=1&b=2")).toEqual({
      value: '<a href="https://chat.whatsapp.com/NEW?a=1&b=2">join</a> https://chat.whatsapp.com/NEW?a=1&b=2',
      count: 2,
    });
    expect(replaceLink("x https://a.co/p?a=1&amp;b=2", "https://a.co/p?a=1&b=2", "https://n.co/q?c=3&d=4")).toEqual({
      value: "x https://n.co/q?c=3&amp;d=4",
      count: 1,
    });
    expect(replaceLink("nothing here", "https://a.co", "https://b.co")).toEqual({ value: "nothing here", count: 0 });
  });
});
