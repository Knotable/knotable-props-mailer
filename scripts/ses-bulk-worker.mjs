#!/usr/bin/env node
// Durable SES bulk sender for campaigns materialized in Supabase mail_queue.
//
// Modes:
//   autopilot (default) — drain every campaign the app has approved
//                         (app_settings "send_autopilot:<emailId>"), oldest
//                         approval first, one at a time, until done, the SES
//                         rolling quota is exhausted, or the runner budget ends.
//                         The scheduled workflow re-enters this mode, so quota
//                         windows and the six-hour Actions ceiling are survived
//                         without a human.
//   send                — approve and drain one campaign (--email-id plus
//                         --confirmation send:<emailId>).
//   dry-run             — read-only readiness report for one campaign.
//
// Logs are public (the repository is public): never print recipient addresses.
import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { SESv2Client, GetAccountCommand, SendBulkEmailCommand, SendEmailCommand } from "@aws-sdk/client-sesv2";
import pg from "pg";
import {
  assertSendReadySubject,
  classifySesResult,
  compileTemplate,
  isBlockedRecipient,
  recipientData,
  sesEntrySignal,
} from "./lib/ses-bulk-worker-core.mjs";
import {
  ACTIVE_STATES,
  AMBIGUOUS_CLAIM_PREFIX,
  AUTOPILOT_KEY_PREFIX,
  WORKER_LEASE_KEY,
  autopilotKey,
  availableQuota,
  campaignContentDigest,
  classifySendException,
  createBackoff,
  createPacer,
  effectiveRate,
  emailIdFromKey,
  estimateEtaSeconds,
  evaluateDeliverability,
  formatDuration,
  lateSuppressedIds,
  orderDueRecords,
  parseSendWindow,
  sendWindowStatus,
  runUrlFromEnv,
} from "./lib/autopilot-core.mjs";
import { buildMemberQueueRow, buildSenderCopyQueueRow, extractEmailAddress } from "./lib/queue-rows.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const conciseError = (error) => String(error?.message ?? error ?? "unknown error").replace(/\s+/g, " ").slice(0, 240);
const nowIso = () => new Date().toISOString();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOLD_FLOOR = "2999-12-31T00:00:00.000Z";

const mode = args.get("--mode") || "autopilot";
const emailIdArg = args.get("--email-id") || "";
const confirmation = args.get("--confirmation") ?? "";
if (!["dry-run", "send", "autopilot"].includes(mode)) throw new Error("--mode must be autopilot, send, or dry-run");
if (emailIdArg && !uuidPattern.test(emailIdArg)) throw new Error("--email-id must be a UUID");
if (mode !== "autopilot" && !emailIdArg) throw new Error(`--email-id is required for ${mode}`);

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== "" && process.env[name] !== undefined ? value : fallback;
};
const required = (name, fallback) => {
  const value = process.env[name] || (fallback ? process.env[fallback] : undefined);
  if (!value) throw new Error(`Missing ${name}${fallback ? ` (or ${fallback})` : ""}`);
  return value;
};

const config = {
  maxRuntimeMs: numberEnv("SES_WORKER_MAX_RUNTIME_MINUTES", 330) * 60_000,
  quotaReserve: Math.max(0, numberEnv("SES_QUOTA_RESERVE", 500)),
  staleClaimMs: Math.max(1, numberEnv("SES_STALE_CLAIM_MINUTES", 10)) * 60_000,
  quotaRecheckMs: Math.max(1, numberEnv("SES_QUOTA_RECHECK_MINUTES", 15)) * 60_000,
  requestedRate: numberEnv("SES_BULK_MAX_RECIPIENTS_PER_SECOND", 13),
  claimSize: Math.max(1, Math.min(50, numberEnv("SES_BULK_CLAIM_SIZE", 50))),
  recoveryPauseEvery: Math.max(0, numberEnv("SES_BULK_RECOVERY_PAUSE_EVERY", 0)),
  recoveryPauseMs: Math.max(0, numberEnv("SES_BULK_RECOVERY_PAUSE_MS", 0)),
  heartbeatMs: 15_000,
  quotaRefreshMs: 120_000,
  leaseTtlMs: 3 * 60_000,
  heartbeatStaleMs: 3 * 60_000,
  maxConsecutiveErrors: 5,
  canaryRecipients: Math.max(0, numberEnv("SES_CANARY_RECIPIENTS", 300)),
  canaryWaitMs: Math.max(0, numberEnv("SES_CANARY_WAIT_SECONDS", 180)) * 1_000,
  breakerCheckMs: Math.max(1, numberEnv("SES_BREAKER_CHECK_SECONDS", 120)) * 1_000,
  breaker: {
    minSample: Math.max(1, numberEnv("SES_BREAKER_MIN_SAMPLE", 300)),
    maxHardBounceRate: numberEnv("SES_BREAKER_MAX_HARD_BOUNCE_RATE", 0.08),
    maxComplaintRate: numberEnv("SES_BREAKER_MAX_COMPLAINT_RATE", 0.003),
  },
  sendWindow: parseSendWindow(process.env.SES_SEND_WINDOW),
  blindAfterAccepted: 1_000,
  operatorEmail: process.env.SES_OPERATOR_EMAIL || "a@sarva.co",
  notifyFrom: process.env.SES_NOTIFY_FROM || "",
};

