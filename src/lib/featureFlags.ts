import { cache } from "react";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const flagCache = new Map<string, boolean>();

export const getFeatureFlag = cache(async (key: string, fallback = true) => {
  if (flagCache.has(key)) return flagCache.get(key)!;
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
  const value = data?.enabled ?? fallback;
  flagCache.set(key, value);
  return value;
});

export const getFeatureFlags = async (keys: string[], fallback = true) => {
  const entries = await Promise.all(keys.map(async (key) => [key, await getFeatureFlag(key, fallback)] as const));
  return Object.fromEntries(entries) as Record<string, boolean>;
};
