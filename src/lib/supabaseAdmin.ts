import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "@/supabase/types";

let cachedClient: ReturnType<typeof createClient<Database>> | null = null;

export const getSupabaseAdmin = () => {
  if (cachedClient) return cachedClient;

  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new Error("Supabase admin env vars missing");
  }

  cachedClient = createClient<Database>(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return cachedClient;
};