const startedAtMs = Date.now();
const deadlineMs = startedAtMs + config.maxRuntimeMs;
const runUrl = runUrlFromEnv();
const workerId = `ses-bulk:${process.env.GITHUB_RUN_ID ?? "local"}:${crypto.randomUUID()}`;
const appBaseUrl = required("APP_BASE_URL");
const supabase = createClient(required("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { Pool } = pg;
const dbPool = process.env.SUPABASE_DB_CONNECTION
  ? new Pool({
      connectionString: process.env.SUPABASE_DB_CONNECTION,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 30_000,
      idleTimeoutMillis: 30_000,
      query_timeout: 60_000,
      statement_timeout: 60_000,
    })
  : null;
let sesClient;
const ses = () => (sesClient ??= new SESv2Client({ region: required("AWS_REGION"), maxAttempts: 1 }));
const configurationSet = process.env.AWS_SES_CONFIGURATION_SET?.trim() || undefined;

function summaryLine(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  } catch {
    // The step summary is cosmetic.
  }
}

async function retry(label, operation, maxAttempts = 8, maxDelayMs = 60_000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = Math.min(maxDelayMs, 2_000 * 2 ** (attempt - 1));
        console.warn(`${label} attempt ${attempt}/${maxAttempts} failed (${conciseError(error)}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

const unwrap = (label) => async (promise) => {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
};

// ── Queue data access (pg when SUPABASE_DB_CONNECTION is set, else PostgREST) ──

const queue = {
  // Two index range scans on (email_id, status, available_at): due rows first,
  // then held rows. Retry-delayed rows (future available_at below the hold
  // floor) are skipped until due. Never scans already-sent rows.
  async selectCandidates(emailId, limit) {
    const now = nowIso();
    if (dbPool) {
      const due = await retry("select due batch", () => dbPool.query(
        "select id from public.mail_queue where email_id = $1 and status = 'pending' and available_at <= $2 order by available_at asc limit $3",
        [emailId, now, limit],
      ));
      if (due.rows.length >= limit) return due.rows.map((row) => row.id);
      const held = await retry("select held batch", () => dbPool.query(
        "select id from public.mail_queue where email_id = $1 and status = 'pending' and available_at >= $2 order by available_at asc limit $3",
        [emailId, HOLD_FLOOR, limit - due.rows.length],
      ));
      const found = [...due.rows, ...held.rows];
      if (found.length >= limit) return found.map((row) => row.id);
      const undated = await retry("select undated batch", () => dbPool.query(
        "select id from public.mail_queue where email_id = $1 and status = 'pending' and available_at is null limit $2",
        [emailId, limit - found.length],
      ));
      return [...found, ...undated.rows].map((row) => row.id);
    }
    const due = await retry("select due batch", () => unwrap("select due batch")(
      supabase.from("mail_queue").select("id").eq("email_id", emailId).eq("status", "pending")
        .lte("available_at", now).order("available_at", { ascending: true }).limit(limit),
    ));
    if (due.length >= limit) return due.map((row) => row.id);
    const held = await retry("select held batch", () => unwrap("select held batch")(
      supabase.from("mail_queue").select("id").eq("email_id", emailId).eq("status", "pending")
        .gte("available_at", HOLD_FLOOR).order("available_at", { ascending: true }).limit(limit - due.length),
    ));
    const found = [...due, ...held];
    if (found.length >= limit) return found.map((row) => row.id);
    // available_at is nullable; such rows are neither due nor held but must still send.
    const undated = await retry("select undated batch", () => unwrap("select undated batch")(
      supabase.from("mail_queue").select("id").eq("email_id", emailId).eq("status", "pending")
        .is("available_at", null).limit(limit - found.length),
    ));
    return [...found, ...undated].map((row) => row.id);
  },

  async claim(emailId, ids) {
    const now = nowIso();
    if (dbPool) {
      const result = await dbPool.query(
        `update public.mail_queue
         set status = 'processing', locked_at = $3, last_heartbeat = $3, correlation_id = $4, updated_at = $3
         where email_id = $1 and status = 'pending' and id = any($2::uuid[])
         returning id, payload, list_id, attempts, max_attempts`,
        [emailId, ids, now, workerId],
      );
      return result.rows;
    }
    return unwrap("claim batch")(
      supabase.from("mail_queue")
        .update({ status: "processing", locked_at: now, last_heartbeat: now, correlation_id: workerId, updated_at: now })
        .eq("email_id", emailId).eq("status", "pending").in("id", ids)
        .select("id, payload, list_id, attempts, max_attempts"),
    );
  },

  async claimedByUs(emailId, ids) {
    if (dbPool) {
      const result = await dbPool.query(
        `select id, payload, list_id, attempts, max_attempts from public.mail_queue
         where email_id = $1 and status = 'processing' and correlation_id = $2 and id = any($3::uuid[])`,
        [emailId, workerId, ids],
      );
      return result.rows;
    }
    return unwrap("recover claim")(
      supabase.from("mail_queue").select("id, payload, list_id, attempts, max_attempts")
        .eq("email_id", emailId).eq("status", "processing").eq("correlation_id", workerId).in("id", ids),
    );
  },

  async finalize(emailId, results) {
    const now = nowIso();
    if (dbPool) {
      const result = await dbPool.query(
        "select public.finalize_ses_bulk_queue_batch($1::uuid, $2::text, $3::jsonb, $4::timestamptz) as applied",
        [emailId, workerId, JSON.stringify(results), now],
      );
      return Number(result.rows[0]?.applied ?? 0);
    }
    const data = await unwrap("finalize batch")(supabase.rpc("finalize_ses_bulk_queue_batch", {
      p_email_id: emailId, p_worker_id: workerId, p_results: results, p_now: now,
    }));
    return Number(data ?? 0);
  },

  async outcomes(emailId, ids) {
    if (dbPool) {
      const result = await dbPool.query(
        "select id, status, ses_message_id from public.mail_queue where email_id = $1 and id = any($2::uuid[])",
        [emailId, ids],
      );
      return result.rows;
    }
    return unwrap("read outcomes")(
      supabase.from("mail_queue").select("id, status, ses_message_id").eq("email_id", emailId).in("id", ids),
    );
  },
};

async function claimBatch(emailId, limit) {
  const started = Date.now();
  const ids = await queue.selectCandidates(emailId, limit);
  if (!ids.length) return { items: [], latencyMs: Date.now() - started, retried: false };
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      // UPDATE ... RETURNING is authoritative: the returned rows are exactly the
      // rows this worker now owns. Fewer than selected means the rest were
      // canceled or changed in between, which is fine.
      const items = await queue.claim(emailId, ids);
      return { items, latencyMs: Date.now() - started, retried: attempt > 1, raced: items.length === 0 };
    } catch (error) {
      lastError = error;
    }
    // No trustworthy response: read back what this worker owns before any send.
    const recovered = await retry("recover ambiguous claim", () => queue.claimedByUs(emailId, ids), 5).catch(() => null);
    if (recovered?.length) {
      console.warn(`claim response was ambiguous; recovered ${recovered.length}/${ids.length} owned rows before SES send`);
      return { items: recovered, latencyMs: Date.now() - started, retried: true };
    }
    if (attempt < 8) {
      const delay = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      console.warn(`claim attempt ${attempt}/8 failed (${conciseError(lastError)}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`Unable to claim queue batch after retries: ${conciseError(lastError)}`);
}

async function checkpoint(emailId, results) {
  const started = Date.now();
  let lastError = "unknown checkpoint error";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const applied = await queue.finalize(emailId, results);
      if (applied === results.length) return { latencyMs: Date.now() - started, retried: attempt > 1 };
      lastError = `${applied}/${results.length} applied`;
    } catch (error) {
      lastError = conciseError(error);
    }
    const expected = new Map(results.map((result) => [result.id, result]));
    const persisted = await queue.outcomes(emailId, [...expected.keys()]).catch(() => null);
    const durable = persisted?.length === results.length && persisted.every((row) => {
      const want = expected.get(row.id);
      const wantStatus = want?.outcome === "retry" ? "pending" : want?.outcome;
      return row.status === wantStatus && (wantStatus !== "succeeded" || row.ses_message_id === want.ses_message_id);
    });
    if (durable) {
      console.warn(`checkpoint response was ambiguous but all ${results.length} outcomes are durable`);
      return { latencyMs: Date.now() - started, retried: true };
    }
    if (attempt < 8) {
      const delay = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      console.warn(`checkpoint attempt ${attempt}/8 failed (${lastError}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`SES claim checkpoint was incomplete after retries: ${lastError}. Stale claims will be reconciled on the next run.`);
}

// ── Autopilot control records (app_settings key/value) ──

async function readRecord(emailId) {
  const { data, error } = await supabase.from("app_settings").select("value").eq("key", autopilotKey(emailId)).maybeSingle();
  if (error) throw new Error(`read autopilot record: ${error.message}`);
  return data?.value ?? null;
}

async function listRecords() {
  const data = await retry("list autopilot records", () => unwrap("list autopilot records")(
    supabase.from("app_settings").select("key, value").like("key", `${AUTOPILOT_KEY_PREFIX}%`),
  ), 4);
  return (data ?? [])
    .map((row) => ({ ...(row.value ?? {}), emailId: row.value?.emailId ?? emailIdFromKey(row.key) }))
    .filter((record) => record.emailId && uuidPattern.test(record.emailId));
}

// Conditional write: only while this exact approval is still active. Returns
// false when the operator paused, canceled, or re-approved in the meantime.
async function patchRecord(record, patch) {
  const current = await readRecord(record.emailId).catch(() => undefined);
  if (current === undefined) return null;
  if (!current || current.approvalId !== record.approvalId || !ACTIVE_STATES.includes(current.state)) return false;
  const next = { ...current, ...patch, updatedAt: nowIso() };
  const { data, error } = await supabase
    .from("app_settings")
    .update({ value: next, updated_at: next.updatedAt })
    .eq("key", autopilotKey(record.emailId))
    .eq("value->>approvalId", record.approvalId)
    .in("value->>state", ACTIVE_STATES)
    .select("key");
  if (error) {
    console.warn(`autopilot record write failed (${conciseError(error)})`);
    return null;
  }
  if (!data?.length) return false;
  Object.assign(record, next);
  return true;
}

async function writeNewApproval(record) {
  const value = { ...record, updatedAt: nowIso() };
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: autopilotKey(record.emailId), value, updated_at: value.updatedAt }, { onConflict: "key" });
  if (error) throw new Error(`write autopilot approval: ${error.message}`);
  return value;
}

// ── Worker lease: belt and braces on top of the workflow concurrency group ──

let leaseToken = null;
async function acquireLease() {
  const token = workerId;
  const value = { token, expiresAt: new Date(Date.now() + config.leaseTtlMs).toISOString(), runUrl, acquiredAt: nowIso() };
  const { data: row, error } = await supabase.from("app_settings").select("value").eq("key", WORKER_LEASE_KEY).maybeSingle();
  if (error) throw new Error(`read worker lease: ${error.message}`);
  if (!row) {
    const { error: insertError } = await supabase.from("app_settings").insert({ key: WORKER_LEASE_KEY, value, updated_at: value.acquiredAt });
    if (insertError) return { ok: false, holder: "a worker that just started" };
    leaseToken = token;
    return { ok: true };
  }
  const current = row.value ?? {};
  if (current.token && current.token !== token && Date.parse(current.expiresAt ?? "") > Date.now()) {
    return { ok: false, holder: current.runUrl ?? current.token };
  }
  let update = supabase.from("app_settings").update({ value, updated_at: value.acquiredAt }).eq("key", WORKER_LEASE_KEY);
  update = current.token ? update.eq("value->>token", current.token) : update;
  const { data, error: updateError } = await update.select("key");
  if (updateError || !data?.length) return { ok: false, holder: "a concurrent worker" };
  leaseToken = token;
  return { ok: true };
}

async function renewLease() {
  if (!leaseToken) return;
  const value = { token: leaseToken, expiresAt: new Date(Date.now() + config.leaseTtlMs).toISOString(), runUrl, renewedAt: nowIso() };
  const { error } = await supabase.from("app_settings").update({ value, updated_at: value.renewedAt })
    .eq("key", WORKER_LEASE_KEY).eq("value->>token", leaseToken);
  if (error) console.warn(`lease renewal failed (${conciseError(error)})`);
}

async function releaseLease() {
  if (!leaseToken) return;
  const { error } = await supabase.from("app_settings")
    .update({ value: { token: null, releasedAt: nowIso(), runUrl }, updated_at: nowIso() })
    .eq("key", WORKER_LEASE_KEY).eq("value->>token", leaseToken);
  if (error) console.warn(`lease release failed (${conciseError(error)})`);
  leaseToken = null;
}

// ── SES helpers ──

async function sesQuota() {
  const account = await retry("SES GetAccount", () => ses().send(new GetAccountCommand({})), 4, 10_000);
  await sleep(1_100);
  return {
    maxSendRate: Number(account.SendQuota?.MaxSendRate ?? 1),
    max24HourSend: Number(account.SendQuota?.Max24HourSend ?? 0),
    sentLast24Hours: Number(account.SendQuota?.SentLast24Hours ?? 0),
    productionAccess: account.ProductionAccessEnabled !== false,
    sendingEnabled: account.SendingEnabled !== false,
  };
}

async function notifyOperator(email, subject, lines) {
  const from = config.notifyFrom || email?.from_address;
  if (!from || !config.operatorEmail) return;
  const monitorUrl = email?.id ? `${appBaseUrl.replace(/\/+$/, "")}/email/monitor?emailId=${email.id}` : appBaseUrl;
  const body = [...lines, "", `Monitor: ${monitorUrl}`, runUrl ? `Worker run: ${runUrl}` : null, "", "Sent by Props Mailer autopilot."]
    .filter((line) => line !== null)
    .join("\n");
  try {
    await ses().send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [config.operatorEmail] },
      Content: { Simple: { Subject: { Data: `[Props Mailer] ${subject}`.slice(0, 200) }, Body: { Text: { Data: body } } } },
    }));
  } catch (error) {
    console.warn(`operator notice failed (${conciseError(error)})`);
  }
}

// ── Campaign helpers ──

async function loadEmail(emailId) {
  const { data, error } = await supabase
    .from("emails")
    .select("id, from_address, reply_to, subject, html, text, status, tags, campaigns")
    .eq("id", emailId)
    .maybeSingle();
  if (error) throw new Error(`load campaign: ${error.message}`);
  return data;
}

async function loadSummary(emailId) {
  const rows = await retry("queue summary", () => unwrap("queue summary")(
    supabase.rpc("get_queue_campaign_summaries", { p_email_ids: [emailId], p_now: nowIso() }),
  ), 5);
  return (rows ?? []).reduce((total, row) => {
    for (const key of ["pending_due", "pending_held", "processing", "succeeded", "failed", "dead", "canceled", "total"]) {
      total[key] += Number(row[key] ?? 0);
    }
    return total;
  }, { pending_due: 0, pending_held: 0, processing: 0, succeeded: 0, failed: 0, dead: 0, canceled: 0, total: 0 });
}

// Rows left in `processing` by an interrupted worker. The SES webhook flips a
// row to succeeded when SES's Send event (tagged with queue_id) arrives, so a
// row still processing after the stale window has no acceptance evidence. It
// is parked as dead with an explicit marker — never retried, because a
// duplicate email is worse than a missed one. A late Send event still upgrades
// it to succeeded.
async function reconcileStaleClaims(emailId) {
  const rows = await unwrap("stale claims")(
    supabase.from("mail_queue").select("id, locked_at").eq("email_id", emailId).eq("status", "processing")
      .order("locked_at", { ascending: true }).limit(1000),
  );
  if (!rows?.length) return { resolved: 0, waitUntil: null };
  const cutoffMs = Date.now() - config.staleClaimMs;
  const stale = rows.filter((row) => !row.locked_at || Date.parse(row.locked_at) < cutoffMs).map((row) => row.id);
  const fresh = rows.filter((row) => row.locked_at && Date.parse(row.locked_at) >= cutoffMs);
  let resolved = 0;
  for (let offset = 0; offset < stale.length; offset += 200) {
    const ids = stale.slice(offset, offset + 200);
    const updated = await unwrap("park stale claims")(
      supabase.from("mail_queue")
        .update({
          status: "dead",
          locked_at: null,
          last_error: `${AMBIGUOUS_CLAIM_PREFIX} worker interrupted before SES acceptance was recorded; not retried to prevent duplicate delivery`,
          updated_at: nowIso(),
        })
        .eq("email_id", emailId).eq("status", "processing").in("id", ids)
        .lt("locked_at", new Date(cutoffMs).toISOString())
        .select("id"),
    );
    resolved += updated?.length ?? 0;
  }
  const waitUntil = fresh.length
    ? new Date(Math.min(...fresh.map((row) => Date.parse(row.locked_at))) + config.staleClaimMs + 5_000).toISOString()
    : null;
  return { resolved, waitUntil };
}

async function deliverabilityCounts(emailId) {
  const count = async (build) => {
    const { count: value, error } = await build(supabase.from("provider_events").select("id", { count: "exact", head: true }).eq("email_id", emailId));
    if (error) throw new Error(`deliverability count: ${error.message}`);
    return value ?? 0;
  };
  const [hardBounces, complaints, delivered] = await Promise.all([
    count((query) => query.eq("event_type", "bounced").eq("payload->bounce->>bounceType", "Permanent")),
    count((query) => query.eq("event_type", "complained")),
    count((query) => query.eq("event_type", "delivered")),
  ]);
  return { hardBounces, complaints, delivered };
}

// Honors unsubscribes, bounces, complaints, and blocks that happened after
// the queue was built: those rows are canceled instead of sent.
async function findLateSuppressed(items) {
  const addresses = [...new Set(items.flatMap((item) => {
    const to = String(item.payload?.to ?? "").trim();
    return to ? [to, to.toLowerCase()] : [];
  }))];
  if (!addresses.length) return new Set();
  const inactive = await retry("late suppression lookup", () => unwrap("late suppression lookup")(
    supabase.from("list_members").select("list_id, email, status").in("email", addresses).neq("status", "active"),
  ), 4);
  return lateSuppressedIds(items, inactive ?? []);
}

async function earliestRetryAt(emailId) {
  const { data } = await supabase.from("mail_queue").select("available_at").eq("email_id", emailId).eq("status", "pending")
    .gt("available_at", nowIso()).lt("available_at", HOLD_FLOOR).order("available_at", { ascending: true }).limit(1).maybeSingle();
  return data?.available_at ?? null;
}

function buildDeliverable(email, compiled, items) {
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
      const itemCompiled = subject === email.subject
        ? compiled
        : compileTemplate({ subject, html: payload.html ?? email.html, text: payload.text ?? email.text, appBaseUrl });
      deliverable.push({ item, payload, compiled: itemCompiled, data: recipientData(payload, item.id) });
    } catch (error) {
      invalid.push({ id: item.id, outcome: "dead", ses_message_id: null, last_error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { invalid, deliverable };
}

async function sendGroup(email, entries, pacer, headers) {
  const first = entries[0].compiled;
  const command = new SendBulkEmailCommand({
    FromEmailAddress: email.from_address,
    ReplyToAddresses: email.reply_to ? [email.reply_to] : undefined,
    ConfigurationSetName: configurationSet,
    DefaultContent: { Template: { TemplateContent: first.content, TemplateData: "{}", Headers: headers } },
    BulkEmailEntries: entries.map(({ item, payload, compiled, data }) => ({
      Destination: { ToAddresses: [payload.to] },
      ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: JSON.stringify(compiled.replacementData(data)) } },
      ReplacementTags: [
        { Name: "queue_id", Value: item.id },
        { Name: "campaign_id", Value: email.id },
      ],
    })),
  });
  for (let attempt = 0; ; attempt += 1) {
    await pacer.take(entries.length);
    try {
      const response = await ses().send(command);
      const results = entries.map(({ item }, index) => classifySesResult(response.BulkEmailEntryResults?.[index], item));
      const signals = new Set((response.BulkEmailEntryResults ?? []).map(sesEntrySignal).filter(Boolean));
      return { results, signal: signals.has("paused") ? "paused" : signals.has("quota") ? "quota" : signals.has("throttle") ? "throttle" : null };
    } catch (error) {
      const verdict = classifySendException(error);
      if (verdict.kind === "retryable" && attempt < 5) {
        const delay = Math.min(30_000, 1_000 * 2 ** attempt);
        console.warn(`SES request rejected (${verdict.message.slice(0, 160)}); retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      const outcome = verdict.kind === "ambiguous" ? "dead" : "retry";
      const prefix = verdict.kind === "ambiguous" ? `${AMBIGUOUS_CLAIM_PREFIX} ` : "";
      console.warn(`SES request failed (${verdict.kind}): ${verdict.message.slice(0, 200)}`);
      return {
        results: entries.map(({ item }) => ({ id: item.id, outcome, ses_message_id: null, last_error: `${prefix}${verdict.message}`.slice(0, 500) })),
        signal: verdict.kind === "quota" ? "quota" : verdict.kind === "rejected" ? "rejected" : verdict.kind === "retryable" ? "throttle" : null,
        ambiguous: verdict.kind === "ambiguous",
      };
    }
  }
}

async function finalizeComplete(email, record, reason) {
  const summary = await loadSummary(email.id);
  const active = summary.pending_due + summary.pending_held + summary.processing;
  if (active > 0) return false;
  await supabase.from("emails").update({ status: "sent", sent_at: nowIso(), updated_at: nowIso() }).eq("id", email.id).eq("status", "sending");
  const failures = summary.failed + summary.dead;
  const message = `${summary.succeeded.toLocaleString()} accepted by SES${failures ? `, ${failures.toLocaleString()} permanently failed` : ""}${summary.canceled ? `, ${summary.canceled.toLocaleString()} canceled` : ""}.`;
  // The active -> complete transition happens once, so the notice does too.
  const wrote = record ? await patchRecord(record, {
    state: "complete",
    completedAt: nowIso(),
    heartbeatAt: nowIso(),
    nextCheckAt: null,
    message,
    totals: summary,
  }) : null;
  console.log(`campaign ${email.id} complete: ${message}`);
  summaryLine(`- DONE **${email.subject}** — ${message}`);
  if (wrote === true) {
    await notifyOperator(email, `Sent: ${email.subject}`, [
      `Campaign complete (${reason}).`,
      `Accepted by SES: ${summary.succeeded.toLocaleString()}`,
      `Permanent failures: ${failures.toLocaleString()}`,
      `Canceled: ${summary.canceled.toLocaleString()}`,
      `Campaign: ${email.id}`,
      "SES acceptance is not inbox delivery; check Analytics for delivered/bounced/opened.",
    ]);
  }
  return true;
}

async function block(email, record, reason) {
  console.warn(`campaign ${record.emailId} blocked: ${reason}`);
  summaryLine(`- BLOCKED **${email?.subject ?? record.emailId}** blocked — ${reason}`);
  const wrote = await patchRecord(record, { state: "blocked", blockedAt: nowIso(), message: reason, nextCheckAt: null });
  if (wrote !== false) {
    await notifyOperator(email, `Blocked: ${email?.subject ?? record.emailId}`, [
      "Autopilot stopped this campaign and will not resume it until it is re-approved on the Queue page.",
      `Reason: ${reason}`,
      `Campaign: ${record.emailId}`,
    ]);
  }
  return "blocked";
}

// Builds held mail_queue rows for the approved lists in the cloud, so queueing
// a large list never depends on a browser tab paging through it. Keyset
// pagination on (list_id, email) keeps every page an index range scan.
async function prepareQueue(record, email) {
  const emailId = email.id;
  const listIds = (record.audience?.listIds ?? []).filter((id) => uuidPattern.test(id));
  if (!listIds.length) return { stop: await block(email, record, "Cloud preparation had no lists to read.") };
  const excluded = new Set((record.audience?.excludeRecipients ?? []).map((value) => String(value).trim().toLowerCase()));
  const campaignLabel = `${emailId}:${nowIso().slice(0, 10)}`;
  const canceledSample = await unwrap("canceled sample")(
    supabase.from("mail_queue").select("id").eq("email_id", emailId).eq("status", "canceled").limit(1),
  );
  const reviveCanceled = Boolean(canceledSample?.length);
  let prepared = 0;
  let lastBeat = 0;

  const upsertRows = async (rows) => {
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      await retry("upsert queue rows", () => unwrap("upsert queue rows")(
        supabase.from("mail_queue").upsert(chunk, { onConflict: "dedupe_hash", ignoreDuplicates: true }),
      ), 6);
      if (!reviveCanceled) continue;
      // Recipients canceled by an earlier Edit/Unqueue keep their dedupe hash;
      // revive them. Sent and dead rows are never touched.
      for (let index = 0; index < chunk.length; index += 100) {
        await retry("revive canceled rows", () => unwrap("revive canceled rows")(
          supabase.from("mail_queue")
            .update({ status: "pending", available_at: chunk[0].available_at, locked_at: null, last_error: null, attempts: 0, updated_at: nowIso() })
            .eq("email_id", emailId).eq("status", "canceled")
            .in("dedupe_hash", chunk.slice(index, index + 100).map((row) => row.dedupe_hash)),
        ), 6);
      }
    }
  };

  for (const listId of listIds) {
    let lastEmail = null;
    for (;;) {
      let query = supabase.from("list_members").select("email, metadata").eq("list_id", listId).eq("status", "active")
        .order("email", { ascending: true }).limit(1_000);
      if (lastEmail !== null) query = query.gt("email", lastEmail);
      const page = await retry("read list members", () => unwrap("read list members")(query), 6);
      if (!page?.length) break;
      lastEmail = page[page.length - 1].email;
      const rows = page
        .filter((member) => !excluded.has(String(member.email).trim().toLowerCase()) && !isBlockedRecipient(member.email))
        .map((member) => buildMemberQueueRow({ emailId, listId, email, member, campaignLabel }));
      await upsertRows(rows);
      prepared += rows.length;
      if (Date.now() - lastBeat > 5_000) {
        lastBeat = Date.now();
        await renewLease();
        const wrote = await patchRecord(record, {
          heartbeatAt: nowIso(),
          run: { url: runUrl, workerId, startedAt: new Date(startedAtMs).toISOString() },
          progress: { prepared },
          message: `Preparing recipients: ${prepared.toLocaleString()} of up to ${Number(record.approvedMaxRecipients ?? 0).toLocaleString()} queued.`,
        });
        if (wrote === false) return { stop: "paused" };
      }
      if (page.length < 1_000) break;
    }
  }

  const senderEmail = extractEmailAddress(email.from_address);
  if (senderEmail && !isBlockedRecipient(senderEmail)) {
    await upsertRows([buildSenderCopyQueueRow({ emailId, email, senderEmail, campaignLabel })]);
  }

  const summary = await loadSummary(emailId);
  const unsent = summary.pending_due + summary.pending_held;
  if (record.approvedMaxRecipients && unsent > Number(record.approvedMaxRecipients)) {
    return { stop: await block(email, record, `Preparation produced ${unsent.toLocaleString()} unsent recipients, more than the ${Number(record.approvedMaxRecipients).toLocaleString()} approved.`) };
  }
  console.log(`campaign ${emailId} prepared: ${unsent} unsent recipients`);
  summaryLine(`- PREPARED **${email.subject}** — ${unsent.toLocaleString()} unsent recipients queued`);

  if (!record.sendAfterPrepare) {
    await supabase.from("emails").update({ status: "queued", updated_at: nowIso() }).eq("id", emailId).in("status", ["draft", "queued"]);
    await patchRecord(record, {
      state: "prepared",
      approvedRecipients: unsent,
      heartbeatAt: nowIso(),
      progress: { prepared },
      message: `Prepared ${unsent.toLocaleString()} recipients. Review, then press Send on the Queue page.`,
    });
    return { stop: "prepared" };
  }
  const { error } = await supabase.from("emails").update({ status: "sending", updated_at: nowIso() }).eq("id", emailId).in("status", ["draft", "queued", "sending"]);
  if (error) throw new Error(`activate campaign after preparation: ${error.message}`);
  const wrote = await patchRecord(record, {
    state: "approved",
    approvedRecipients: unsent,
    heartbeatAt: nowIso(),
    message: `Prepared ${unsent.toLocaleString()} recipients; sending.`,
  });
  return wrote === false ? { stop: "paused" } : { stop: null };
}

