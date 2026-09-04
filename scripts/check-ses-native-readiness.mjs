#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import nextEnv from "@next/env";
import { evaluateSesCapacity, planCampaignBatches, requiredSesCapacity } from "./lib/readiness-core.mjs";

nextEnv.loadEnvConfig(process.cwd());

const args = new Map();
for (const argument of process.argv.slice(2)) {
  const [key, value = "true"] = argument.split("=", 2);
  args.set(key, value);
}
const live = args.has("--live");
const json = args.has("--json");
const audience = Number(args.get("--audience") ?? 150_000);
const batchCount = Number(args.get("--batches") ?? 3);
const maxDurationMinutes = Number(args.get("--max-minutes") ?? 75);
const quotaBuffer = Number(args.get("--quota-buffer") ?? 1.2);
const batchPlan = planCampaignBatches({ audience, batches: batchCount });
const largestBatch = Math.max(...batchPlan.map((batch) => batch.size));
const requirements = requiredSesCapacity({ audience: largestBatch, maxDurationMinutes, quotaBuffer });
const checks = [];

function add(status, name, detail, next = null) {
  checks.push({ status, name, detail, next });
}

function read(path) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const templatePath = "infra/ses-native-worker/cloudformation.yml";
const workflowPath = ".github/workflows/ses-native-worker.yml";
const workerPath = "scripts/ses-native-worker.mjs";
const builderPath = "scripts/build-ses-native-campaign.mjs";
const template = existsSync(templatePath) ? read(templatePath) : "";
const workflow = existsSync(workflowPath) ? read(workflowPath) : "";
const worker = existsSync(workerPath) ? read(workerPath) : "";
const builder = existsSync(builderPath) ? read(builderPath) : "";

add(
  template && /AWS::S3::Bucket/.test(template) && /VersioningConfiguration:[\s\S]*Status:\s*Enabled/.test(template)
    && /AWS::DynamoDB::Table/.test(template) && /PointInTimeRecoveryEnabled:\s*true/.test(template)
    && /AWS::SES::ConfigurationSet/.test(template),
  "AWS durability template",
  "CloudFormation defines versioned private S3, point-in-time-recoverable DynamoDB, and an SES configuration set.",
  `Restore or complete ${templatePath}.`,
);

