#!/usr/bin/env node
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { SESv2Client, GetAccountCommand, SendBulkEmailCommand } from "@aws-sdk/client-sesv2";
import {
  assertSendReadySubject,
  classifySesResult,
  compileTemplate,
  isBlockedRecipient,
  recipientData,
} from "./lib/ses-bulk-worker-core.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const conciseError = (error) => String(error?.message ?? error ?? "unknown error").replace(/\s+/g, " ").slice(0, 240);
async function retrySupabaseRead(label, operation, maxAttempts = 8) {
  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await operation();
    if (!lastResult.error) return lastResult;
    if (attempt < maxAttempts) {
      const retryDelayMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      console.warn(`${label} attempt ${attempt}/${maxAttempts} failed (${conciseError(lastResult.error)}); retrying in ${retryDelayMs}ms`);
      await sleep(retryDelayMs);
    }
  }
  return lastResult;
}

const emailId = args.get("--email-id");
const mode = args.get("--mode") ?? "dry-run";
const confirmation = args.get("--confirmation") ?? "";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!emailId || !uuidPattern.test(emailId)) throw new Error("--email-id must be a UUID");
if (!["dry-run", "send"].includes(mode)) throw new Error("--mode must be dry-run or send");

const required = (name, fallback) => {
  const value = process.env[name] || (fallback ? process.env[fallback] : undefined);
  if (!value) throw new Error(`Missing ${name}${fallback ? ` (or ${fallback})` : ""}`);
  return value;
};
const supabaseUrl = required("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const appBaseUrl = required("APP_BASE_URL");
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: email, error: emailError } = await supabase
  .from("emails")
  .select("id, from_address, reply_to, subject, html, text, status, tags, campaigns")
  .eq("id", emailId)
  .single();
if (emailError) throw new Error(`Unable to load campaign: ${emailError.message}`);
assertSendReadySubject(email.subject);

const { data: summaries, error: summaryError } = await supabase.rpc("get_queue_campaign_summaries", {
  p_email_ids: [emailId],
  p_now: new Date().toISOString(),
});
if (summaryError) throw new Error(`Unable to load queue summary: ${summaryError.message}`);
const summary = (summaries ?? []).reduce((total, row) => {
  for (const key of ["pending_due", "pending_held", "processing", "succeeded", "failed", "dead", "canceled", "total"])
    total[key] += Number(row[key] ?? 0);
  return total;
}, { pending_due: 0, pending_held: 0, processing: 0, succeeded: 0, failed: 0, dead: 0, canceled: 0, total: 0 });

const { data: sample, error: sampleError } = await supabase
  .from("mail_queue")
  .select("id, payload")
  .eq("email_id", emailId)
  .eq("status", "pending")
  .limit(1)
  .maybeSingle();
if (sampleError) throw new Error(`Unable to load queue sample: ${sampleError.message}`);
const compiled = compileTemplate({ subject: email.subject, html: email.html, text: email.text, appBaseUrl });
if (sample) compiled.replacementData(recipientData(sample.payload, sample.id));

console.log(JSON.stringify({ mode, campaign: { id: email.id, subject: email.subject, status: email.status }, queue: summary }, null, 2));
if (mode === "dry-run") {
  console.log("Dry run complete. No database rows were changed and no email was sent.");
  process.exit(0);
}

if (confirmation !== `send:${emailId}`) throw new Error(`Send mode requires --confirmation send:${emailId}`);
if (!["queued", "sending"].includes(email.status)) throw new Error(`Campaign status ${email.status} is not eligible for a bulk send.`);
if (summary.processing > 0) throw new Error(`${summary.processing} processing row(s) already exist. Refusing to risk duplicate delivery; reconcile them first.`);
if (summary.pending_due + summary.pending_held === 0) throw new Error("No pending recipients remain.");

const region = required("AWS_REGION");
const ses = new SESv2Client({ region });
const account = await ses.send(new GetAccountCommand({}));
const maxRate = Number(account.SendQuota?.MaxSendRate ?? 1);
const max24Hour = Number(account.SendQuota?.Max24HourSend ?? 0);
const sentLast24Hours = Number(account.SendQuota?.SentLast24Hours ?? 0);
const quotaRemaining = Math.max(0, Math.floor(max24Hour - sentLast24Hours));
if (quotaRemaining === 0) throw new Error(`SES rolling quota is full (${sentLast24Hours}/${max24Hour}).`);
await new Promise((resolve) => setTimeout(resolve, 1100));

