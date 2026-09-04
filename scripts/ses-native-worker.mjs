#!/usr/bin/env node
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetAccountCommand, SendBulkEmailCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { assertSendReadySubject, compileTemplate, recipientData } from "./lib/ses-bulk-worker-core.mjs";
import {
  batchConfirmation,
  batchRecordKey,
  classifyNativeSesResult,
  isTerminalState,
  oneClickUnsubscribeUrl,
  recipientHash,
  validateCampaignManifest,
  validateRecipient,
} from "./lib/ses-native-core.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_RECIPIENT_HASH = "!META";
const SUPPRESSION_CAMPAIGN_ID = "!SUPPRESSION";
const MAX_ATTEMPTS = 5;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  return values;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function sha256File(path) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadJson(s3, bucket, key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await response.Body.transformToString());
}

async function downloadFile(s3, bucket, key, path) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(response.Body, createWriteStream(path, { flags: "wx" }));
}

async function* recipientLines(path) {
  const input = createReadStream(path).pipe(createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield { ...validateRecipient(JSON.parse(line)), ordinal: lineNumber - 1 };
    } catch (error) {
      throw new Error(`Invalid recipient manifest line ${lineNumber}: ${error.message}`);
    }
  }
}

async function inspectRecipientFile(path) {
  let count = 0;
  let sample;
  const seen = new Set();
  for await (const recipient of recipientLines(path)) {
    const hash = recipientHash(recipient.email);
    if (seen.has(hash)) throw new Error(`Recipient manifest contains duplicate address ${recipient.email}.`);
    seen.add(hash);
    sample ??= recipient;
    count += 1;
  }
  return { count, sample };
}

async function getControlRecord(db, tableName, campaignId, recipientHashValue) {
  const response = await db.send(new GetCommand({
    TableName: tableName,
    Key: { campaign_id: campaignId, recipient_hash: recipientHashValue },
    ConsistentRead: true,
  }));
  return response.Item ?? null;
}

function summarizeBatchRecord(record) {
  return {
    accepted: Number(record?.accepted ?? 0),
    claimed: Number(record?.claimed ?? 0),
    retry: Number(record?.retry ?? 0),
    dead: Number(record?.dead ?? 0),
    canceled: Number(record?.canceled ?? 0),
  };
}

function terminalCount(state) {
  return state.accepted + state.dead + state.canceled;
}

async function readUnsubscribeSecret(secrets, secretId) {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = response.SecretString
    ?? (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : "");
  if (!value) throw new Error(`Unsubscribe signing secret ${secretId} is empty.`);
  return value;
}

async function batchReadStates(db, tableName, campaignId, recipients) {
  const hashes = recipients.map((recipient) => recipientHash(recipient.email));
  const keys = hashes.flatMap((hash) => [
    { campaign_id: campaignId, recipient_hash: hash },
    { campaign_id: SUPPRESSION_CAMPAIGN_ID, recipient_hash: hash },
  ]);
  const items = [];
  let pendingKeys = keys;
  do {
    const response = await db.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: pendingKeys, ConsistentRead: true } } }));
    items.push(...(response.Responses?.[tableName] ?? []));
    pendingKeys = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
    if (pendingKeys.length) await sleep(250);
  } while (pendingKeys.length);
  return new Map(items.map((item) => [`${item.campaign_id}:${item.recipient_hash}`, item]));
}

async function transact(db, items) {
  if (!items.length) return;
  await db.send(new TransactWriteCommand({ TransactItems: items }));
}

