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

const requestedBatchSize = Number(process.env.SES_BULK_BATCH_SIZE ?? 50);
const batchSize = Math.max(1, Math.min(50, requestedBatchSize, Math.floor(maxRate * 0.9), quotaRemaining));
const workerId = `ses-bulk:${process.env.GITHUB_RUN_ID ?? "local"}:${crypto.randomUUID()}`;
const configurationSet = process.env.AWS_SES_CONFIGURATION_SET?.trim();
const headers = email.reply_to ? [{ Name: "List-Unsubscribe", Value: `<mailto:${email.reply_to}?subject=Unsubscribe>` }] : [];

const { error: activateError } = await supabase.from("emails").update({ status: "sending", updated_at: new Date().toISOString() }).eq("id", emailId).in("status", ["queued", "sending"]);
if (activateError) throw new Error(`Unable to activate campaign: ${activateError.message}`);

let accepted = 0;
let failed = 0;
let remainingQuota = quotaRemaining;
let requestCount = 0;
while (remainingQuota > 0) {
  const limit = Math.min(batchSize, remainingQuota);
  const now = new Date().toISOString();
  const { data: items, error: claimError } = await supabase.rpc("claim_ses_bulk_queue_batch", {
    p_email_id: emailId,
    p_worker_id: workerId,
    p_limit: limit,
    p_now: now,
  });
  if (claimError) throw new Error(`Unable to claim queue batch: ${claimError.message}`);
  if (!items?.length) break;

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

  if (invalid.length) {
    const { data: applied, error } = await supabase.rpc("finalize_ses_bulk_queue_batch", { p_email_id: emailId, p_worker_id: workerId, p_results: invalid, p_now: new Date().toISOString() });
    if (error || applied !== invalid.length) throw new Error(`Unable to finalize invalid rows: ${error?.message ?? `${applied}/${invalid.length} applied`}`);
    failed += invalid.length;
  }

  if (deliverable.length) {
    const groups = new Map();
    for (const entry of deliverable) {
      const key = JSON.stringify(entry.compiled.content);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      const first = group[0].compiled;
    const response = await ses.send(new SendBulkEmailCommand({
      FromEmailAddress: email.from_address,
      ReplyToAddresses: email.reply_to ? [email.reply_to] : undefined,
      ConfigurationSetName: configurationSet || undefined,
      DefaultContent: { Template: { TemplateContent: first.content, TemplateData: "{}", Headers: headers } },
      BulkEmailEntries: group.map(({ item, payload, compiled: itemCompiled, data }) => ({
        Destination: { ToAddresses: [payload.to] },
        ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: JSON.stringify(itemCompiled.replacementData(data)) } },
        ReplacementTags: [
          { Name: "queue_id", Value: item.id },
          { Name: "campaign_id", Value: emailId },
        ],
      })),
    }));
    const results = group.map(({ item }, index) => classifySesResult(response.BulkEmailEntryResults?.[index], item));
    const { data: applied, error } = await supabase.rpc("finalize_ses_bulk_queue_batch", { p_email_id: emailId, p_worker_id: workerId, p_results: results, p_now: new Date().toISOString() });
    if (error || applied !== results.length) throw new Error(`SES accepted a batch but its checkpoint was incomplete: ${error?.message ?? `${applied}/${results.length} applied`}. Stop and reconcile before retrying.`);
    const batchAccepted = results.filter((result) => result.outcome === "succeeded").length;
    accepted += batchAccepted;
    failed += results.length - batchAccepted;
    remainingQuota -= batchAccepted;
    requestCount += 1;
    console.log(`batch=${requestCount} claimed=${items.length} accepted=${batchAccepted} failed=${results.length - batchAccepted} total_accepted=${accepted}`);
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  // SendBulkEmail is an SES API action with a one-request-per-second control-plane limit.
}

const { data: finalRows, error: finalError } = await supabase.rpc("get_queue_campaign_summaries", { p_email_ids: [emailId], p_now: new Date().toISOString() });
if (finalError) throw new Error(`Unable to load final summary: ${finalError.message}`);
const active = (finalRows ?? []).reduce((count, row) => count + Number(row.pending_due) + Number(row.pending_held) + Number(row.processing), 0);
if (active === 0) {
  const { error } = await supabase.from("emails").update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", emailId).eq("status", "sending");
  if (error) throw new Error(`Campaign drained but final status update failed: ${error.message}`);
}
console.log(JSON.stringify({ complete: active === 0, accepted, failed, activeRemaining: active, workerId }, null, 2));
