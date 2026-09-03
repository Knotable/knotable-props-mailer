#!/usr/bin/env node
import crypto from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createGzip } from "node:zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { assertSendReadySubject, compileTemplate, recipientData } from "./lib/ses-bulk-worker-core.mjs";
import { campaignApprovalDigest, normalizeEmail, recipientHash, validateRecipient } from "./lib/ses-native-core.mjs";

const PAGE_SIZE = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  return values;
}

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function required(name, fallback) {
  const value = process.env[name] || (fallback ? process.env[fallback] : undefined);
  if (!value) throw new Error(`Missing ${name}${fallback ? ` (or ${fallback})` : ""}`);
  return value;
}

function memberName(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  for (const key of ["toName", "display_name", "displayName", "full_name", "fullName", "name"]) {
    if (typeof metadata[key] === "string" && metadata[key].trim()) return metadata[key].trim();
  }
  return undefined;
}

function mergeData(metadata, name) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return name ? { name } : {};
  const direct = metadata.merge && typeof metadata.merge === "object" && !Array.isArray(metadata.merge) ? metadata.merge : null;
  const legacy = metadata.merge_data && typeof metadata.merge_data === "object" && !Array.isArray(metadata.merge_data) ? metadata.merge_data : null;
  const source = direct ?? legacy ?? {};
  const merge = Object.fromEntries(Object.entries(source).flatMap(([key, value]) => {
    if (!key.trim() || !["string", "number", "boolean"].includes(typeof value)) return [];
    const text = String(value).trim();
    return text ? [[key, text]] : [];
  }));
  if (name && !merge.name) merge.name = name;
  const firstName = typeof metadata.first_name === "string"
    ? metadata.first_name.trim()
    : typeof metadata.firstName === "string"
      ? metadata.firstName.trim()
      : "";
  if (firstName && !merge.first_name) merge.first_name = firstName;
  return merge;
}

async function writeLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

async function sha256File(path) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function uploadFile(s3, bucket, key, path, contentType, contentEncoding) {
  return s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(path),
    ContentType: contentType,
    ContentEncoding: contentEncoding,
    ServerSideEncryption: "AES256",
  }));
}

