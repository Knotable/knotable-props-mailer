export const CAMPAIGN_ANALYTICS_CACHE_TTL_MS = 15 * 60 * 1_000;
export const CAMPAIGN_ANALYTICS_METRICS = [
  "queue",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
] as const;

export type CampaignAnalyticsMetric = (typeof CAMPAIGN_ANALYTICS_METRICS)[number];

export type CampaignAnalyticsSnapshot = {
  sent: number | null;
  failed: number | null;
  pending: number | null;
  canceled: number | null;
  delivered: number | null;
  opened: number | null;
  clicked: number | null;
  bounced: number | null;
  complained: number | null;
  listName: string | null;
  lastActivityAt: string | null;
  refreshedAt: string;
};

export function emptyCampaignAnalyticsSnapshot(now = new Date().toISOString()): CampaignAnalyticsSnapshot {
  return {
    sent: null,
    failed: null,
    pending: null,
    canceled: null,
    delivered: null,
    opened: null,
    clicked: null,
    bounced: null,
    complained: null,
    listName: null,
    lastActivityAt: null,
    refreshedAt: now,
  };
}

export function isCampaignAnalyticsFresh(
  snapshot: CampaignAnalyticsSnapshot,
  now = Date.now(),
  ttlMs = CAMPAIGN_ANALYTICS_CACHE_TTL_MS,
) {
  const refreshedAt = new Date(snapshot.refreshedAt).getTime();
  return Number.isFinite(refreshedAt) && now - refreshedAt < ttlMs;
}

export function metricRate(numerator: number | null, denominator: number | null) {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1_000) / 10;
}