async function claimBatch(db, tableName, campaignId, approvalSha, batchNumber, entries, claimToken) {
  const now = new Date().toISOString();
  const retryClaims = entries.filter(({ previous }) => previous?.status === "RETRY").length;
  const recipientUpdates = entries.map(({ recipient, hash }) => ({
    Update: {
      TableName: tableName,
      Key: { campaign_id: campaignId, recipient_hash: hash },
      UpdateExpression: "SET #status = :claimed, email = :email, recipient_name = :name, approval_sha256 = :sha, batch_number = :batch, recipient_ordinal = :ordinal, claim_token = :token, claimed_at = :now, updated_at = :now, attempts = if_not_exists(attempts, :zero) + :one",
      ConditionExpression: "(attribute_not_exists(#status) OR #status = :retry) AND (attribute_not_exists(batch_number) OR batch_number = :batch)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":claimed": "CLAIMED",
        ":retry": "RETRY",
        ":email": recipient.email,
        ":name": recipient.name ?? null,
        ":sha": approvalSha,
        ":batch": batchNumber,
        ":ordinal": recipient.ordinal,
        ":token": claimToken,
        ":now": now,
        ":zero": 0,
        ":one": 1,
      },
    },
  }));
  await transact(db, [
    ...recipientUpdates,
    {
      Update: {
        TableName: tableName,
        Key: { campaign_id: campaignId, recipient_hash: batchRecordKey(batchNumber) },
        UpdateExpression: "SET updated_at = :now ADD claimed :claimed, retry :retry",
        ConditionExpression: "release_state = :approved AND approval_sha256 = :sha",
        ExpressionAttributeValues: {
          ":now": now,
          ":claimed": entries.length,
          ":retry": -retryClaims,
          ":approved": "APPROVED",
          ":sha": approvalSha,
        },
      },
    },
  ]);
  return entries.map((entry) => ({ ...entry, attempts: Number(entry.previous?.attempts ?? 0) + 1 }));
}

async function checkpointBatch(db, tableName, campaignId, batchNumber, claimToken, results) {
  const now = new Date().toISOString();
  const writes = results.map((result) => ({
    Update: {
      TableName: tableName,
      Key: { campaign_id: campaignId, recipient_hash: result.hash },
      UpdateExpression: "SET #status = :status, ses_message_id = :message, last_error = :error, accepted_at = :accepted, updated_at = :now REMOVE claim_token",
      ConditionExpression: "#status = :claimed AND claim_token = :token",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": result.status,
        ":message": result.sesMessageId,
        ":error": result.error,
        ":accepted": result.status === "ACCEPTED" ? now : null,
        ":now": now,
        ":claimed": "CLAIMED",
        ":token": claimToken,
      },
    },
  }));
  const outcomeCounts = {
    accepted: results.filter((result) => result.status === "ACCEPTED").length,
    retry: results.filter((result) => result.status === "RETRY").length,
    dead: results.filter((result) => result.status === "DEAD").length,
  };
  writes.push({
    Update: {
      TableName: tableName,
      Key: { campaign_id: campaignId, recipient_hash: batchRecordKey(batchNumber) },
      UpdateExpression: "SET updated_at = :now ADD claimed :claimed, accepted :accepted, retry :retry, dead :dead",
      ConditionExpression: "release_state = :approved AND claimed >= :checkpoint_count",
      ExpressionAttributeValues: {
        ":now": now,
        ":claimed": -results.length,
        ":accepted": outcomeCounts.accepted,
        ":retry": outcomeCounts.retry,
        ":dead": outcomeCounts.dead,
        ":approved": "APPROVED",
        ":checkpoint_count": results.length,
      },
    },
  });
  try {
    await transact(db, writes);
  } catch (error) {
    const state = await batchReadStates(db, tableName, campaignId, results.map(({ recipient }) => recipient));
    const durable = results.every((result) => {
      const row = state.get(`${campaignId}:${result.hash}`);
      return row?.status === result.status && (result.status !== "ACCEPTED" || row.ses_message_id === result.sesMessageId);
    });
    if (!durable) throw new Error(`SES accepted a batch but its DynamoDB checkpoint is ambiguous: ${error.message}. Do not retry until reconciled.`);
    console.warn(`checkpoint response was ambiguous but all ${results.length} outcomes are durable`);
  }
}

