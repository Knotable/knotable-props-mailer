import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { Json } from "@/supabase/types";

export const DEFAULT_DAILY_SEND_LIMIT = 45_000;
const DAILY_SEND_LIMIT_KEY = "daily_send_limit";

function readPositiveInteger(value: Json | null | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as Record<string, Json>).value;
    return readPositiveInteger(nested);
  }
  return null;
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
