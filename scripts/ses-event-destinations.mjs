#!/usr/bin/env node
// Points the SES configuration set at the aggregate-metrics layout:
//   - a CloudWatch destination (dimension campaign_id from the message tag) for
//     every event type, read by the worker as per-campaign totals;
//   - SNS (the app webhook) narrowed to bounces/complaints/rejects/rendering
//     failures, the only events the database still stores.
// Dry run by default; pass --apply to make the changes. Then checks that the
// worker's credentials can read CloudWatch.
//
//   AWS_REGION=... AWS_SES_CONFIGURATION_SET=... node scripts/ses-event-destinations.mjs [--apply]
import {
  SESv2Client,
  GetConfigurationSetEventDestinationsCommand,
  CreateConfigurationSetEventDestinationCommand,
  UpdateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import { CloudWatchClient, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { SES_NAMESPACE, planEventDestinations } from "./lib/ses-aggregate.mjs";

const apply = process.argv.includes("--apply");
const region = process.env.AWS_REGION?.trim();
const ConfigurationSetName = process.env.AWS_SES_CONFIGURATION_SET?.trim();
const out = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    import("node:fs").then(({ appendFileSync }) => appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`));
  }
};
const why = (error) => `${error?.name ?? "Error"}: ${String(error?.message ?? error).slice(0, 300)}`;

if (!region || !ConfigurationSetName) {
  out("AWS_REGION and AWS_SES_CONFIGURATION_SET are required.");
  process.exit(1);
}

const ses = new SESv2Client({ region });
let failed = false;

try {
  const { EventDestinations = [] } = await ses.send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName }));
  out(`Configuration set ${ConfigurationSetName}:`);
  for (const d of EventDestinations) {
    const kind = d.SnsDestination ? "SNS" : d.CloudWatchDestination ? "CloudWatch" : d.EventBridgeDestination ? "EventBridge" : d.KinesisFirehoseDestination ? "Firehose" : "other";
    out(`- ${d.Name} (${kind}, ${d.Enabled ? "on" : "off"}): ${(d.MatchingEventTypes ?? []).join(", ")}`);
  }
  const changes = planEventDestinations(EventDestinations);
  if (!changes.length) out("Already in the aggregate layout; nothing to change.");
  for (const change of changes) {
    out(`${apply ? "Applying" : "Would"} ${change.action} ${change.name}: ${change.destination.MatchingEventTypes.join(", ")}`);
    if (!apply) continue;
    const input = { ConfigurationSetName, EventDestinationName: change.name, EventDestination: change.destination };
    try {
      await ses.send(change.action === "create" ? new CreateConfigurationSetEventDestinationCommand(input) : new UpdateConfigurationSetEventDestinationCommand(input));
      out(`  done`);
    } catch (error) {
      failed = true;
      out(`  FAILED ${why(error)}`);
    }
  }
} catch (error) {
  failed = true;
  out(`Could not read event destinations: ${why(error)}`);
}

try {
  await new CloudWatchClient({ region }).send(new ListMetricsCommand({ Namespace: SES_NAMESPACE }));
  out("CloudWatch read access: OK");
} catch (error) {
  failed = true;
  out(`CloudWatch read access: FAILED ${why(error)} (the worker needs cloudwatch:ListMetrics and cloudwatch:GetMetricData)`);
}

process.exit(failed ? 1 : 0);