// Drains one approved campaign. Returns the stop reason.
async function runCampaign(record) {
  const emailId = record.emailId;
  let email = await loadEmail(emailId);
  if (!email) {
    await patchRecord(record, { state: "canceled", message: "Campaign no longer exists." });
    return "skipped";
  }
  if (record.state === "preparing") {
    if (!["draft", "queued", "sending"].includes(email.status)) {
      await patchRecord(record, { state: "paused", message: `Campaign status is ${email.status}; preparation stopped.` });
      return "skipped";
    }
    if (record.contentSha256 && campaignContentDigest(email) !== record.contentSha256) {
      return block(email, record, "Subject, sender, or body changed after approval. Review and re-approve on the Queue page.");
    }
    const prepared = await prepareQueue(record, email);
    if (prepared.stop) return prepared.stop;
    email = await loadEmail(emailId);
  }
  if (email.status !== "sending") {
    if (email.status === "sent") {
      await patchRecord(record, { state: "complete", message: "Campaign was already marked sent.", completedAt: nowIso() });
    } else {
      await patchRecord(record, { state: "paused", message: `Campaign status is ${email.status}; autopilot stopped. Re-approve from the Queue page to continue.` });
    }
    return "skipped";
  }
  if (record.contentSha256 && campaignContentDigest(email) !== record.contentSha256) {
    return block(email, record, "Subject, sender, or body changed after approval. Review and re-approve on the Queue page.");
  }
  try {
    assertSendReadySubject(email.subject);
  } catch (error) {
    return block(email, record, conciseError(error));
  }

  const reconcile = await reconcileStaleClaims(emailId);
  if (reconcile.resolved) {
    summaryLine(`- WARN ${reconcile.resolved} interrupted claim(s) parked as ambiguous for **${email.subject}**`);
    await notifyOperator(email, `Reconciled interrupted batch: ${email.subject}`, [
      `${reconcile.resolved} recipient(s) were mid-send when a previous worker stopped and SES never confirmed them.`,
      "They were parked (status dead, last_error ambiguous_claim) and will NOT be retried automatically, to avoid duplicate email.",
      "If a late SES Send event arrives, the webhook upgrades them to succeeded. Everyone else continues sending.",
      `Campaign: ${emailId}`,
    ]);
  }
  if (reconcile.waitUntil) {
    await patchRecord(record, {
      state: "waiting_reconcile",
      nextCheckAt: reconcile.waitUntil,
      message: "Waiting for SES events to settle an interrupted batch before continuing.",
    });
    return "waiting";
  }

  const summary = await loadSummary(emailId);
  const remainingAtStart = summary.pending_due + summary.pending_held;
  if (remainingAtStart === 0) {
    if (await finalizeComplete(email, record, "no recipients remained")) return "complete";
  }
  if (record.approvedRecipients && remainingAtStart > Number(record.approvedRecipients) + 5) {
    return block(email, record, `Queue grew to ${remainingAtStart.toLocaleString()} unsent recipients after approval of ${Number(record.approvedRecipients).toLocaleString()}. Re-approve the new count.`);
  }

  const window = parseSendWindow(record.sendWindow) ?? config.sendWindow;
  const windowGate = async () => {
    const status = sendWindowStatus(Date.now(), window);
    if (status.open) return false;
    await patchRecord(record, {
      state: "waiting_window",
      heartbeatAt: nowIso(),
      nextCheckAt: status.nextOpenAt,
      message: `Outside the send window (${window.label}). Resumes automatically at ${status.nextOpenAt.replace("T", " ").slice(0, 16)} UTC.`,
    });
    return true;
  };
  if (await windowGate()) return "window";

  const quota = await sesQuota();
  if (!quota.sendingEnabled) return block(email, record, "SES account sending is disabled.");
  let available = availableQuota({ ...quota, reserve: config.quotaReserve });
  const minimumUseful = Math.min(remainingAtStart, config.claimSize);
  if (available < minimumUseful) {
    const nextCheckAt = new Date(Date.now() + config.quotaRecheckMs).toISOString();
    await patchRecord(record, {
      state: "waiting_quota",
      nextCheckAt,
      heartbeatAt: nowIso(),
      quota: { ...quota, available, reserve: config.quotaReserve, checkedAt: nowIso() },
      message: `SES rolling 24h quota is ${quota.sentLast24Hours.toLocaleString()}/${quota.max24HourSend.toLocaleString()} used. Resumes automatically as headroom frees (next check ${nextCheckAt.slice(11, 16)} UTC).`,
    });
    summaryLine(`- WAITING **${email.subject}** waiting for SES quota (${quota.sentLast24Hours}/${quota.max24HourSend})`);
    return "quota";
  }

  const compiled = compileTemplate({ subject: email.subject, html: email.html, text: email.text, appBaseUrl });
  const { data: sample } = await supabase.from("mail_queue").select("id, payload").eq("email_id", emailId).eq("status", "pending").limit(1).maybeSingle();
  if (sample && !sample.payload?.subject) {
    try {
      compiled.replacementData(recipientData(sample.payload, sample.id));
    } catch (error) {
      return block(email, record, `Template check failed on a sample recipient: ${conciseError(error)}`);
    }
  }

  const rate = effectiveRate({ sesMaxSendRate: quota.maxSendRate, requestedRate: record.maxRatePerSecond ?? config.requestedRate });
  const requestSize = Math.max(1, Math.min(50, Math.floor(rate)));
  const pacer = createPacer(rate);
  const backoff = createBackoff();
  const headers = email.reply_to ? [{ Name: "List-Unsubscribe", Value: `<mailto:${email.reply_to}?subject=Unsubscribe>` }] : [];
  const runStartedAt = Date.now();
  let accepted = 0;
  let failed = 0;
  let ambiguous = 0;
  let lastHeartbeat = 0;
  let lastQuotaRefresh = Date.now();
  let nextRecoveryPauseAt = config.recoveryPauseEvery;
  let stopReason = null;
  let stopDetail = "";
  let racedClaims = 0;

  console.log(JSON.stringify({ campaign: emailId, subject: email.subject, remaining: remainingAtStart, rate, requestSize, claimSize: config.claimSize, quotaAvailable: available }));
  summaryLine(`- START **${email.subject}** — ${remainingAtStart.toLocaleString()} unsent, target ${rate.toFixed(1)}/s`);

  let sentSinceBaseline = 0;
  let canaryPending = false;
  let deliverability = null;

  const heartbeat = async (extra = {}) => {
    lastHeartbeat = Date.now();
    await renewLease();
    const { data: live } = await supabase.from("emails").select("status").eq("id", emailId).maybeSingle();
    if (live && live.status !== "sending") return false;
    const elapsed = Math.max(1, (Date.now() - runStartedAt) / 1000);
    const measuredRate = accepted / elapsed;
    const remaining = Math.max(0, remainingAtStart - accepted - failed);
    const effective = measuredRate > 0.5 ? measuredRate : rate;
    // Only what fits in the current SES quota window goes out now; the rest
    // waits for the rolling window to free up.
    const thisWindow = Math.min(remaining, Math.max(0, available));
    const laterWindows = remaining - thisWindow;
    const etaMessage = laterWindows > 0
      ? `About ${formatDuration(estimateEtaSeconds(thisWindow, effective))} left in this SES quota window; ${laterWindows.toLocaleString()} more send automatically as quota frees (~${Math.ceil(laterWindows / Math.max(1, quota.max24HourSend - config.quotaReserve))} more day(s)).`
      : `About ${formatDuration(estimateEtaSeconds(remaining, effective))} left.`;
    const wrote = await patchRecord(record, {
      state: "running",
      heartbeatAt: nowIso(),
      nextCheckAt: null,
      errorCount: 0,
      run: { url: runUrl, workerId, startedAt: new Date(runStartedAt).toISOString() },
      progress: {
        acceptedThisRun: accepted,
        failedThisRun: failed,
        remainingEstimate: remaining,
        ratePerSecond: Number(measuredRate.toFixed(2)),
        targetRatePerSecond: Number(rate.toFixed(2)),
        etaSeconds: estimateEtaSeconds(thisWindow, effective),
        laterWindowRecipients: laterWindows,
        backoffMs: backoff.currentPauseMs,
      },
      quota: { ...quota, available, reserve: config.quotaReserve, checkedAt: new Date(lastQuotaRefresh).toISOString() },
      ...(deliverability ? { deliverability } : {}),
      canary: canaryPending ? { recipients: config.canaryRecipients, sent: sentSinceBaseline } : null,
      message: `Sending at ${measuredRate.toFixed(1)}/s. ${etaMessage}`,
      ...extra,
    });
    return wrote !== false;
  };

  if (!(await heartbeat())) return "paused";

  // Breaker baseline is fixed per approval, so re-approving after a trip
  // judges only new events.
  if (!record.breakerBaseline) {
    const counts = await deliverabilityCounts(emailId).catch(() => null);
    if (counts) await patchRecord(record, { breakerBaseline: { accepted: summary.succeeded, ...counts, at: nowIso() } });
  }
  const baseline = record.breakerBaseline ?? { accepted: summary.succeeded, hardBounces: 0, complaints: 0 };
  sentSinceBaseline = summary.succeeded - baseline.accepted;
  canaryPending = config.canaryRecipients > 0 && !record.canaryPassed && sentSinceBaseline < config.canaryRecipients && remainingAtStart > config.canaryRecipients;
  let lastBreakerCheck = Date.now();

  const checkBreaker = async (minSample) => {
    const counts = await deliverabilityCounts(emailId).catch(() => null);
    if (!counts) return null;
    const sample = {
      accepted: Math.max(0, sentSinceBaseline),
      hardBounces: Math.max(0, counts.hardBounces - baseline.hardBounces),
      complaints: Math.max(0, counts.complaints - baseline.complaints),
    };
    const deliveredSince = Math.max(0, counts.delivered - (baseline.delivered ?? 0));
    const blind = sample.accepted >= config.blindAfterAccepted && deliveredSince === 0;
    deliverability = { ...sample, delivered: deliveredSince, blind, maxHardBounceRate: config.breaker.maxHardBounceRate, maxComplaintRate: config.breaker.maxComplaintRate, checkedAt: nowIso() };
    if (blind && !record.eventsBlindNotified) {
      await patchRecord(record, { eventsBlindNotified: true });
      await notifyOperator(email, `No SES events arriving: ${email.subject}`, [
        `${sample.accepted.toLocaleString()} recipients were accepted by SES since approval, but no Delivery events have reached the app.`,
        "Sending continues, but the bounce/complaint circuit breaker cannot see problems until events flow again.",
        "Check the SES configuration-set event destination, the SNS subscription, and /api/webhooks/ses (see /api/health).",
        `Campaign: ${emailId}`,
      ]);
    }
    return evaluateDeliverability(sample, { ...config.breaker, minSample });
  };

  while (!stopReason) {
    if (Date.now() >= deadlineMs) {
      stopReason = "deadline";
      break;
    }
    if (Date.now() - lastHeartbeat >= config.heartbeatMs && !(await heartbeat())) {
      stopReason = "paused";
      break;
    }
    if (window && !sendWindowStatus(Date.now(), window).open) {
      stopReason = "window";
      break;
    }
    if (Date.now() - lastQuotaRefresh >= config.quotaRefreshMs) {
      const refreshed = await sesQuota().catch(() => null);
      if (refreshed) {
        Object.assign(quota, refreshed);
        available = availableQuota({ ...refreshed, reserve: config.quotaReserve });
      }
      lastQuotaRefresh = Date.now();
    }
    if (available <= 0) {
      stopReason = "quota";
      break;
    }

    if (canaryPending && sentSinceBaseline >= config.canaryRecipients) {
      canaryPending = false;
      console.log(`canary: ${sentSinceBaseline} sent; waiting ${config.canaryWaitMs / 1000}s for bounce/complaint signals`);
      const waitUntil = Date.now() + config.canaryWaitMs;
      while (Date.now() < waitUntil) {
        await sleep(Math.min(config.heartbeatMs, Math.max(0, waitUntil - Date.now())));
        if (!(await heartbeat({ message: `Canary: first ${sentSinceBaseline.toLocaleString()} sent. Checking bounces and complaints before full speed.` }))) {
          stopReason = "paused";
          break;
        }
      }
      if (stopReason) break;
      const verdict = await checkBreaker(Math.min(config.breaker.minSample, config.canaryRecipients));
      if (verdict?.trip) {
        stopReason = "blocked";
        stopDetail = `Deliverability circuit breaker (canary): ${verdict.reason} Check the list and content; press Send to override.`;
        break;
      }
      await patchRecord(record, { canaryPassed: true, canary: null, ...(deliverability ? { deliverability } : {}) });
      pacer.reset();
    }
    if (Date.now() - lastBreakerCheck >= config.breakerCheckMs) {
      lastBreakerCheck = Date.now();
      const verdict = await checkBreaker(config.breaker.minSample);
      if (verdict?.trip) {
        stopReason = "blocked";
        stopDetail = `Deliverability circuit breaker: ${verdict.reason} Check the list and content; press Send to override.`;
        break;
      }
    }

    const claimLimit = canaryPending ? Math.max(1, config.canaryRecipients - sentSinceBaseline) : config.claimSize;
    const claim = await claimBatch(emailId, Math.min(config.claimSize, claimLimit, available));
    if (!claim.items.length) {
      // Selected rows changed before the claim (e.g. canceled by an edit).
      // Reselect a few times, never forever.
      if (claim.raced && (racedClaims += 1) < 5) continue;
      break;
    }
    racedClaims = 0;
    const suppressed = await findLateSuppressed(claim.items);
    const { invalid, deliverable } = buildDeliverable(email, compiled, claim.items.filter((item) => !suppressed.has(item.id)));
    const results = [
      ...[...suppressed].map((id) => ({ id, outcome: "canceled", ses_message_id: null, last_error: "Canceled: recipient unsubscribed, bounced, complained, or was blocked after queueing." })),
      ...invalid,
    ];
    const groups = new Map();
    for (const entry of deliverable) {
      const key = JSON.stringify(entry.compiled.content);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    let signal = null;
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += requestSize) {
        const entries = group.slice(offset, offset + requestSize);
        if (signal && signal !== "throttle") {
          // Stop spending attempts once SES says the account cannot send.
          results.push(...entries.map(({ item }) => ({ id: item.id, outcome: "retry", ses_message_id: null, last_error: `Deferred: SES ${signal}` })));
          continue;
        }
        const sent = await sendGroup(email, entries, pacer, headers);
        results.push(...sent.results);
        if (sent.ambiguous) ambiguous += entries.length;
        if (sent.signal) signal = sent.signal;
      }
    }

    const saved = await checkpoint(emailId, results);
    const claimAccepted = results.filter((result) => result.outcome === "succeeded").length;
    const claimFailed = results.filter((result) => result.outcome === "dead" || result.outcome === "canceled").length;
    accepted += claimAccepted;
    sentSinceBaseline += claimAccepted;
    failed += claimFailed;
    available -= claimAccepted;
    console.log(`claim=${claim.items.length} accepted=${claimAccepted} failed=${claimFailed} total_accepted=${accepted}`);

    if (signal === "quota") {
      stopReason = "quota";
      break;
    }
    if (signal === "paused" || signal === "rejected") {
      stopReason = "blocked";
      stopDetail = signal === "paused"
        ? "SES reported account or configuration-set sending is paused."
        : `SES rejected the send request: ${results.find((result) => result.last_error)?.last_error ?? "unknown"}`;
      break;
    }

    let pauseMs = backoff.observe({ latencyMs: Math.max(claim.latencyMs, saved.latencyMs), retried: claim.retried || saved.retried });
    if (signal === "throttle") pauseMs = Math.max(pauseMs, 5_000);
    if (config.recoveryPauseEvery > 0 && config.recoveryPauseMs > 0 && accepted >= nextRecoveryPauseAt) {
      pauseMs = Math.max(pauseMs, config.recoveryPauseMs);
      while (nextRecoveryPauseAt <= accepted) nextRecoveryPauseAt += config.recoveryPauseEvery;
    }
    if (pauseMs > 0) {
      console.log(`backoff_pause=${pauseMs}ms accepted=${accepted}`);
      await sleep(pauseMs);
      pacer.reset();
    }
  }

  summaryLine(`  - accepted ${accepted.toLocaleString()}, failed ${failed.toLocaleString()}${ambiguous ? `, ambiguous ${ambiguous}` : ""}, stop: ${stopReason ?? "drained"}`);
  if (ambiguous) {
    await notifyOperator(email, `Ambiguous SES response: ${email.subject}`, [
      `${ambiguous} recipient(s) got no SES response (network failure). They were parked as ambiguous and will not be retried automatically.`,
      `Campaign: ${emailId}`,
    ]);
  }

  if (stopReason === "paused") return "paused";
  if (stopReason === "blocked") return block(email, record, stopDetail);
  if (stopReason === "window") {
    await windowGate();
    return "window";
  }
  if (stopReason === "quota") {
    const nextCheckAt = new Date(Date.now() + config.quotaRecheckMs).toISOString();
    const summary = await loadSummary(emailId).catch(() => null);
    const unsent = summary ? summary.pending_due + summary.pending_held : null;
    // One progress email per quota window, not one per 15-minute re-check.
    const lastNoticeMs = Date.parse(record.lastQuotaNoticeAt ?? "");
    const notice = accepted > 0 && (!Number.isFinite(lastNoticeMs) || Date.now() - lastNoticeMs > 12 * 3_600_000);
    await patchRecord(record, {
      state: "waiting_quota",
      heartbeatAt: nowIso(),
      nextCheckAt,
      ...(notice ? { lastQuotaNoticeAt: nowIso() } : {}),
      message: `Paused for SES rolling quota after ${accepted.toLocaleString()} accepted this run${unsent !== null ? `; ${unsent.toLocaleString()} still to send` : ""}. Resumes automatically (next check ${nextCheckAt.slice(11, 16)} UTC).`,
    });
    if (notice && summary) {
      await notifyOperator(email, `Progress: ${email.subject}`, [
        `This SES quota window is used up. Accepted so far: ${summary.succeeded.toLocaleString()}. Still to send: ${unsent.toLocaleString()}.`,
        "Autopilot resumes by itself as the rolling 24-hour quota frees up; nothing to do.",
        `Campaign: ${emailId}`,
      ]);
    }
    return "quota";
  }
  if (stopReason === "deadline") {
    await patchRecord(record, {
      state: "approved",
      heartbeatAt: nowIso(),
      nextCheckAt: null,
      message: `Runner time budget reached after ${accepted.toLocaleString()} accepted; the next scheduled run continues automatically.`,
    });
    return "deadline";
  }

  if (await finalizeComplete(email, record, "all recipients processed")) return "complete";
  const retryAt = await earliestRetryAt(emailId);
  await patchRecord(record, {
    state: "waiting_retry",
    heartbeatAt: nowIso(),
    nextCheckAt: retryAt ?? new Date(Date.now() + 5 * 60_000).toISOString(),
    message: "Some recipients hit a transient SES error and are scheduled for an automatic retry.",
  });
  return "waiting";
}

