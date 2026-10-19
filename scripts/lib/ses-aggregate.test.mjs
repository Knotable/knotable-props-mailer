import { describe, expect, it } from "vitest";
import { CLOUDWATCH_EVENT_TYPES, SNS_EVENT_TYPES, fetchCampaignAggregates, freshSesStats, planEventDestinations, sesStatsDue } from "./ses-aggregate.mjs";

class ListMetricsCommand { constructor(input) { this.kind = "list"; this.input = input; } }
class GetMetricDataCommand { constructor(input) { this.kind = "data"; this.input = input; } }

const dims = (id, extra = []) => [{ Name: "campaign_id", Value: id }, ...extra];

describe("fetchCampaignAggregates", () => {
  it("sums every series of each metric for the campaign", async () => {
    const calls = [];
    const cw = {
      async send(command) {
        calls.push(command);
        if (command.kind === "list") {
          if (!command.input.NextToken) {
            return { Metrics: [
              { Namespace: "AWS/SES", MetricName: "Send", Dimensions: dims("c1") },
              { Namespace: "AWS/SES", MetricName: "Delivery", Dimensions: dims("c1") },
            ], NextToken: "p2" };
          }
          return { Metrics: [
            { Namespace: "AWS/SES", MetricName: "Open", Dimensions: dims("c1") },
            { Namespace: "AWS/SES", MetricName: "Open", Dimensions: dims("c1", [{ Name: "ses:configuration-set", Value: "x" }]) },
            { Namespace: "AWS/SES", MetricName: "Unknown", Dimensions: dims("c1") },
          ] };
        }
        const values = { m0: [100, 50], m1: [140], m2: [10, 5], m3: [1] };
        return { MetricDataResults: command.input.MetricDataQueries.map((q) => ({ Id: q.Id, Values: values[q.Id] ?? [] })) };
      },
    };
    const stats = await fetchCampaignAggregates(cw, { ListMetricsCommand, GetMetricDataCommand }, { campaignId: "c1", sinceMs: Date.parse("2026-10-01T00:30:00Z"), nowMs: Date.parse("2026-10-19T12:00:00Z") });
    expect(stats).toMatchObject({ sent: 150, delivered: 140, opened: 16, clicked: 0, bounced: 0, series: 4 });
    const data = calls.find((c) => c.kind === "data").input;
    expect(data.MetricDataQueries).toHaveLength(4);
    expect(data.MetricDataQueries[0].MetricStat).toMatchObject({ Period: 3600, Stat: "Sum" });
    expect(data.StartTime.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("returns zeros without querying data when SES has no series yet", async () => {
    const cw = { async send(command) { if (command.kind === "data") throw new Error("should not query"); return { Metrics: [] }; } };
    expect(await fetchCampaignAggregates(cw, { ListMetricsCommand, GetMetricDataCommand }, { campaignId: "c1", sinceMs: 0 })).toMatchObject({ sent: 0, series: 0 });
  });
});

describe("stats freshness", () => {
  it("is due when missing or old, fresh only when recent and error-free", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(sesStatsDue(null, now, 600_000)).toBe(true);
    expect(sesStatsDue({ at: "2026-10-19T11:55:00Z" }, now, 600_000)).toBe(false);
    expect(sesStatsDue({ at: "2026-10-19T11:49:00Z" }, now, 600_000)).toBe(true);
    expect(freshSesStats({ at: "2026-10-19T11:55:00Z", delivered: 3 }, now, 600_000)).toMatchObject({ delivered: 3 });
    expect(freshSesStats({ at: "2026-10-19T11:55:00Z", error: "AccessDenied" }, now, 600_000)).toBeNull();
    expect(freshSesStats({ at: "2026-10-19T11:00:00Z" }, now, 600_000)).toBeNull();
  });
});

describe("planEventDestinations", () => {
  const sns = { Name: "props-sns", Enabled: true, MatchingEventTypes: ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "OPEN", "CLICK"], SnsDestination: { TopicArn: "arn:t" } };

  it("adds the CloudWatch destination and narrows SNS", () => {
    const changes = planEventDestinations([sns]);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ action: "create", destination: { MatchingEventTypes: CLOUDWATCH_EVENT_TYPES } });
    expect(changes[0].destination.CloudWatchDestination.DimensionConfigurations).toEqual([
      { DimensionName: "campaign_id", DimensionValueSource: "MESSAGE_TAG", DefaultDimensionValue: "none" },
    ]);
    expect(changes[1]).toMatchObject({ action: "update", name: "props-sns", destination: { MatchingEventTypes: SNS_EVENT_TYPES, SnsDestination: { TopicArn: "arn:t" } } });
  });

  it("is a no-op once applied", () => {
    const applied = [
      { ...sns, MatchingEventTypes: [...SNS_EVENT_TYPES].reverse() },
      { Name: "cw", Enabled: true, MatchingEventTypes: CLOUDWATCH_EVENT_TYPES, CloudWatchDestination: { DimensionConfigurations: [{ DimensionName: "campaign_id", DimensionValueSource: "MESSAGE_TAG", DefaultDimensionValue: "none" }] } },
    ];
    expect(planEventDestinations(applied)).toEqual([]);
  });
});
