/**
 * POST /api/workers/send-queued
 *
 * Narrow cron endpoint for external schedulers. It drains one batch for an
 * email already marked `sending`, so a scheduler cannot release drafts or
 * broadly drain queued/sent campaigns.
 */

import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      error:
        "Vercel queue workers are disabled. Reconcile processing rows, then use the campaign-scoped GitHub Actions worker.",
    },
    { status: 410 },
  );
}