const requestedClaimSize = Number(process.env.SES_BULK_CLAIM_SIZE ?? 50);
const claimSize = Math.max(1, Math.min(50, requestedClaimSize, quotaRemaining));
const configuredRateCap = Number(process.env.SES_BULK_MAX_RECIPIENTS_PER_SECOND ?? maxRate);
if (!Number.isFinite(configuredRateCap) || configuredRateCap < 1) {
  throw new Error("SES_BULK_MAX_RECIPIENTS_PER_SECOND must be a number greater than or equal to 1.");
}
const effectiveSendRate = Math.min(maxRate * 0.9, configuredRateCap);
const sendRequestSize = Math.max(1, Math.min(50, Math.floor(effectiveSendRate)));
const sendRequestIntervalMs = Math.ceil((sendRequestSize / effectiveSendRate) * 1000) + 100;
const recoveryPauseEvery = Math.max(0, Number(process.env.SES_BULK_RECOVERY_PAUSE_EVERY ?? 0));
const recoveryPauseMs = Math.max(0, Number(process.env.SES_BULK_RECOVERY_PAUSE_MS ?? 0));
const workerId = `ses-bulk:${process.env.GITHUB_RUN_ID ?? "local"}:${crypto.randomUUID()}`;
const configurationSet = process.env.AWS_SES_CONFIGURATION_SET?.trim();
const headers = email.reply_to ? [{ Name: "List-Unsubscribe", Value: `<mailto:${email.reply_to}?subject=Unsubscribe>` }] : [];

console.log(JSON.stringify({ sesMaxRate: maxRate, configuredRateCap, effectiveSendRate, sendRequestSize, sendRequestIntervalMs, claimSize, recoveryPauseEvery, recoveryPauseMs }));

const { error: activateError } = await supabase.from("emails").update({ status: "sending", updated_at: new Date().toISOString() }).eq("id", emailId).in("status", ["queued", "sending"]);
if (activateError) throw new Error(`Unable to activate campaign: ${activateError.message}`);

