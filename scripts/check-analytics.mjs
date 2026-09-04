#!/usr/bin/env node
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

nextEnv.loadEnvConfig(process.cwd());

const requestedEmailId = process.argv.find((value) => value.startsWith("--email-id="))?.split("=")[1] ?? null;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("FAIL analytics credentials: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
let campaignQuery = db
  .from("emails")
  .select("id,subject,status,created_at")
  .limit(1);
campaignQuery = requestedEmailId
  ? campaignQuery.eq("id", requestedEmailId)
  : campaignQuery.neq("status", "draft").order("created_at", { ascending: false });

const { data: campaigns, error: campaignError } = await campaignQuery;
if (campaignError || !campaigns?.[0]) {
  console.error(`FAIL campaign selection: ${campaignError?.message ?? "No non-draft campaign found."}`);
  console.log("No rows were changed and no email was sent.");
  process.exit(1);
}

const campaign = campaigns[0];
console.log(`Lazy analytics readiness (read-only, campaign ${campaign.id})`);
console.log(`Subject: ${campaign.subject || "Untitled"}`);

const metrics = ["queue", "delivered", "opened", "clicked", "bounced", "complained"];
let failed = false;
for (const metric of metrics) {
  const startedAt = Date.now();
  const result = metric === "queue"
    ? await db.rpc("get_email_queue_analytics_metric", { p_email_id: campaign.id })
    : await db.rpc("get_email_provider_analytics_metric", {
        p_email_id: campaign.id,
        p_event_type: metric,
      });
  const elapsedMs = Date.now() - startedAt;

  if (result.error) {
    failed = true;
    const code = result.error.code ?? "no code";
    const message = String(result.error.message ?? "Analytics query failed.");
    const missing = ["42883", "PGRST202"].includes(result.error.code ?? "")
      || /could not find.*function|does not exist/i.test(message);
    console.error(`FAIL ${metric.padEnd(10)} ${message} [${code}] (${elapsedMs} ms)`);
    if (missing) {
      console.error("     Next: apply supabase/migrations/20260904_lazy_campaign_analytics.sql.");
    } else if (result.error.code === "57014" || /statement timeout|canceling statement/i.test(message)) {
      console.error(`     Next: inspect the ${metric} query plan/indexes; this bounded metric still exceeded statement_timeout.`);
    }
    continue;
  }

  const row = Array.isArray(result.data) ? result.data[0] : null;
  const value = metric === "queue"
    ? `accepted=${Number(row?.sent ?? 0).toLocaleString()}, pending=${Number(row?.pending ?? 0).toLocaleString()}, failed=${Number(row?.failed ?? 0).toLocaleString()}`
    : `unique recipients=${Number(row?.unique_recipients ?? 0).toLocaleString()}, raw events=${Number(row?.event_count ?? 0).toLocaleString()}`;
  console.log(`PASS ${metric.padEnd(10)} ${value} (${elapsedMs} ms)`);
}

const latestEvent = await db
  .from("provider_events")
  .select("received_at,event_type,provider")
  .order("received_at", { ascending: false })
  .limit(1);
if (latestEvent.error) {
  console.error(`WARN provider-event freshness: ${latestEvent.error.message}`);
} else if (!latestEvent.data?.[0]) {
  console.error("WARN provider-event freshness: no SES/provider events found.");
} else {
  const event = latestEvent.data[0];
  const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(event.received_at).getTime()) / 60_000));
  const freshness = ageMinutes <= 24 * 60 ? "PASS" : "WARN";
  console.log(`${freshness} provider-event freshness: latest ${event.provider}/${event.event_type} event is ${ageMinutes} minute(s) old.`);
}

console.log("No rows were changed and no email was sent.");
if (failed) process.exit(1);
