#!/usr/bin/env node
// Points the SES configuration set at the aggregate-metrics layout:
//   - a CloudWatch destination (dimension campaign_id from the message tag) for
//     every event type, read by the worker as per-campaign totals;
//   - SNS (the app webhook) narrowed to bounces/complaints/rejects/rendering
//     failures, the only events the database still stores.
// Also records the SNS destination's topic ARN in app_settings so the webhook
// can verify incoming notifications without anyone retyping the ARN into an
// environment variable (which silently drifted and 403'd every real event).
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
import { SES_NAMESPACE, SES_SNS_TOPIC_ARN_KEY, planEventDestinations, snsTopicArnOf } from "./lib/ses-aggregate.mjs";

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

// Stores the live topic ARN where the webhook reads it. Without Supabase
// credentials (a local dry run) this only reports, so the script stays useful
// offline. A mismatching AWS_SES_SNS_TOPIC_ARN still wins at runtime, so say so
// loudly rather than letting the two disagree in silence.
async function publishTopicArn(topicArn) {
  if (!topicArn) {
    out("SNS topic ARN: NONE — no SNS event destination, so the webhook receives nothing.");
    return false;
  }
  out(`SNS topic ARN: ${topicArn}`);

  const override = process.env.AWS_SES_SNS_TOPIC_ARN?.trim();
  if (override && override !== topicArn) {
    out(`SNS topic ARN: MISMATCH — AWS_SES_SNS_TOPIC_ARN is ${override}, which overrides the value above and rejects every real event. Clear it or correct it.`);
    return false;
  }

  const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    out("SNS topic ARN: not stored (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset).");
    return true;
  }

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
    const updatedAt = new Date().toISOString();
    const { error } = await supabase.from("app_settings").upsert(
      {
        key: SES_SNS_TOPIC_ARN_KEY,
        value: { topicArn, configurationSet: ConfigurationSetName, region, at: updatedAt },
        description: "SNS topic the SES webhook accepts events from (written from live SES state)",
        updated_at: updatedAt,
      },
      { onConflict: "key" },
    );
    if (error) throw error;
    out("SNS topic ARN: stored for the webhook.");
    return true;
  } catch (error) {
    out(`SNS topic ARN: FAILED to store ${why(error)}`);
    return false;
  }
}

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
    const topic = d.SnsDestination?.TopicArn ? ` → ${d.SnsDestination.TopicArn}` : "";
    out(`- ${d.Name} (${kind}, ${d.Enabled ? "on" : "off"})${topic}: ${(d.MatchingEventTypes ?? []).join(", ")}`);
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
  if (!(await publishTopicArn(snsTopicArnOf(EventDestinations)))) failed = true;
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
