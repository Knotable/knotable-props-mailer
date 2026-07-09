import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { Json } from "@/supabase/types";

export const DEFAULT_DAILY_SEND_LIMIT = 65_400;
export const DEFAULT_SES_MAX_SEND_RATE_PER_SECOND = 15;
const DAILY_SEND_LIMIT_KEY = "daily_send_limit";
const SES_MAX_SEND_RATE_KEY = "ses_max_send_rate_per_second";

function readPositiveNumber(value: Json | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as Record<string, Json>).value;
    return readPositiveNumber(nested);
  }
  return null;
}

function readPositiveInteger(value: Json | null | undefined): number | null {
  const parsed = readPositiveNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

export async function getDailySendLimit(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", DAILY_SEND_LIMIT_KEY)
    .maybeSingle();

  if (error) {
    console.warn("[settings] daily send limit fallback", error.message);
    return DEFAULT_DAILY_SEND_LIMIT;
  }

  return readPositiveInteger(data?.value as Json) ?? DEFAULT_DAILY_SEND_LIMIT;
}

export async function getSesMaxSendRatePerSecond(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SES_MAX_SEND_RATE_KEY)
    .maybeSingle();

  if (error) {
    console.warn("[settings] SES max send rate fallback", error.message);
    return DEFAULT_SES_MAX_SEND_RATE_PER_SECOND;
  }

  return readPositiveNumber(data?.value as Json) ?? DEFAULT_SES_MAX_SEND_RATE_PER_SECOND;
}

export async function setDailySendLimit(value: number): Promise<number> {
  const limit = Math.floor(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new Error("Daily send limit must be between 1 and 1,000,000");
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("app_settings").upsert(
    {
      key: DAILY_SEND_LIMIT_KEY,
      value: { value: limit },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );

  if (error) throw error;
  return limit;
}

export async function setSesMaxSendRatePerSecond(value: number): Promise<number> {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0.1 || rate > 1_000) {
    throw new Error("SES max send rate must be between 0.1 and 1,000 per second");
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("app_settings").upsert(
    {
      key: SES_MAX_SEND_RATE_KEY,
      value: { value: rate },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );

  if (error) throw error;
  return rate;
}
