import { describe, expect, it } from "vitest";
import { parseSuppressTargets } from "./listCleanup";

describe("list cleanup targets", () => {
  it("separates exact domains from addresses and never targets the owner", () => {
    expect(parseSuppressTargets("dwight.edu, @CIS.dk\n_a@sarva.co a@sarva.co; junk; *.edu", "a@sarva.co")).toEqual({
      domains: ["dwight.edu", "cis.dk"],
      addresses: ["_a@sarva.co"],
    });
  });

  it("rejects wildcard or malformed entries", () => {
    expect(parseSuppressTargets("% , *.com, edu, @, x@y")).toEqual({ domains: [], addresses: [] });
  });
});