async function acquireLease(db, tableName, campaignId, approvalSha, owner) {
  const nowEpoch = Math.floor(Date.now() / 1_000);
  const expires = nowEpoch + 15 * 60;
  await db.send(new UpdateCommand({
    TableName: tableName,
    Key: { campaign_id: campaignId, recipient_hash: META_RECIPIENT_HASH },
    UpdateExpression: "SET approval_sha256 = :sha, lease_owner = :owner, lease_expires_at = :expires, updated_at = :updated",
    ConditionExpression: "(attribute_not_exists(approval_sha256) OR approval_sha256 = :sha) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at < :now OR lease_owner = :owner)",
    ExpressionAttributeValues: { ":sha": approvalSha, ":owner": owner, ":expires": expires, ":now": nowEpoch, ":updated": new Date().toISOString() },
  }));
}

async function renewLease(db, tableName, campaignId, owner) {
  const nowEpoch = Math.floor(Date.now() / 1_000);
  await db.send(new UpdateCommand({
    TableName: tableName,
    Key: { campaign_id: campaignId, recipient_hash: META_RECIPIENT_HASH },
    UpdateExpression: "SET lease_expires_at = :expires, updated_at = :updated",
    ConditionExpression: "lease_owner = :owner",
    ExpressionAttributeValues: { ":owner": owner, ":expires": nowEpoch + 15 * 60, ":updated": new Date().toISOString() },
  }));
}

async function releaseLease(db, tableName, campaignId, owner) {
  await db.send(new UpdateCommand({
    TableName: tableName,
    Key: { campaign_id: campaignId, recipient_hash: META_RECIPIENT_HASH },
    UpdateExpression: "REMOVE lease_owner, lease_expires_at SET updated_at = :updated",
    ConditionExpression: "lease_owner = :owner",
    ExpressionAttributeValues: { ":owner": owner, ":updated": new Date().toISOString() },
  })).catch((error) => console.warn(`Unable to release campaign lease: ${error.message}`));
}

async function authorizeBatch(db, tableName, campaignId, approvalSha, batchNumber, confirmation) {
  const now = new Date().toISOString();
  await db.send(new UpdateCommand({
    TableName: tableName,
    Key: { campaign_id: campaignId, recipient_hash: batchRecordKey(batchNumber) },
    UpdateExpression: "SET release_state = :approved, approval_token = if_not_exists(approval_token, :token), approved_at = if_not_exists(approved_at, :now), updated_at = :now",
    ConditionExpression: "approval_sha256 = :sha AND (release_state = :ready OR (release_state = :approved AND approval_token = :token))",
    ExpressionAttributeValues: {
      ":approved": "APPROVED",
      ":ready": "READY_FOR_APPROVAL",
      ":token": confirmation,
      ":sha": approvalSha,
      ":now": now,
    },
  }));
}

async function cancelSuppressedRecipient(db, tableName, campaignId, batchNumber, approvalSha, recipient, hash, previous, reason) {
  const now = new Date().toISOString();
  const wasRetry = previous?.status === "RETRY" ? 1 : 0;
  await transact(db, [
    {
      Update: {
        TableName: tableName,
        Key: { campaign_id: campaignId, recipient_hash: hash },
        UpdateExpression: "SET #status = :status, email = :email, approval_sha256 = :sha, batch_number = :batch, recipient_ordinal = :ordinal, last_error = :reason, updated_at = :now",
        ConditionExpression: "(attribute_not_exists(#status) OR #status = :retry) AND (attribute_not_exists(batch_number) OR batch_number = :batch)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "CANCELED",
          ":retry": "RETRY",
          ":email": recipient.email,
          ":sha": approvalSha,
          ":batch": batchNumber,
          ":ordinal": recipient.ordinal,
          ":reason": reason,
          ":now": now,
        },
      },
    },
    {
      Update: {
        TableName: tableName,
        Key: { campaign_id: campaignId, recipient_hash: batchRecordKey(batchNumber) },
        UpdateExpression: "SET updated_at = :now ADD canceled :one, retry :retry",
        ConditionExpression: "release_state = :approved AND approval_sha256 = :sha",
        ExpressionAttributeValues: {
          ":now": now,
          ":one": 1,
          ":retry": -wasRetry,
          ":approved": "APPROVED",
          ":sha": approvalSha,
        },
      },
    },
  ]);
}