let accepted = 0;
let failed = 0;
let remainingQuota = quotaRemaining;
let requestCount = 0;
let nextRecoveryPauseAt = recoveryPauseEvery;
while (remainingQuota > 0) {
  const limit = Math.min(claimSize, remainingQuota);
  const now = new Date().toISOString();
  // The SQL claim RPC has to consider both due and year-2999 held rows, which
  // produced an expensive OR + sort plan on the free Supabase compute tier.
  // A GitHub concurrency lock guarantees only one bulk worker per campaign, so
  // use the existing email/status/created_at index to select a bounded set and
  // then conditionally transition exactly those ids. The conditional update
  // still fails closed if another worker somehow races this one.
  const { data: candidates, error: candidateError } = await retrySupabaseRead(
    "select queue batch",
    () => supabase
      .from("mail_queue")
      .select("id")
      .eq("email_id", emailId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit),
  );
  if (candidateError) throw new Error(`Unable to select queue batch: ${candidateError.message}`);
  if (!candidates?.length) break;

  const candidateIds = candidates.map((candidate) => candidate.id);
  const { data: items, error: claimError } = await supabase
    .from("mail_queue")
    .update({
      status: "processing",
      locked_at: now,
      last_heartbeat: now,
      correlation_id: workerId,
      updated_at: now,
    })
    .eq("email_id", emailId)
    .eq("status", "pending")
    .in("id", candidateIds)
    .select("id, payload, list_id, attempts, max_attempts");
  if (claimError) throw new Error(`Unable to claim queue batch: ${claimError.message}`);
  if (items?.length !== candidateIds.length) {
    throw new Error(`Queue claim race detected: ${items?.length ?? 0}/${candidateIds.length} rows transitioned. Stop and reconcile before retrying.`);
  }

  const invalid = [];
  const deliverable = [];
  for (const item of items) {
    const payload = item.payload ?? {};
    try {
      if (!payload.to || typeof payload.to !== "string") throw new Error("Missing recipient address");
      if (isBlockedRecipient(payload.to)) {
        invalid.push({ id: item.id, outcome: "canceled", ses_message_id: null, last_error: "Canceled by global Block List domain rule." });
        continue;
      }
      const subject = payload.subject?.startsWith("[SENDER COPY]") ? `[SENDER COPY] ${email.subject}` : payload.subject ?? email.subject;
      assertSendReadySubject(subject);
      const itemCompiled = subject === email.subject ? compiled : compileTemplate({ subject, html: payload.html ?? email.html, text: payload.text ?? email.text, appBaseUrl });
      deliverable.push({ item, payload, compiled: itemCompiled, data: recipientData(payload, item.id) });
    } catch (error) {
      invalid.push({ id: item.id, outcome: "dead", ses_message_id: null, last_error: error instanceof Error ? error.message : String(error) });
    }
  }

  const claimResults = [...invalid];
  if (deliverable.length) {
    const groups = new Map();
    for (const entry of deliverable) {
      const key = JSON.stringify(entry.compiled.content);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += sendRequestSize) {
        const requestEntries = group.slice(offset, offset + sendRequestSize);
        const first = requestEntries[0].compiled;
        const response = await ses.send(new SendBulkEmailCommand({
          FromEmailAddress: email.from_address,
          ReplyToAddresses: email.reply_to ? [email.reply_to] : undefined,
          ConfigurationSetName: configurationSet || undefined,
          DefaultContent: { Template: { TemplateContent: first.content, TemplateData: "{}", Headers: headers } },
          BulkEmailEntries: requestEntries.map(({ item, payload, compiled: itemCompiled, data }) => ({
            Destination: { ToAddresses: [payload.to] },
            ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: JSON.stringify(itemCompiled.replacementData(data)) } },
            ReplacementTags: [
              { Name: "queue_id", Value: item.id },
              { Name: "campaign_id", Value: emailId },
            ],
          })),
        }));
        const results = requestEntries.map(({ item }, index) => classifySesResult(response.BulkEmailEntryResults?.[index], item));
        claimResults.push(...results);
        requestCount += 1;
        console.log(`request=${requestCount} recipients=${requestEntries.length}`);
        await sleep(sendRequestIntervalMs);
      }
    }
  }

  let checkpointed = false;
  let checkpointError = "unknown checkpoint error";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const { data: applied, error: finalizeError } = await supabase.rpc("finalize_ses_bulk_queue_batch", {
      p_email_id: emailId,
      p_worker_id: workerId,
      p_results: claimResults,
      p_now: new Date().toISOString(),
    });
    if (!finalizeError && applied === claimResults.length) {
      checkpointed = true;
      break;
    }

    checkpointError = finalizeError?.message ?? `${applied}/${claimResults.length} applied`;
    const expectedById = new Map(claimResults.map((result) => [result.id, result]));
    const { data: persistedRows, error: persistedError } = await supabase
      .from("mail_queue")
      .select("id, status, ses_message_id")
      .eq("email_id", emailId)
      .in("id", [...expectedById.keys()]);
    const matchesCheckpoint = !persistedError && persistedRows?.length === claimResults.length && persistedRows.every((row) => {
      const expected = expectedById.get(row.id);
      const expectedStatus = expected?.outcome === "retry" ? "pending" : expected?.outcome;
      return row.status === expectedStatus && (expectedStatus !== "succeeded" || row.ses_message_id === expected.ses_message_id);
    });
    if (matchesCheckpoint) {
      checkpointed = true;
      console.warn(`checkpoint response was ambiguous but all ${claimResults.length} outcomes are durable`);
      break;
    }

    if (attempt < 8) {
      const retryDelayMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      console.warn(`checkpoint attempt ${attempt}/8 failed (${checkpointError}); retrying in ${retryDelayMs}ms`);
      await sleep(retryDelayMs);
    }
  }
  if (!checkpointed) {
    throw new Error(`SES claim checkpoint was incomplete after retries: ${checkpointError}. Stop and reconcile before retrying.`);
  }

  const claimAccepted = claimResults.filter((result) => result.outcome === "succeeded").length;
  const claimFailed = claimResults.length - claimAccepted;
  accepted += claimAccepted;
  failed += claimFailed;
  remainingQuota -= claimAccepted;
  console.log(`claim=${items.length} accepted=${claimAccepted} failed=${claimFailed} total_accepted=${accepted}`);
  if (
    recoveryPauseEvery > 0
    && recoveryPauseMs > 0
    && accepted >= nextRecoveryPauseAt
    && candidates.length === limit
    && remainingQuota > 0
  ) {
    console.log(`recovery_pause=${recoveryPauseMs}ms accepted=${accepted}`);
    await sleep(recoveryPauseMs);
    while (nextRecoveryPauseAt <= accepted) nextRecoveryPauseAt += recoveryPauseEvery;
  }
}

const { data: finalRows, error: finalError } = await supabase.rpc("get_queue_campaign_summaries", { p_email_ids: [emailId], p_now: new Date().toISOString() });
if (finalError) throw new Error(`Unable to load final summary: ${finalError.message}`);
const active = (finalRows ?? []).reduce((count, row) => count + Number(row.pending_due) + Number(row.pending_held) + Number(row.processing), 0);
if (active === 0) {
  const { error } = await supabase.from("emails").update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", emailId).eq("status", "sending");
  if (error) throw new Error(`Campaign drained but final status update failed: ${error.message}`);
}
console.log(JSON.stringify({ complete: active === 0, accepted, failed, activeRemaining: active, workerId }, null, 2));
