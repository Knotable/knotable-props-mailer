import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const logError = async ({
  message,
  source,
  userId,
  stack,
  payload,
  correlationId,
}: {
  message: string;
  source: string;
  userId?: string;
  stack?: string;
  payload?: Record<string, unknown>;
  correlationId?: string;
}) => {
  const supabase = getSupabaseAdmin();
  const id = correlationId ?? randomUUID();
  await supabase.from("error_logs").insert({
    message,
    source,
    user_id: userId ?? null,
    stack: stack ?? null,
    payload: payload ? JSON.stringify(payload) : null,
    correlation_id: id,
  });
  return id;
};

export const logAudit = async ({
  userId,
  action,
  entity,
  entityId,
  payload,
}: {
  userId: string;
  action: string;
  entity?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}) => {
  const supabase = getSupabaseAdmin();
  await supabase.from("audit_logs").insert({
    user_id: userId,
    action,
    entity: entity ?? null,
    entity_id: entityId ?? null,
    payload: payload ? JSON.stringify(payload) : null,
  });
};