async function completeBatchAndPromoteNext(db, tableName, campaignId, approvalSha, batch, state, nextBatch) {
  const now = new Date().toISOString();
  const currentUpdate = {
    Update: {
      TableName: tableName,
      Key: { campaign_id: campaignId, recipient_hash: batchRecordKey(batch.batchNumber) },
      UpdateExpression: "SET release_state = :completed, completed_at = if_not_exists(completed_at, :now), updated_at = :now",
      ConditionExpression: "approval_sha256 = :sha AND release_state = :approved AND accepted = :accepted AND dead = :dead AND canceled = :canceled AND claimed = :zero AND retry = :zero",
      ExpressionAttributeValues: {
        ":completed": "COMPLETED",
        ":approved": "APPROVED",
        ":sha": approvalSha,
        ":accepted": state.accepted,
        ":dead": state.dead,
        ":canceled": state.canceled,
        ":zero": 0,
        ":now": now,
      },
    },
  };
  const writes = [currentUpdate];
  if (nextBatch) {
    writes.push({
      Update: {
        TableName: tableName,
        Key: { campaign_id: campaignId, recipient_hash: batchRecordKey(nextBatch.batchNumber) },
        UpdateExpression: "SET release_state = :ready, ready_at = if_not_exists(ready_at, :now), updated_at = :now",
        ConditionExpression: "approval_sha256 = :sha AND release_state = :queued",
        ExpressionAttributeValues: {
          ":ready": "READY_FOR_APPROVAL",
          ":queued": "QUEUED_FOR_APPROVAL",
          ":sha": approvalSha,
          ":now": now,
        },
      },
    });
  }
  await transact(db, writes);
}

