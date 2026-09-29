// Allowlist for the SNS topic(s) whose SES events /api/webhooks/ses accepts.
// AWS_SES_SNS_TOPIC_ARN may hold several ARNs (comma/space separated). Common
// paste mistakes are repaired rather than silently rejecting every event:
// surrounding quotes, and a *subscription* ARN (topic ARN + ":<uuid>"), which
// is what the SNS console shows on the subscription page.

const TOPIC_ARN = /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}(\.fifo)?$/;
const SUBSCRIPTION_SUFFIX = /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeSnsTopicArn(value: string): string | null {
  const trimmed = value.trim().replace(/^["'<]+|["'>]+$/g, "").trim();
  if (!trimmed) return null;
  const topic = trimmed.replace(SUBSCRIPTION_SUFFIX, "");
  return TOPIC_ARN.test(topic) ? topic : null;
}

export function parseSnsTopicAllowlist(raw: string | null | undefined): string[] {
  const entries = String(raw ?? "").split(/[\s,;]+/).map(normalizeSnsTopicArn);
  return [...new Set(entries.filter((entry): entry is string => Boolean(entry)))];
}

export function configuredSnsTopics(): string[] {
  return parseSnsTopicAllowlist(process.env.AWS_SES_SNS_TOPIC_ARN);
}

// With nothing (valid) configured, any SNS-signed topic is accepted, as before.
export function isAllowedSnsTopic(topicArn: unknown, allowlist: string[] = configuredSnsTopics()): boolean {
  if (allowlist.length === 0) return true;
  return typeof topicArn === "string" && allowlist.includes(topicArn);
}
