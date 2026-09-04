export type AnalyticsRpcError = {
  code?: string | null;
  message?: string | null;
};

export type AnalyticsFailure = {
  kind: "missing" | "timeout" | "unavailable";
  title: string;
  detail: string;
  code: string | null;
};

const MISSING_FUNCTION_CODES = new Set(["42883", "PGRST202"]);

export function describeAnalyticsFailure(error: AnalyticsRpcError): AnalyticsFailure {
  const code = error.code ?? null;
  const message = String(error.message ?? "");

  if (code === "57014" || /statement timeout|canceling statement/i.test(message)) {
    return {
      kind: "timeout",
      title: "Campaign analytics timed out.",
      detail:
        "The database canceled the exact aggregate before it finished. The campaigns exist, but their totals are intentionally hidden rather than shown as zero.",
      code,
    };
  }

  if (MISSING_FUNCTION_CODES.has(code ?? "") || /could not find.*function|does not exist/i.test(message)) {
    return {
      kind: "missing",
      title: "Campaign analytics function is not installed.",
      detail:
        "Apply the current analytics migrations, then run the analytics check again before trusting campaign totals.",
      code,
    };
  }

  return {
    kind: "unavailable",
    title: "Campaign analytics are temporarily unavailable.",
    detail:
      "The campaigns exist, but the exact aggregate failed. The page is withholding totals so an infrastructure error cannot masquerade as zero activity.",
    code,
  };
}

export function formatCampaignMetric(value: number, available: boolean, zeroAsDash = false) {
  if (!available) return "—";
  if (zeroAsDash && value === 0) return "—";
  return value.toLocaleString();
}