async function sendOperatorNotice({ db, tableName, ses, configurationSet, manifest, batch, state, nextBatch, operatorEmail, appUrl }) {
  const key = { campaign_id: manifest.campaign.id, recipient_hash: batchRecordKey(batch.batchNumber) };
  const noticeClaimedAt = new Date().toISOString();
  try {
    await db.send(new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET operator_notice_state = :sending, operator_notice_claimed_at = :now, updated_at = :now",
      ConditionExpression: "release_state = :completed AND attribute_not_exists(operator_notice_sent_at) AND attribute_not_exists(operator_notice_claimed_at)",
      ExpressionAttributeValues: { ":sending": "SENDING", ":completed": "COMPLETED", ":now": noticeClaimedAt },
    }));
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") return { sent: false, reason: "already-claimed-or-sent" };
    throw error;
  }

  const statusUrl = new URL("/email/aws-native", appUrl);
  statusUrl.searchParams.set("campaignId", manifest.campaign.id);
  const subject = nextBatch
    ? `Batch ${batch.batchNumber} finished — approve batch ${nextBatch.batchNumber}`
    : `Campaign complete — ${manifest.campaign.subject}`;
  const nextStep = nextBatch
    ? `Batch ${nextBatch.batchNumber} is ready for your explicit approval. Nothing else will send until you return to the app.`
    : "All campaign batches are complete.";
  const text = [
    `Campaign: ${manifest.campaign.subject}`,
    `Campaign ID: ${manifest.campaign.id}`,
    `Manifest: ${manifest.approvalSha256}`,
    `Batch: ${batch.batchNumber} of ${manifest.batches.length}`,
    `SES accepted: ${state.accepted}`,
    `Dead: ${state.dead}`,
    `Canceled/suppressed: ${state.canceled}`,
    "",
    nextStep,
    statusUrl.toString(),
  ].join("\n");
  try {
    const response = await ses.send(new SendEmailCommand({
      FromEmailAddress: manifest.campaign.fromAddress,
      Destination: { ToAddresses: [operatorEmail] },
      ConfigurationSetName: configurationSet,
      EmailTags: [
        { Name: "campaign_id", Value: manifest.campaign.id },
        { Name: "message_type", Value: "operator_notice" },
      ],
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Text: { Data: text, Charset: "UTF-8" } },
        },
      },
    }));
    const sentAt = new Date().toISOString();
    await db.send(new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET operator_notice_state = :sent, operator_notice_sent_at = :now, operator_notice_message_id = :message, updated_at = :now",
      ConditionExpression: "operator_notice_state = :sending AND operator_notice_claimed_at = :claimed",
      ExpressionAttributeValues: {
        ":sent": "SENT",
        ":sending": "SENDING",
        ":claimed": noticeClaimedAt,
        ":now": sentAt,
        ":message": response.MessageId ?? "",
      },
    }));
    return { sent: true, messageId: response.MessageId ?? null };
  } catch (error) {
    await db.send(new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET operator_notice_state = :ambiguous, operator_notice_error = :error, updated_at = :now",
      ConditionExpression: "operator_notice_claimed_at = :claimed",
      ExpressionAttributeValues: {
        ":ambiguous": "AMBIGUOUS",
        ":error": String(error?.message ?? error),
        ":claimed": noticeClaimedAt,
        ":now": new Date().toISOString(),
      },
    })).catch(() => {});
    throw new Error(`Operator notice outcome is ambiguous; it will not be retried automatically. ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const campaignId = args.get("--campaign-id");
  const manifestKey = args.get("--manifest-key");
  const mode = args.get("--mode") ?? "dry-run";
  const batchNumber = Number(args.get("--batch-number"));
  if (!campaignId || !UUID.test(campaignId)) throw new Error("--campaign-id must be a UUID.");
  if (!manifestKey) throw new Error("--manifest-key is required.");
  if (!["dry-run", "send"].includes(mode)) throw new Error("--mode must be dry-run or send.");
  if (!Number.isSafeInteger(batchNumber) || batchNumber < 1) throw new Error("--batch-number must be a positive integer.");

  const region = required("AWS_REGION");
  const bucket = required("SES_CAMPAIGN_BUCKET");
  const tableName = required("SES_CAMPAIGN_STATE_TABLE");
  const configurationSet = required("AWS_SES_CONFIGURATION_SET");
  const unsubscribeBaseUrl = required("SES_UNSUBSCRIBE_BASE_URL");
  const unsubscribeSecretArn = required("SES_UNSUBSCRIBE_SECRET_ARN");
  const operatorEmail = required("SES_OPERATOR_EMAIL");
  const appUrl = required("SES_APP_URL");
  const s3 = new S3Client({ region });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  const ses = new SESv2Client({ region });
  const secrets = new SecretsManagerClient({ region });

  const manifest = validateCampaignManifest(await downloadJson(s3, bucket, manifestKey), campaignId);
  const selectedBatch = manifest.batches.find((batch) => batch.batchNumber === batchNumber);
  if (!selectedBatch) throw new Error(`Manifest has no batch ${batchNumber}.`);
  assertSendReadySubject(manifest.campaign.subject);
  const recipientPath = join(tmpdir(), `props-ses-${campaignId}-${crypto.randomUUID()}.ndjson.gz`);
  await downloadFile(s3, bucket, manifest.recipients.key, recipientPath);
  const actualSha = await sha256File(recipientPath);
  if (actualSha !== manifest.recipients.sha256) throw new Error(`Recipient manifest checksum mismatch: expected ${manifest.recipients.sha256}, received ${actualSha}.`);
  const inspected = await inspectRecipientFile(recipientPath);
  if (inspected.count !== manifest.recipients.count) throw new Error(`Recipient manifest count mismatch: expected ${manifest.recipients.count}, received ${inspected.count}.`);
  const compiled = compileTemplate({ subject: manifest.campaign.subject, html: manifest.campaign.html, text: manifest.campaign.text });
  compiled.replacementData(recipientData({ to: inspected.sample.email, toName: inspected.sample.name, merge: inspected.sample.merge }, recipientHash(inspected.sample.email)));

  const [account, campaignRecord, batchRecord, unsubscribeSecret] = await Promise.all([
    ses.send(new GetAccountCommand({})),
    getControlRecord(db, tableName, campaignId, META_RECIPIENT_HASH),
    getControlRecord(db, tableName, campaignId, batchRecordKey(batchNumber)),
    readUnsubscribeSecret(secrets, unsubscribeSecretArn),
  ]);
  if (campaignRecord?.approval_sha256 !== manifest.approvalSha256 || campaignRecord?.manifest_key !== manifestKey) {
    throw new Error("DynamoDB campaign control record does not match the immutable manifest.");
  }
  if (batchRecord?.approval_sha256 !== manifest.approvalSha256
    || Number(batchRecord?.batch_number) !== batchNumber
    || Number(batchRecord?.start_ordinal) !== selectedBatch.startOrdinal
    || Number(batchRecord?.end_ordinal) !== selectedBatch.endOrdinal
    || Number(batchRecord?.recipient_count) !== selectedBatch.count) {
    throw new Error(`DynamoDB batch ${batchNumber} control record does not match the immutable manifest.`);
  }
  const state = summarizeBatchRecord(batchRecord);
  const remainingInBatch = selectedBatch.count - terminalCount(state);
  const quota = {
    max24Hour: Number(account.SendQuota?.Max24HourSend ?? 0),
    sentLast24Hours: Number(account.SendQuota?.SentLast24Hours ?? 0),
    maxRate: Number(account.SendQuota?.MaxSendRate ?? 0),
  };
  quota.remaining = Math.max(0, Math.floor(quota.max24Hour - quota.sentLast24Hours));
  const noticeNeedsSend = !batchRecord.operator_notice_sent_at && !batchRecord.operator_notice_claimed_at;
  const requiredHeadroom = remainingInBatch + (noticeNeedsSend ? 1 : 0);
  const confirmation = batchConfirmation(campaignId, manifest.approvalSha256, batchNumber);
  console.log(JSON.stringify({
    mode,
    campaign: { id: campaignId, subject: manifest.campaign.subject },
    manifestKey,
    recipients: manifest.recipients.count,
    batch: { ...selectedBatch, releaseState: batchRecord.release_state },
    state,
    remainingInBatch,
    requiredHeadroom,
    quota,
    unsubscribe: { baseUrl: unsubscribeBaseUrl, secretResolved: Boolean(unsubscribeSecret) },
    operatorNotice: { email: operatorEmail, appUrl },
    requiredConfirmation: confirmation,
  }, null, 2));
  if (mode === "dry-run") {
    console.log("Dry run complete. No DynamoDB state was changed and no email was sent.");
    return;
  }
  if (args.get("--confirmation") !== confirmation) throw new Error(`Send mode requires --confirmation ${confirmation}.`);
  if (account.ProductionAccessEnabled !== true) throw new Error("SES production access is not enabled in the configured region.");
  if (state.claimed > 0) throw new Error(`${state.claimed} recipient(s) are in ambiguous CLAIMED state. Reconcile SES events before retrying.`);
  if (state.retry < 0 || state.claimed < 0 || terminalCount(state) > selectedBatch.count) {
    throw new Error(`Batch ${batchNumber} counters are internally inconsistent; do not send.`);
  }
  if (quota.remaining < requiredHeadroom) {
    throw new Error(`SES rolling quota has room for ${quota.remaining}, but batch ${batchNumber} needs ${remainingInBatch} recipient sends${noticeNeedsSend ? " plus one operator notice" : ""}. Wait for rolling headroom; partial batches are refused.`);
  }
  if (!["READY_FOR_APPROVAL", "APPROVED", "COMPLETED"].includes(batchRecord.release_state)) {
    throw new Error(`Batch ${batchNumber} is ${batchRecord.release_state ?? "uninitialized"}, not ready for approval.`);
  }
  if (batchRecord.release_state !== "COMPLETED") {
    await authorizeBatch(db, tableName, campaignId, manifest.approvalSha256, batchNumber, confirmation);
  } else {
    const nextBatch = manifest.batches.find((batch) => batch.batchNumber === batchNumber + 1) ?? null;
    const notice = await sendOperatorNotice({
      db,
      tableName,
      ses,
      configurationSet,
      manifest,
      batch: selectedBatch,
      state,
      nextBatch,
      operatorEmail,
      appUrl,
    });
    console.log(JSON.stringify({ complete: true, alreadyCompleted: true, state, operatorNotice: notice }, null, 2));
    return;
  }

  const configuredRate = Number(args.get("--max-recipients-per-second") ?? process.env.SES_BULK_MAX_RECIPIENTS_PER_SECOND ?? 13);
  if (!Number.isFinite(configuredRate) || configuredRate < 1) throw new Error("Maximum recipient rate must be at least 1.");
  const effectiveRate = Math.min(quota.maxRate * 0.9, configuredRate);
  if (effectiveRate < 1) throw new Error(`SES maximum send rate ${quota.maxRate} is too low.`);
  const batchSize = Math.min(25, Math.max(1, Math.floor(effectiveRate)));
  const intervalMs = Math.ceil((batchSize / effectiveRate) * 1_000) + 100;
  const leaseOwner = `ses-native:${process.env.GITHUB_RUN_ID ?? "local"}:${crypto.randomUUID()}`;
  await acquireLease(db, tableName, campaignId, manifest.approvalSha256, leaseOwner);

  let accepted = 0;
  let dead = 0;
  let retry = 0;
  let suppressed = 0;
  let batch = [];
  let requestCount = 0;
  const sendBatch = async (recipients) => {
    const durable = await batchReadStates(db, tableName, campaignId, recipients);
    const eligible = [];
    for (const recipient of recipients) {
      const hash = recipientHash(recipient.email);
      const previous = durable.get(`${campaignId}:${hash}`);
      const suppression = durable.get(`${SUPPRESSION_CAMPAIGN_ID}:${hash}`);
      if (isTerminalState(previous?.status)) continue;
      if (previous?.status === "CLAIMED") throw new Error(`Recipient ${recipient.email} entered ambiguous CLAIMED state. Stop and reconcile.`);
      if (suppression) {
        await cancelSuppressedRecipient(
          db,
          tableName,
          campaignId,
          batchNumber,
          manifest.approvalSha256,
          recipient,
          hash,
          previous,
          `Suppressed: ${suppression.reason ?? "global AWS suppression"}`,
        );
        suppressed += 1;
        continue;
      }
      const replacementData = compiled.replacementData(recipientData({
        to: recipient.email,
        toName: recipient.name,
        merge: recipient.merge,
      }, hash));
      eligible.push({ recipient, hash, previous, replacementData });
    }
    if (!eligible.length) return;
    const claimToken = crypto.randomUUID();
    const claimed = await claimBatch(db, tableName, campaignId, manifest.approvalSha256, batchNumber, eligible, claimToken);
    let response;
    try {
      response = await ses.send(new SendBulkEmailCommand({
        FromEmailAddress: manifest.campaign.fromAddress,
        ReplyToAddresses: manifest.campaign.replyTo ? [manifest.campaign.replyTo] : undefined,
        ConfigurationSetName: configurationSet,
        DefaultEmailTags: [
          { Name: "campaign_id", Value: campaignId },
          { Name: "manifest", Value: manifest.approvalSha256.slice(0, 16) },
        ],
        DefaultContent: {
          Template: {
            TemplateContent: compiled.content,
            TemplateData: "{}",
            Headers: manifest.campaign.replyTo ? [{ Name: "List-Unsubscribe", Value: `<mailto:${manifest.campaign.replyTo}?subject=Unsubscribe>` }] : undefined,
          },
        },
        BulkEmailEntries: claimed.map(({ recipient, hash, replacementData }) => {
          const unsubscribeUrl = oneClickUnsubscribeUrl({
            baseUrl: unsubscribeBaseUrl,
            secret: unsubscribeSecret,
            campaignId,
            email: recipient.email,
          });
          return {
            Destination: { ToAddresses: [recipient.email] },
            ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: JSON.stringify(replacementData) } },
            ReplacementHeaders: [
              { Name: "List-Unsubscribe", Value: `<${unsubscribeUrl}>` },
              { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
            ],
            ReplacementTags: [
              { Name: "campaign_id", Value: campaignId },
              { Name: "manifest", Value: manifest.approvalSha256.slice(0, 16) },
              { Name: "recipient_hash", Value: hash },
              { Name: "batch_number", Value: String(batchNumber) },
            ],
          };
        }),
      }));
    } catch (error) {
      throw new Error(`SES request failed after ${claimed.length} recipients were claimed. Their state is intentionally ambiguous; do not retry until reconciled. ${error.message}`);
    }
    if (response.BulkEmailEntryResults?.length !== claimed.length) throw new Error(`SES returned ${response.BulkEmailEntryResults?.length ?? 0}/${claimed.length} results. Claimed rows require reconciliation.`);
    const results = claimed.map((entry, index) => ({
      ...entry,
      ...classifyNativeSesResult(response.BulkEmailEntryResults[index], entry.attempts, MAX_ATTEMPTS),
    }));
    await checkpointBatch(db, tableName, campaignId, batchNumber, claimToken, results);
    accepted += results.filter((result) => result.status === "ACCEPTED").length;
    dead += results.filter((result) => result.status === "DEAD").length;
    retry += results.filter((result) => result.status === "RETRY").length;
    requestCount += 1;
    console.log(`request=${requestCount} batch=${claimed.length} accepted=${accepted} retry=${retry} dead=${dead} suppressed=${suppressed}`);
    await renewLease(db, tableName, campaignId, leaseOwner);
    await sleep(intervalMs);
  };

  try {
    for await (const recipient of recipientLines(recipientPath)) {
      if (recipient.ordinal < selectedBatch.startOrdinal) continue;
      if (recipient.ordinal >= selectedBatch.endOrdinal) break;
      batch.push(recipient);
      if (batch.length >= batchSize) {
        await sendBatch(batch);
        batch = [];
      }
    }
    if (batch.length) await sendBatch(batch);
  } finally {
    await releaseLease(db, tableName, campaignId, leaseOwner);
  }

  const finalRecord = await getControlRecord(db, tableName, campaignId, batchRecordKey(batchNumber));
  const finalState = summarizeBatchRecord(finalRecord);
  const complete = terminalCount(finalState) === selectedBatch.count
    && finalState.claimed === 0
    && finalState.retry === 0;
  let operatorNotice = null;
  if (complete) {
    const nextBatch = manifest.batches.find((candidate) => candidate.batchNumber === batchNumber + 1) ?? null;
    await completeBatchAndPromoteNext(
      db,
      tableName,
      campaignId,
      manifest.approvalSha256,
      selectedBatch,
      finalState,
      nextBatch,
    );
    operatorNotice = await sendOperatorNotice({
      db,
      tableName,
      ses,
      configurationSet,
      manifest,
      batch: selectedBatch,
      state: finalState,
      nextBatch,
      operatorEmail,
      appUrl,
    });
  }
  console.log(JSON.stringify({
    complete,
    batchNumber,
    acceptedThisRun: accepted,
    suppressedThisRun: suppressed,
    finalState,
    operatorNotice,
  }, null, 2));
  if (!complete) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
