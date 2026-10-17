import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { esc, form, page, table } from "./html";
import { ACTION_HANDLERS, ACTION_SPECS, PUBLIC_ACTIONS } from "./actions";

describe("agent interface", () => {
  it("catalogs exactly the actions it can run", () => {
    expect(ACTION_SPECS.map((spec) => spec.action).sort()).toEqual(Object.keys(ACTION_HANDLERS).sort());
    for (const name of PUBLIC_ACTIONS) expect(ACTION_HANDLERS[name]).toBeTypeOf("function");
  });

  it("escapes every dynamic value", () => {
    const hostile = `"><script>alert(1)</script>`;
    expect(esc(hostile)).not.toContain("<script>");
    const html = page({ title: hostile, who: hostile, result: { ok: false, message: hostile }, body: table("t", ["h"], [[hostile]]), jsonHref: "/ai?format=json" });
    expect(html).not.toContain("<script>");
    const rendered = form({ action: "save_draft", label: "Save", description: hostile, fields: [{ name: "subject", label: "Subject", value: hostile }] }, "/ai");
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain('id="form-save_draft"');
    expect(rendered).toContain('id="submit-save_draft"');
    expect(rendered).toContain('for="save_draft-subject"');
  });

  it("only redirects back inside /ai and rejects cross-origin posts", () => {
    const route = readFileSync("src/app/ai/do/[action]/route.ts", "utf8");
    expect(route).toContain('target.startsWith("/ai") && !target.startsWith("//")');
    expect(route).toContain("Cross-origin request rejected");
  });

  it("requires the exact unsent count and the release token for send", () => {
    const actions = readFileSync("src/lib/ai/actions.ts", "utf8");
    expect(actions).toContain("expectedRecipients: String(input.get(\"confirm_recipients\")");
    expect(actions).toContain("buildQueueReleaseConfirmation(emailId)");
  });
});

describe("request_send approval links", () => {
  it("never sends: the approve step requires the operator's password and is not an /ai action", () => {
    const actions = readFileSync("src/app/(dashboard)/approve/[token]/actions.ts", "utf8");
    const create = actions.slice(actions.indexOf("export async function createSendRequestAction"), actions.indexOf("async function passwordMatches"));
    expect(create).not.toContain("sendQueuedEmailAction");
    const approve = actions.slice(actions.indexOf("export async function approveSendRequestAction"));
    expect(approve.indexOf("passwordMatches(")).toBeLessThan(approve.indexOf("sendQueuedEmailAction("));
    expect(approve).toContain('transitionSendRequest(request, "pending"');
    expect(Object.keys(ACTION_HANDLERS)).toContain("request_send");
    expect(Object.keys(ACTION_HANDLERS).some((name) => /approve/.test(name))).toBe(false);
  });
});
