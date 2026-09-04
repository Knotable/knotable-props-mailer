#!/usr/bin/env node
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

nextEnv.loadEnvConfig(process.cwd());

const requestedLimit = Number(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1] ?? 50);
if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
  throw new Error("--limit must be an integer from 1 to 100.");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("FAIL analytics credentials: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
const startedAt = Date.now();
const [{ data, error }, latestEvent] = await Promise.all([
  db.rpc("get_recent_email_analytics_stats", { p_limit: requestedLimit, p_offset: 0 }),
  db
    .from("provider_events")
    .select("received_at,event_type,provider")
    .order("received_at", { ascending: false })
    .limit(1),
]);
const elapsedMs = Date.now() - startedAt;

console.log(`Analytics readiness (read-only, ${requestedLimit} campaign rows)`);
if (error) {
  const code = error.code ?? null;
  const message = String(error.message ?? "");
  const kind = code === "57014" || /statement timeout|canceling statement/i.test(message)
    ? "timeout"
    : ["42883", "PGRST202"].includes(code) || /could not find.*function|does not exist/i.test(message)
      ? "missing"
      : "unavailable";
  const failure = {
    kind,
    code,
    title: kind === "timeout"
      ? "Campaign analytics timed out."
      : kind === "missing"
        ? "Campaign analytics function is not installed."
        : "Campaign analytics are temporarily unavailable.",
    detail: kind === "timeout"
      ? "The database canceled the exact aggregate before it finished."
      : "The exact aggregate did not return, so campaign totals cannot be trusted.",
  };
  console.error(`FAIL exact campaign totals: ${failure.title} [${failure.code ?? "no code"}] (${elapsedMs} ms)`);
  console.error(`     ${failure.detail}`);
  if (failure.kind === "timeout") {
    console.error("     Next: optimize/roll up get_recent_email_analytics_stats, then rerun this command.");
  } else if (failure.kind === "missing") {
    console.error("     Next: apply the current analytics migrations in filename order, then rerun this command.");
  }
} else {
  console.log(`PASS exact campaign totals: ${data?.length ?? 0} rows returned in ${elapsedMs} ms.`);
  const sample = data?.[0];
  if (sample) {
    console.log(`     Latest campaign: ${sample.subject || "Untitled"}; SES accepted ${Number(sample.sent ?? 0).toLocaleString()}.`);
  }
}

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
if (error) process.exit(1);