async function main() {
  loadDotEnvLocal();
  const args = parseArgs(process.argv);
  const emailId = args.get("--email-id");
  const listIds = String(args.get("--list-ids") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const upload = args.get("--upload") === "true";
  if (!emailId || !UUID.test(emailId)) throw new Error("--email-id must be a UUID.");
  if (!listIds.length || listIds.some((id) => !UUID.test(id))) throw new Error("--list-ids must be a comma-separated list of UUIDs.");
  if (upload && args.get("--confirmation") !== `snapshot:${emailId}`) throw new Error(`Upload requires --confirmation snapshot:${emailId}.`);

  const supabase = createClient(required("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const [{ data: email, error: emailError }, { data: lists, error: listsError }] = await Promise.all([
    supabase.from("emails").select("id, from_address, reply_to, subject, html, text, status, tags, campaigns").eq("id", emailId).single(),
    supabase.from("lists").select("id, name, address").in("id", listIds),
  ]);
  if (emailError) throw new Error(`Unable to load campaign: ${emailError.message}`);
  if (listsError) throw new Error(`Unable to load lists: ${listsError.message}`);
  if ((lists ?? []).length !== listIds.length) throw new Error(`Resolved ${(lists ?? []).length}/${listIds.length} requested lists.`);
  assertSendReadySubject(email.subject);
  if (!["draft", "queued"].includes(email.status)) throw new Error(`Campaign status ${email.status} is not eligible for a new immutable snapshot.`);

  const outputRoot = resolve(args.get("--output-dir") ?? "private/ses-native-campaigns");
  const stagingDir = join(outputRoot, emailId, ".staging");
  mkdirSync(stagingDir, { recursive: true });
  const stagingRecipientsPath = join(stagingDir, "recipients.ndjson.gz");
  const output = createWriteStream(stagingRecipientsPath, { flags: "w" });
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);

  const seen = new Map();
  const countsByList = {};
  let duplicateMemberships = 0;
  let total = 0;
  const compiled = compileTemplate({ subject: email.subject, html: email.html, text: email.text });
  for (const listId of listIds) {
    let offset = 0;
    let active = 0;
    while (true) {
      const { data: members, error } = await supabase
        .from("list_members")
        .select("email, metadata")
        .eq("list_id", listId)
        .eq("status", "active")
        .order("email", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(`Unable to load list ${listId} at offset ${offset}: ${error.message}`);
      if (!members?.length) break;
      for (const member of members) {
        active += 1;
        const normalized = normalizeEmail(member.email);
        const existing = seen.get(normalized);
        if (existing) {
          existing.sourceListIds.push(listId);
          duplicateMemberships += 1;
          continue;
        }
        const name = memberName(member.metadata);
        const recipient = validateRecipient({ email: normalized, name, merge: mergeData(member.metadata, name), sourceListIds: [listId] });
        compiled.replacementData(recipientData({ to: recipient.email, toName: recipient.name, merge: recipient.merge }, recipientHash(recipient.email)));
        seen.set(normalized, recipient);
      }
      offset += members.length;
      if (members.length < PAGE_SIZE) break;
    }
    countsByList[listId] = active;
  }

  for (const recipient of seen.values()) {
    await writeLine(gzip, recipient);
    total += 1;
  }
  gzip.end();
  await once(output, "close");
  if (total === 0) throw new Error("The selected lists produced no active recipients.");

  const recipientSha256 = await sha256File(stagingRecipientsPath);
  const recipientKey = `campaigns/${emailId}/recipients/${recipientSha256}.ndjson.gz`;
  let manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source: { kind: "supabase-read-only-snapshot", emailId, listIds, lists, countsByList, duplicateMemberships },
    campaign: {
      id: email.id,
      fromAddress: email.from_address,
      replyTo: email.reply_to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      tags: email.tags ?? [],
      campaigns: email.campaigns ?? [],
    },
    recipients: { count: total, key: recipientKey, sha256: recipientSha256 },
  };
  manifest.approvalSha256 = campaignApprovalDigest(manifest);
  const manifestKey = `campaigns/${emailId}/${manifest.approvalSha256}/campaign.json`;
  const artifactDir = join(outputRoot, emailId, manifest.approvalSha256.slice(0, 16));
  mkdirSync(artifactDir, { recursive: true });
  const recipientsPath = join(artifactDir, "recipients.ndjson.gz");
  renameSync(stagingRecipientsPath, recipientsPath);
  const manifestPath = join(artifactDir, "campaign.json");
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
    const sameArtifact = existing?.campaign?.id === manifest.campaign.id
      && existing?.recipients?.sha256 === manifest.recipients.sha256
      && existing?.recipients?.count === manifest.recipients.count
      && JSON.stringify(existing?.campaign) === JSON.stringify(manifest.campaign);
    if (!sameArtifact) throw new Error(`Refusing to overwrite a different immutable campaign package at ${manifestPath}.`);
    manifest = existing;
  } else {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  }

  let bucket = null;
  if (upload) {
    bucket = required("SES_CAMPAIGN_BUCKET");
    const s3 = new S3Client({ region: required("AWS_REGION") });
    await uploadFile(s3, bucket, recipientKey, recipientsPath, "application/x-ndjson", "gzip");
    await uploadFile(s3, bucket, manifestKey, manifestPath, "application/json");
  }
  console.log(JSON.stringify({
    campaignId: emailId,
    subject: email.subject,
    lists: lists.map(({ id, name }) => ({ id, name })),
    uniqueRecipients: total,
    duplicateMembershipsCollapsed: duplicateMemberships,
    recipientSha256,
    artifactDir,
    uploaded: upload,
    bucket,
    manifestKey,
    next: upload ? `Run a dry-run with --campaign-id ${emailId} --manifest-key ${manifestKey}.` : `Review locally, then rerun with --upload true --confirmation snapshot:${emailId}.`,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