async function runCampaignSafely(record) {
  try {
    return await runCampaign(record);
  } catch (error) {
    const errorCount = Number(record.errorCount ?? 0) + 1;
    console.error(`campaign ${record.emailId} worker error #${errorCount}: ${conciseError(error)}`);
    if (errorCount >= config.maxConsecutiveErrors) {
      const email = await loadEmail(record.emailId).catch(() => null);
      return block(email, record, `Worker failed ${errorCount} times in a row. Last error: ${conciseError(error)}`);
    }
    await patchRecord(record, {
      state: "approved",
      errorCount,
      lastError: conciseError(error),
      heartbeatAt: nowIso(),
      nextCheckAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      message: `Worker error (${errorCount}/${config.maxConsecutiveErrors}); retrying automatically in about 5 minutes. ${conciseError(error)}`,
    }).catch(() => null);
    return "error";
  }
}

// ── Entry points ──

async function dryRun(emailId) {
  const email = await loadEmail(emailId);
  if (!email) throw new Error("Campaign not found");
  assertSendReadySubject(email.subject);
  const summary = await loadSummary(emailId);
  const { data: sample } = await supabase.from("mail_queue").select("id, payload").eq("email_id", emailId).eq("status", "pending").limit(1).maybeSingle();
  const compiled = compileTemplate({ subject: email.subject, html: email.html, text: email.text, appBaseUrl });
  if (sample) compiled.replacementData(recipientData(sample.payload, sample.id));
  const record = await readRecord(emailId).catch(() => null);
  const quota = process.env.AWS_REGION ? await sesQuota().catch((error) => ({ error: conciseError(error) })) : null;
  console.log(JSON.stringify({
    mode,
    campaign: { id: email.id, subject: email.subject, status: email.status, contentSha256: campaignContentDigest(email) },
    queue: summary,
    autopilot: record ? { state: record.state, message: record.message, approvedAt: record.approvedAt } : null,
    quota,
  }, null, 2));
  console.log("Dry run complete. No database rows were changed and no email was sent.");
}

