import { describe, expect, it } from "vitest";
import { BUILT_IN_TEMPLATES, normalizeTemplateInput, plainTextToHtml, templateHtml } from "./emailTemplateCore";

describe("email templates", () => {
  it("renders plain text the way a phone client would", () => {
    const html = plainTextToHtml("Hey {{firstName | there}} —\n\nSee https://luma.com/3j7941bf.\n\n<b>Amol</b>");
    expect(html).toBe('<div dir="ltr">Hey {{firstName | there}} —<br><br>See <a href="https://luma.com/3j7941bf">https://luma.com/3j7941bf</a>.<br><br>&lt;b&gt;Amol&lt;/b&gt;</div>');
    expect(html).not.toMatch(/style=|<img|<table/);
  });

  it("ships a phone-style built-in with no styling and a merge-tag greeting", () => {
    const phone = BUILT_IN_TEMPLATES.find((template) => template.id === "builtin-phone-note")!;
    expect(phone.format).toBe("plain");
    expect(phone.subject).toBe(phone.subject.toLowerCase());
    expect(templateHtml(phone)).toContain("Sent from my iPhone");
    expect(templateHtml(phone)).toContain("{{firstName | there}}");
  });

  it("validates input", () => {
    expect(normalizeTemplateInput({ name: " ", body: "x" })).toEqual({ error: "Give the template a name." });
    expect(normalizeTemplateInput({ name: "A", body: "  " })).toEqual({ error: "The template body is empty." });
    const ok = normalizeTemplateInput({ name: " Update ", body: "<p>x</p>", format: "weird", description: "" });
    expect(ok).toEqual({ value: { name: "Update", description: null, subject: "", format: "html", body: "<p>x</p>", fromAddress: null, replyTo: null } });
  });
});
