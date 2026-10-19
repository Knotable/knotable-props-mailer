// Campaign totals from SES's own aggregate metrics instead of one database row
// per recipient event. SES publishes each event to CloudWatch (configuration-set
// event destination, dimension `campaign_id` taken from the message tag the
// worker already sets), and the worker reads the sums every ~10 minutes and
// stores one row per campaign (app_settings `ses_stats:<campaignId>`).
//
// Cost: SES publishing is free; CloudWatch bills each metric (one per event
// type per campaign) by the hour it receives data, about $0.30/month for a
// metric that is busy all month, the first 10 free. Reading is
// $0.01 per 1,000 metrics requested. A campaign costs cents.

export const SES_STATS_KEY_PREFIX = "ses_stats:";
export const SES_NAMESPACE = "AWS/SES";
export const CAMPAIGN_DIMENSION = "campaign_id";

// Field name in our stats → SES/CloudWatch metric name.
export const SES_AGGREGATE_METRICS = {
  sent: "Send",
  delivered: "Delivery",
  bounced: "Bounce",
  complained: "Complaint",
  opened: "Open",
  clicked: "Click",
  rejected: "Reject",
  delayed: "DeliveryDelay",
  renderingFailures: "Rendering Failure",
};

// SES event types the CloudWatch destination publishes (SESv2 enum names).
export const CLOUDWATCH_EVENT_TYPES = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "OPEN", "CLICK", "RENDERING_FAILURE", "DELIVERY_DELAY"];
// The SNS destination keeps only what changes who we may email next.
export const SNS_EVENT_TYPES = ["BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE"];

export function sesStatsKey(campaignId) {
  return `${SES_STATS_KEY_PREFIX}${campaignId}`;
}

export function sesStatsDue(stats, nowMs, everyMs) {
  const at = Date.parse(stats?.at ?? "");
  return !Number.isFinite(at) || nowMs - at >= everyMs;
}

// Usable for decisions (e.g. the breaker's "are events flowing?" check) only
// when fetched recently and without error.
export function freshSesStats(stats, nowMs, maxAgeMs) {
  if (!stats || stats.error) return null;
  const at = Date.parse(stats.at ?? "");
  return Number.isFinite(at) && nowMs - at <= maxAgeMs ? stats : null;
}

// CloudWatch requires a period that is a multiple of 60; hourly buckets keep
// the query valid for data older than 15 and 63 days.
const PERIOD_SECONDS = 3600;

// `cw` is any object with send(command); `commands` supplies the command
// classes so tests can pass a fake without the AWS SDK.
export async function fetchCampaignAggregates(cw, commands, { campaignId, sinceMs, nowMs = Date.now() }) {
  const { ListMetricsCommand, GetMetricDataCommand } = commands;
  const wanted = new Map(Object.entries(SES_AGGREGATE_METRICS).map(([field, metric]) => [metric, field]));
  wanted.set("RenderingFailure", "renderingFailures");

  // A metric's full dimension set is whatever the destination configured, so
  // list the exact series for this campaign rather than guessing them.
  const series = [];
  let NextToken;
  do {
    const page = await cw.send(new ListMetricsCommand({
      Namespace: SES_NAMESPACE,
      Dimensions: [{ Name: CAMPAIGN_DIMENSION, Value: campaignId }],
      NextToken,
    }));
    for (const metric of page.Metrics ?? []) {
      if (wanted.has(metric.MetricName)) series.push(metric);
    }
    NextToken = page.NextToken;
  } while (NextToken);

  const stats = Object.fromEntries(Object.keys(SES_AGGREGATE_METRICS).map((field) => [field, 0]));
  if (!series.length) return { ...stats, series: 0 };

  const start = new Date(Math.floor(sinceMs / (PERIOD_SECONDS * 1000)) * PERIOD_SECONDS * 1000);
  const end = new Date(Math.ceil((nowMs + 60_000) / 60_000) * 60_000);
  for (let offset = 0; offset < series.length; offset += 500) {
    const slice = series.slice(offset, offset + 500);
    const queries = slice.map((metric, index) => ({
      Id: `m${offset + index}`,
      MetricStat: { Metric: metric, Period: PERIOD_SECONDS, Stat: "Sum" },
      ReturnData: true,
    }));
    let PageToken;
    do {
      const page = await cw.send(new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: start, EndTime: end, NextToken: PageToken }));
      for (const result of page.MetricDataResults ?? []) {
        const metric = slice[Number(String(result.Id).slice(1)) - offset];
        const field = metric && wanted.get(metric.MetricName);
        if (!field) continue;
        stats[field] += (result.Values ?? []).reduce((sum, value) => sum + (Number(value) || 0), 0);
      }
      PageToken = page.NextToken;
    } while (PageToken);
  }
  for (const field of Object.keys(SES_AGGREGATE_METRICS)) stats[field] = Math.round(stats[field]);
  return { ...stats, series: series.length };
}

// Compare a configuration set's current event destinations with the target
// layout and return the changes to make (pure, so it can be dry-run and tested).
export function planEventDestinations(destinations, { cloudWatchName = "props-aggregate-cloudwatch" } = {}) {
  const changes = [];
  const sameTypes = (a, b) => [...(a ?? [])].sort().join(",") === [...b].sort().join(",");
  const cloudWatch = destinations.find((d) => d.CloudWatchDestination);
  const dimensionOk = (d) => (d?.CloudWatchDestination?.DimensionConfigurations ?? []).some(
    (c) => c.DimensionName === CAMPAIGN_DIMENSION && c.DimensionValueSource === "MESSAGE_TAG",
  );
  const cloudWatchDestination = {
    Enabled: true,
    MatchingEventTypes: CLOUDWATCH_EVENT_TYPES,
    CloudWatchDestination: {
      DimensionConfigurations: [
        { DimensionName: CAMPAIGN_DIMENSION, DimensionValueSource: "MESSAGE_TAG", DefaultDimensionValue: "none" },
      ],
    },
  };
  if (!cloudWatch) {
    changes.push({ action: "create", name: cloudWatchName, destination: cloudWatchDestination });
  } else if (!cloudWatch.Enabled || !sameTypes(cloudWatch.MatchingEventTypes, CLOUDWATCH_EVENT_TYPES) || !dimensionOk(cloudWatch)) {
    changes.push({ action: "update", name: cloudWatch.Name, destination: cloudWatchDestination });
  }
  for (const sns of destinations.filter((d) => d.SnsDestination)) {
    if (sameTypes(sns.MatchingEventTypes, SNS_EVENT_TYPES)) continue;
    changes.push({
      action: "update",
      name: sns.Name,
      destination: { Enabled: sns.Enabled ?? true, MatchingEventTypes: SNS_EVENT_TYPES, SnsDestination: sns.SnsDestination },
    });
  }
  return changes;
}