const usesOidc = /id-token:\s*write/.test(workflow)
  && /aws-actions\/configure-aws-credentials@/.test(workflow)
  && /role-to-assume:/.test(workflow)
  && !/AWS_ACCESS_KEY_ID:\s*\$\{\{\s*secrets\./.test(workflow);
add(
  usesOidc,
  "GitHub-to-AWS authentication",
  usesOidc ? "Worker workflow uses short-lived GitHub OIDC credentials." : "Worker workflow still lacks verified OIDC role assumption.",
  "Add the GitHub OIDC provider/IAM role, grant id-token: write, and replace static AWS access-key secrets.",
);

const eventTypes = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "OPEN", "CLICK"];
const missingEventTypes = eventTypes.filter((eventType) => !new RegExp(`- ${eventType}\\b`, "i").test(template));
add(
  missingEventTypes.length === 0,
  "SES event coverage",
  missingEventTypes.length ? `CloudFormation is missing ${missingEventTypes.join(", ")} event publication.` : "Send, delivery, bounce, complaint, open, and click events are declared.",
  "Add every required SES event type and verify the Lambda event destination.",
);

const hasOneClickUnsubscribe = /List-Unsubscribe-Post/i.test(`${worker}\n${builder}`)
  && /List-Unsubscribe/i.test(`${worker}\n${builder}`);
add(
  hasOneClickUnsubscribe,
  "One-click unsubscribe",
  hasOneClickUnsubscribe ? "Native messages declare RFC 8058 one-click unsubscribe headers." : "The native worker does not yet prove RFC 8058 one-click unsubscribe headers.",
  "Add per-recipient signed unsubscribe URLs plus List-Unsubscribe and List-Unsubscribe-Post headers, then test suppression before a canary.",
);

const controlCandidates = [
  "src/app/(dashboard)/email/aws-native/page.tsx",
  "src/app/(dashboard)/email/native/page.tsx",
  "src/app/(dashboard)/email/campaigns/[emailId]/native/page.tsx",
];
const hasAppControlSurface = controlCandidates.some((path) => existsSync(path));
add(
  hasAppControlSurface,
  "In-app native launch and status",
  hasAppControlSurface ? "An AWS-native app control surface exists." : "No app page launches or reports the AWS-native campaign path yet.",
  "Add authenticated snapshot/dry-run/launch/status controls backed by S3 and DynamoDB; keep sending outside Vercel request execution.",
);

add(
  /mode === "dry-run"/.test(worker) && /No DynamoDB state was changed and no email was sent/.test(worker)
    && /state\.claimed > 0/.test(worker),
  "Fail-closed claim handling",
  "Dry-run is non-mutating and ambiguous CLAIMED recipients stop the send.",
  "Restore non-mutating dry-run and ambiguous-claim guards.",
);

const nativeSources = `${worker}\n${builder}\n${workflow}`;
const hasApprovalBatches = /QUEUED_FOR_APPROVAL/.test(nativeSources)
  && /READY_FOR_APPROVAL/.test(nativeSources)
  && /--batch-number/.test(nativeSources)
  && /quota\.remaining\s*<\s*(?:batchRemaining|remainingInBatch)/.test(nativeSources);
add(
  hasApprovalBatches,
  "Three approval-gated release batches",
  hasApprovalBatches
    ? "The native path binds releases to a batch number, preserves later batches as queued, and checks quota for only the approved batch."
    : "The native worker still treats the immutable manifest as one all-or-nothing release; the three-batch approval state machine is not implemented.",
  "Persist three digest-bound release records (READY_FOR_APPROVAL, QUEUED_FOR_APPROVAL), accept --batch-number, and fail closed unless that batch has full rolling quota headroom.",
);

const hasOperatorNotice = /SES_OPERATOR_EMAIL/.test(nativeSources)
  && /operator_notice_sent_at|operatorNoticeSentAt/.test(nativeSources)
  && /SES_APP_URL/.test(nativeSources);
add(
  hasOperatorNotice,
  "Idempotent next-batch operator email",
  hasOperatorNotice
    ? "A terminal batch can send one durable operator notice with a return-to-app URL."
    : "No idempotent completion notice invites the operator back to approve the next batch.",
  "After terminal reconciliation (zero CLAIMED/RETRY), conditionally record the notice once and email SES_OPERATOR_EMAIL a SES_APP_URL link; do not release the next batch.",
);

if (!live) {
  add("SKIP", "Live AWS deployment", "Not checked. Re-run with --live after setting AWS-native environment variables.", "npm run check:150k -- --live");
} else {
  const requiredEnv = ["AWS_REGION", "AWS_SES_CONFIGURATION_SET", "SES_CAMPAIGN_BUCKET", "SES_CAMPAIGN_STATE_TABLE"];
  const missingEnv = requiredEnv.filter((name) => !process.env[name]);
  if (missingEnv.length) {
    add(false, "Live AWS configuration", `Missing ${missingEnv.join(", ")}.`, "Set the deployed CloudFormation outputs and rerun with --live.");
  } else {
    const [{ SESv2Client, GetAccountCommand, GetConfigurationSetCommand }, s3Module, ddbModule] = await Promise.all([
      import("@aws-sdk/client-sesv2"),
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/client-dynamodb"),
    ]);
    const { S3Client, HeadBucketCommand, GetBucketVersioningCommand } = s3Module;
    const { DynamoDBClient, DescribeTableCommand, DescribeContinuousBackupsCommand } = ddbModule;
    const region = process.env.AWS_REGION;
    const ses = new SESv2Client({ region });
    const s3 = new S3Client({ region });
    const ddb = new DynamoDBClient({ region });

    try {
      const account = await ses.send(new GetAccountCommand({}));
      const quota = account.SendQuota ?? {};
      const capacity = evaluateSesCapacity({
        audience: largestBatch,
        max24Hour: Number(quota.Max24HourSend ?? 0),
        sentLast24Hours: Number(quota.SentLast24Hours ?? 0),
        maxRate: Number(quota.MaxSendRate ?? 0),
        maxDurationMinutes,
        quotaBuffer,
      });
      add(account.ProductionAccessEnabled === true, "SES production access", `Production access: ${Boolean(account.ProductionAccessEnabled)}.`, "Request SES production access in the worker region.");
      add(capacity.quotaReady, "SES quota and rolling batch headroom", `Quota ${Number(quota.Max24HourSend ?? 0).toLocaleString()}; sent last 24h ${Number(quota.SentLast24Hours ?? 0).toLocaleString()}; headroom ${capacity.headroom.toLocaleString()}; batch ${largestBatch.toLocaleString()}; policy quota minimum ${requirements.requiredDailyQuota.toLocaleString()}.`, "Raise quota or wait until rolling headroom covers the complete approved batch.");
      add(capacity.rateReady, "SES send rate", `Rate ${Number(quota.MaxSendRate ?? 0)}/s; batch policy minimum ${requirements.requiredSesRate}/s; estimated ${capacity.estimatedMinutes ?? "unknown"} minutes.`, "Request a higher SES maximum send rate or explicitly revise the batch-duration policy.");
    } catch (error) {
      add(false, "SES live access", error.message, "Fix AWS credentials, IAM permissions, and region, then rerun.");
    }

    try {
      const bucket = process.env.SES_CAMPAIGN_BUCKET;
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      add(versioning.Status === "Enabled", "S3 campaign store", `Bucket ${bucket} is reachable; versioning=${versioning.Status ?? "disabled"}.`, "Deploy the stack or enable bucket versioning.");
    } catch (error) {
      add(false, "S3 campaign store", error.message, "Deploy the stack and grant read/write access to the worker role.");
    }

    try {
      const tableName = process.env.SES_CAMPAIGN_STATE_TABLE;
      const [table, backups] = await Promise.all([
        ddb.send(new DescribeTableCommand({ TableName: tableName })),
        ddb.send(new DescribeContinuousBackupsCommand({ TableName: tableName })),
      ]);
      const pitr = backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
      add(table.Table?.TableStatus === "ACTIVE" && pitr === "ENABLED", "DynamoDB campaign state", `Table ${tableName}: ${table.Table?.TableStatus}; PITR=${pitr}.`, "Deploy/repair the state table and enable point-in-time recovery.");
    } catch (error) {
      add(false, "DynamoDB campaign state", error.message, "Deploy the stack and grant describe/read/write access to the worker role.");
    }

    try {
      const configurationSetName = process.env.AWS_SES_CONFIGURATION_SET;
      const configuration = await ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: configurationSetName }));
      const published = new Set((configuration.EventDestinations ?? []).flatMap((destination) => destination.MatchingEventTypes ?? []).map(String));
      const missing = eventTypes.filter((eventType) => !published.has(eventType));
      add(missing.length === 0, "Live SES event destination", missing.length ? `Configuration set ${configurationSetName} is missing ${missing.join(", ")}.` : `Configuration set ${configurationSetName} publishes all required events.`, "Deploy/repair the SES event destination and prove an event reaches DynamoDB and S3.");
    } catch (error) {
      add(false, "Live SES event destination", error.message, "Deploy the configuration set and grant ses:GetConfigurationSet.");
    }
  }
}

