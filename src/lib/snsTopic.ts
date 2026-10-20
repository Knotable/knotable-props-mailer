import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// The SNS topic the webhook accepts events from.
//
// This used to be AWS_SES_SNS_TOPIC_ARN alone. A hand-typed copy of a value
// that lives in AWS drifts, and when it does the webhook 403s every real
// bounce and complaint — which is exactly what happened: the circuit breaker
// and the suppression list went blind without anything failing loudly.
//
// So the source of truth is now the live SES configuration set, published to
// app_settings by scripts/ses-event-destinations.mjs. The env var remains as an
// override for break-glass use; unset-and-unstored still means "accept any
// topic", because rejecting everything is worse than accepting a spoof that
// already passed SNS signature verification.
//
// The lookup is cached per instance: the send path spent a week shedding
// per-event database work and must not gain any back.

export const SES_SNS_TOPIC_ARN_KEY = "ses_sns_topic_arn";
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

let cachedArn: string | null = null;
let cachedUntil = 0;

export function __resetSnsTopicCacheForTests() {
  cachedArn = null;
  cachedUntil = 0;
}

function envTopicArn(): string | null {
  return process.env.AWS_SES_SNS_TOPIC_ARN?.trim() || null;
}

async function storedTopicArn(): Promise<{ arn: string | null; ok: boolean }> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_settings")
      .select("value")
      .eq("key", SES_SNS_TOPIC_ARN_KEY)
      .maybeSingle();
    if (error) throw error;
    const value = data?.value as { topicArn?: unknown } | null;
    const arn = typeof value?.topicArn === "string" ? value.topicArn.trim() : "";
    return { arn: arn || null, ok: true };
  } catch (err) {
    console.warn("[ses-webhook] SNS topic lookup failed", err);
    return { arn: null, ok: false };
  }
}

export async function expectedSnsTopicArn(nowMs = Date.now()): Promise<string | null> {
  const override = envTopicArn();
  if (override) return override;
  if (nowMs < cachedUntil) return cachedArn;
  const { arn, ok } = await storedTopicArn();
  cachedArn = arn;
  // Back off briefly on failure so a database blip cannot start rejecting
  // events, and cannot turn into a lookup per notification either.
  cachedUntil = nowMs + (ok ? CACHE_TTL_MS : FAILURE_TTL_MS);
  return cachedArn;
}

// No configured topic means "accept any", matching the previous behaviour when
// the env var was unset.
export async function isExpectedSnsTopic(topicArn: unknown): Promise<boolean> {
  const expected = await expectedSnsTopicArn();
  if (!expected) return true;
  return topicArn === expected;
}