async function manualSend(emailId) {
  if (confirmation !== `send:${emailId}`) throw new Error(`Send mode requires --confirmation send:${emailId}`);
  const email = await loadEmail(emailId);
  if (!email) throw new Error("Campaign not found");
  if (!["queued", "sending"].includes(email.status)) throw new Error(`Campaign status ${email.status} is not eligible for a bulk send.`);
  assertSendReadySubject(email.subject);
  const summary = await loadSummary(emailId);
  if (summary.pending_due + summary.pending_held === 0) throw new Error("No pending recipients remain.");
  const { error } = await supabase.from("emails").update({ status: "sending", updated_at: nowIso() }).eq("id", emailId).in("status", ["queued", "sending"]);
  if (error) throw new Error(`Unable to activate campaign: ${error.message}`);
  const record = await writeNewApproval({
    emailId,
    approvalId: crypto.randomUUID(),
    approvedAt: nowIso(),
    approvedBy: `github-actions:${process.env.GITHUB_ACTOR ?? "local"}`,
    approvedRecipients: summary.pending_due + summary.pending_held,
    contentSha256: campaignContentDigest(email),
    subject: email.subject,
    source: "manual-dispatch",
    maxRatePerSecond: config.requestedRate,
    state: "approved",
    message: "Approved by manual worker dispatch.",
  });
  return runCampaignSafely(record);
}

