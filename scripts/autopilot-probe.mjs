#!/usr/bin/env node
// Cheap, dependency-free check run by the scheduled workflow before it pays for
// `npm ci`: is any approved campaign due for a worker right now?
import { appendFileSync } from "node:fs";
import { ACTIVE_STATES, AUTOPILOT_KEY_PREFIX, WORKER_LEASE_KEY, emailIdFromKey, isCompactionDue, isReportDue, orderDueRecords } from "./lib/autopilot-core.mjs";
import { SES_SUPPRESSION_SYNC_KEY, suppressionSyncDue } from "./lib/ses-suppression.mjs";

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const setOutput = (name, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};

if (!url || !key) {
  console.log("Supabase credentials are not configured; nothing to probe.");
  setOutput("due", "false");
  process.exit(0);
}

async function select(query) {
  const endpoint = `${url.replace(/\/+$/, "")}/rest/v1/app_settings?select=key,value&${query}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
    }
  }
}

try {
  const [rows, leaseRows, syncRows] = await Promise.all([
    select(`key=like.${encodeURIComponent(`${AUTOPILOT_KEY_PREFIX}*`)}`),
    select(`key=eq.${WORKER_LEASE_KEY}`),
    select(`key=eq.${encodeURIComponent(SES_SUPPRESSION_SYNC_KEY)}`),
  ]);
  // The SES suppression-list sync (list hygiene) is due on its own cadence.
  const suppressionDue = suppressionSyncDue(syncRows[0]?.value ?? null, Date.now());
  const lease = leaseRows[0]?.value;
  const leaseLive = Boolean(lease?.token && Date.parse(lease.expiresAt ?? "") > Date.now());
  const records = rows.map((row) => ({ ...(row.value ?? {}), emailId: row.value?.emailId ?? emailIdFromKey(row.key) }));
  const reportDelayHours = Number(process.env.SES_REPORT_DELAY_HOURS ?? 24);
  const reportsDue = records.filter((record) => isReportDue(record, Date.now(), (Number.isFinite(reportDelayHours) ? reportDelayHours : 24) * 3_600_000));
  const compactHours = Number(process.env.SES_COMPACT_AFTER_HOURS ?? 1);
  const compactionsDue = process.env.SES_COMPACT_HISTORY === "off" ? [] : records.filter((record) => isCompactionDue(record, Date.now(), (Number.isFinite(compactHours) ? compactHours : 1) * 3_600_000));
  // Cleanup must wake a worker even when no new campaign or report is due.
  const due = [...orderDueRecords(records, Date.now(), 3 * 60_000), ...reportsDue, ...compactionsDue];
  const active = records.filter((record) => ACTIVE_STATES.includes(record.state));
  console.log(JSON.stringify({
    leaseLive,
    active: active.map((record) => ({ emailId: record.emailId, state: record.state, nextCheckAt: record.nextCheckAt ?? null })),
    due: due.map((record) => record.emailId),
    suppressionDue,
  }));
  // A live worker re-lists due campaigns after each one, so it will pick these up.
  setOutput("due", (due.length || suppressionDue) && !leaseLive ? "true" : "false");
} catch (error) {
  // Fail open: the full worker has its own retries and lease.
  console.log(`Probe failed (${error.message}); starting the worker to decide.`);
  setOutput("due", "true");
}
