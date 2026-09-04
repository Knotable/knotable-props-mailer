import { NextResponse } from "next/server";
import { requireAdminAuthContext } from "@/lib/authAccess";
import { parseUuid } from "@/lib/ids";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { CampaignAnalyticsMetric } from "@/lib/lazyAnalytics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PROVIDER_METRICS = new Set<CampaignAnalyticsMetric>([
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
]);

type RpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

function numberValue(row: Record<string, unknown>, key: string) {
  const value = Number(row[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ emailId: string }> },
) {
  try {
    await requireAdminAuthContext();
  } catch {
    return noStoreJson({ error: "Admin access required" }, { status: 403 });
  }

  const emailId = parseUuid((await params).emailId);
  if (!emailId) return noStoreJson({ error: "Invalid email id" }, { status: 400 });

  const metric = new URL(request.url).searchParams.get("metric") as CampaignAnalyticsMetric | null;
  if (metric !== "queue" && !PROVIDER_METRICS.has(metric as CampaignAnalyticsMetric)) {
    return noStoreJson({ error: "Invalid analytics metric" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: campaign, error: campaignError } = await supabase
    .from("emails")
    .select("id")
    .eq("id", emailId)
    .maybeSingle();
  if (campaignError) return noStoreJson({ error: campaignError.message }, { status: 500 });
  const existingCampaign = campaign as { id?: string } | null;
  if (!existingCampaign?.id) return noStoreJson({ error: "Campaign not found" }, { status: 404 });

  const rpc = supabase as unknown as RpcClient;
  if (metric === "queue") {
    const { data, error } = await rpc.rpc("get_email_queue_analytics_metric", {
      p_email_id: emailId,
    });
    if (error) {
      return noStoreJson(
        { error: error.message ?? "Queue analytics failed", code: error.code ?? null },
        { status: error.code === "57014" ? 504 : 500 },
      );
    }
    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) return noStoreJson({ error: "Queue analytics returned no row" }, { status: 500 });

    const listIds = Array.isArray(row.list_ids)
      ? row.list_ids.filter((value): value is string => typeof value === "string")
      : [];
    const { data: lists } = listIds.length
      ? await supabase.from("lists").select("id, name").in("id", listIds)
      : { data: [] as { id: string; name: string }[] };
    const names = new Map(((lists ?? []) as { id: string; name: string }[]).map((list) => [list.id, list.name]));

    return noStoreJson({
      metric,
      values: {
        sent: numberValue(row, "sent"),
        failed: numberValue(row, "failed"),
        pending: numberValue(row, "pending"),
        canceled: numberValue(row, "canceled"),
        listName: listIds.length ? listIds.map((id) => names.get(id) ?? "Unknown list").join(", ") : null,
        lastActivityAt: typeof row.last_queued_at === "string" ? row.last_queued_at : null,
      },
    });
  }

  const providerMetric = metric as Exclude<CampaignAnalyticsMetric, "queue">;
  const { data, error } = await rpc.rpc("get_email_provider_analytics_metric", {
    p_email_id: emailId,
    p_event_type: providerMetric,
  });
  if (error) {
    return noStoreJson(
      { error: error.message ?? `${metric} analytics failed`, code: error.code ?? null },
      { status: error.code === "57014" ? 504 : 500 },
    );
  }
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return noStoreJson({ error: `${metric} analytics returned no row` }, { status: 500 });

  return noStoreJson({
    metric,
    values: {
      [providerMetric]: numberValue(row, "unique_recipients"),
      lastActivityAt: typeof row.latest_event_at === "string" ? row.latest_event_at : null,
    },
  });
}
