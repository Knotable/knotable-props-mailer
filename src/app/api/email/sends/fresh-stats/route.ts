import { NextResponse } from "next/server";
import { requireServerAuthContext } from "@/lib/authAccess";
import { parseUuid } from "@/lib/ids";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_EMAIL_IDS = 20;

type ReportRow = {
  email_id: string | null;
  succeeded: number | string | null;
  dead: number | string | null;
  pending: number | string | null;
  processing: number | string | null;
  canceled: number | string | null;
  first_queued_at: string | null;
  last_updated_at: string | null;
  first_send_date: string | null;
  last_send_date: string | null;
};

function toCount(value: number | string | null | undefined) {
  const count = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(count) ? Number(count) : 0;
}

function parseEmailIds(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawIds = [
    ...searchParams.getAll("id"),
    ...searchParams
      .getAll("ids")
      .flatMap((value) => value.split(",")),
  ];
  const ids = new Set<string>();
  for (const rawId of rawIds) {
    const id = parseUuid(rawId);
    if (id) ids.add(id);
    if (ids.size >= MAX_EMAIL_IDS) break;
  }
  return [...ids];
}

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");

  return NextResponse.json(body, {
    ...init,
    headers,
  });
}

export async function GET(request: Request) {
  try {
    await requireServerAuthContext();
  } catch {
    return noStoreJson({ error: "Unauthorized" }, { status: 401 });
  }

  const emailIds = parseEmailIds(request);
  if (emailIds.length === 0) {
    return noStoreJson({ error: "At least one email id is required" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: reportRows, error: reportError } = await supabase
    .from("email_send_report")
    .select(
      "email_id, succeeded, dead, pending, processing, canceled, first_queued_at, last_updated_at, first_send_date, last_send_date",
    )
    .in("email_id", emailIds);

  if (reportError) {
    return noStoreJson({ error: reportError.message }, { status: 500 });
  }

  const failedCountEntries = await Promise.all(
    emailIds.map(async (emailId) => {
      const { count, error } = await supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
        .eq("email_id", emailId)
        .eq("status", "failed");

      if (error) throw error;
      return [emailId, count ?? 0] as const;
    }),
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Failed to refresh failed counts";
    return noStoreJson({ error: message }, { status: 500 });
  });

  if (failedCountEntries instanceof NextResponse) {
    return failedCountEntries;
  }

  const reportsByEmailId = new Map(
    ((reportRows ?? []) as ReportRow[])
      .filter((row): row is ReportRow & { email_id: string } => Boolean(row.email_id))
      .map((row) => [row.email_id, row]),
  );
  const failedCountsByEmailId = new Map(failedCountEntries);

  return noStoreJson({
    stats: emailIds.map((emailId) => {
      const report = reportsByEmailId.get(emailId);
      return {
        email_id: emailId,
        sent: toCount(report?.succeeded),
        failed: toCount(report?.dead) + (failedCountsByEmailId.get(emailId) ?? 0),
        pending: toCount(report?.pending) + toCount(report?.processing),
        canceled: toCount(report?.canceled),
        first_sent: report?.first_send_date ?? null,
        last_queued_at:
          report?.last_send_date ??
          report?.last_updated_at ??
          report?.first_queued_at ??
          null,
      };
    }),
  });
}