const normalized = checks.map((check) => ({ ...check, status: check.status === true ? "PASS" : check.status === false ? "FAIL" : check.status }));
const failures = normalized.filter((check) => check.status === "FAIL");
if (json) {
  console.log(JSON.stringify({ audience, batchPlan, policy: { ...requirements, maxDurationMinutes, quotaBuffer, largestBatch }, ready: failures.length === 0 && live, checks: normalized }, null, 2));
} else {
  console.log(`SES-native readiness for ${audience.toLocaleString()} recipients (read-only)`);
  console.log(`Plan: ${batchPlan.map((batch) => `batch ${batch.batchNumber}=${batch.size.toLocaleString()} (${batch.releaseState})`).join("; ")}.`);
  console.log(`Per-batch policy: quota >= ${requirements.requiredDailyQuota.toLocaleString()}, rolling headroom >= ${largestBatch.toLocaleString()}, rate >= ${requirements.requiredSesRate}/s, batch <= ${maxDurationMinutes} minutes.`);
  for (const check of normalized) {
    console.log(`${check.status.padEnd(4)} ${check.name}: ${check.detail}`);
    if (check.status !== "PASS" && check.next) console.log(`     Next: ${check.next}`);
  }
  console.log("No AWS resource was changed and no email was sent.");
}
if (failures.length) process.exitCode = 1;
