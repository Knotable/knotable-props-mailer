import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HealthBanner } from "./health-banner";
afterEach(() => vi.unstubAllGlobals());
it("renders the same initial HTML with a warm browser cache as with no browser storage", () => {
  const serverHtml = renderToString(createElement(HealthBanner));
  const cache = { savedAt: Date.now(), report: { ok: true, critical: 0, warnings: 1, checks: [{ id: "warning", ok: false, severity: "warning", label: "Warning", message: "Details" }] } };
  vi.stubGlobal("window", {});
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => key === "health_banner_report_v1" ? JSON.stringify(cache) : null });
  expect(renderToString(createElement(HealthBanner))).toBe(serverHtml);
  expect(serverHtml).toContain("Health check");
});
