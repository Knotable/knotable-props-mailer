/**
 * POST /api/workers/send-queued
 *
 * Narrow cron endpoint for external schedulers. It drains one batch for an
 * email already marked `sending`, so a scheduler cannot release drafts or
 * broadly drain queued/sent campaigns.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { runQueueWorker } from "@/lib/queueWorker";

export const dynamic = "force-dynamic";

type SendingEmailRow = {
  id: string;
  subject: string | null;
};

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`);
}

async function loadNextSendingEmail() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("get_next_sending_campaign", {
    p_now: new Date().toISOString(),
  });

  if (error) throw error;
  return ((data ?? [])[0] as SendingEmailRow | undefined) ?? null;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action?: unknown } = {};
  try {
    body = (await request.json()) as { action?: unknown };
  } catch {
    body = {};
  }

  if (body.action != null && body.action !== "send_queued") {
    return NextResponse.json({ error: "Unsupported worker action" }, { status: 400 });
  }

  try {
    const active = await loadNextSendingEmail();
    if (!active) {
      return NextResponse.json({
        ok: true,
        action: "send_queued",
        processed: 0,
        message: "No sending campaigns have due or processing queue rows.",
      });
    }

    const result = await runQueueWorker({ emailId: active.id });
    return NextResponse.json({
      ok: true,
      action: "send_queued",
      emailId: active.id,
      subject: active.subject,
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker trigger failed";
    console.error("[send-queued worker trigger] failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
