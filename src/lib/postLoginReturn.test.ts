import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./postLoginReturn";
import { newApprovalToken } from "./sendApprovalRequests";

describe("post-login return path", () => {
  it("only returns to one-time approval links", () => {
    const path = `/approve/${newApprovalToken()}`;
    expect(safeReturnPath(path)).toBe(path);
    expect(safeReturnPath("/email/composer")).toBeNull();
    expect(safeReturnPath("//evil.example/approve/x")).toBeNull();
    expect(safeReturnPath("https://evil.example")).toBeNull();
    expect(safeReturnPath(`${path}/../../x`)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });
});