async function autopilot() {
  const processed = new Set();
  const outcomes = [];
  while (Date.now() < deadlineMs) {
    const records = await listRecords();
    const due = orderDueRecords(
      records.filter((record) => !emailIdArg || record.emailId === emailIdArg),
      Date.now(),
      config.heartbeatStaleMs,
    ).filter((record) => !processed.has(record.emailId));
    const next = due[0];
    if (!next) break;
    processed.add(next.emailId);
    const outcome = await runCampaignSafely(next);
    outcomes.push({ emailId: next.emailId, outcome });
    // SES quota is account-wide: when one campaign waits, every campaign waits.
    if (outcome === "quota" || outcome === "deadline") break;
  }
  return outcomes;
}

summaryLine(`### Props Mailer SES worker (${mode})`);
let exitCode = 0;
try {
  if (mode === "dry-run") {
    await dryRun(emailIdArg);
  } else {
    const lease = await acquireLease();
    if (!lease.ok) {
      const message = `Another SES worker holds the lease (${lease.holder}); exiting without sending.`;
      console.log(message);
      summaryLine(`- ${message}`);
      if (mode === "send") exitCode = 1;
    } else {
      const result = mode === "send" ? await manualSend(emailIdArg) : await autopilot();
      console.log(JSON.stringify({ mode, result, runtimeMinutes: Number(((Date.now() - startedAtMs) / 60_000).toFixed(1)) }));
      if (mode === "autopilot" && Array.isArray(result) && !result.length) summaryLine("- Nothing due. No email was sent.");
      if (mode === "send" && ["blocked", "error"].includes(result)) exitCode = 1;
    }
  }
} catch (error) {
  console.error(conciseError(error));
  summaryLine(`- ERROR ${conciseError(error)}`);
  exitCode = 1;
} finally {
  await releaseLease().catch(() => null);
  await dbPool?.end().catch(() => null);
}
process.exit(exitCode);
