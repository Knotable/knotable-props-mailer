import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const SOURCE_EMAIL_ID = "e1c5bbd1-5f25-44fc-83db-9a024dc1f165";
const BIG_LIST_ID = "dbd52a08-9a38-4573-bf06-09e401015ae9";
const QUEUE_HOLD_AT = "2999-12-31T23:59:59.000Z";
const PAGE_SIZE = 1000;
const UPSERT_CHUNK_SIZE = 500;
const DEFAULT_DAILY_LIMIT = 65400;

function loadDotEnvLocal() {
  const path = ".env.local";
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function csvCell(value) {
  const stringValue = value == null ? "" : String(value);
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function memberToName(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  for (const key of ["toName", "display_name", "displayName"]) {
    if (typeof metadata[key] === "string" && metadata[key].trim()) return metadata[key].trim();
  }
  const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const rank =
    typeof metadata.rank === "number" || typeof metadata.rank === "string"
      ? String(metadata.rank).trim()
      : "";
  if (name && rank) return `${name} #${rank}`;
  return name || undefined;
}

function dedupeHash(emailId, recipientEmail) {
  return createHash("sha256")
    .update(`${emailId}:${recipientEmail.toLowerCase().trim()}`)
    .digest("hex");
}

function textFromHtml(html) {
  return html.replace(/<[^>]+>/g, " ");
}

function buildSchedule(total, alreadySentToday, startDate, dailyLimit) {
  const schedule = [];
  let remaining = total;
  const date = new Date(`${startDate}T00:00:00Z`);
  const firstSlot = Math.min(remaining, Math.max(0, dailyLimit - alreadySentToday));
  if (firstSlot > 0) {
    schedule.push({ date: startDate, count: firstSlot });
    remaining -= firstSlot;
  }
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const count = Math.min(remaining, dailyLimit);
    schedule.push({ date: date.toISOString().slice(0, 10), count });
    remaining -= count;
  }
  return schedule;
}

async function countActiveMembers(supabase, listId) {
  const { count, error } = await supabase
    .from("list_members")
    .select("id", { count: "exact", head: true })
    .eq("list_id", listId)
    .eq("status", "active");
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  loadDotEnvLocal();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const runId = `${today}-${now.toISOString().replace(/[:.]/g, "-")}`;
  const logDir = join("private", "send-logs", runId);
  mkdirSync(logDir, { recursive: true });

  const [{ data: sourceEmail, error: sourceError }, { data: list, error: listError }] =
    await Promise.all([
      supabase
        .from("emails")
        .select("author_id, from_address, subject, html, text, campaigns, tags")
        .eq("id", SOURCE_EMAIL_ID)
        .single(),
      supabase
        .from("lists")
        .select("id, name, address")
        .eq("id", BIG_LIST_ID)
        .single(),
    ]);
  if (sourceError) throw sourceError;
  if (listError) throw listError;

  const totalActiveMembers = await countActiveMembers(supabase, BIG_LIST_ID);
  if (totalActiveMembers === 0) throw new Error("Big list has no active members");

  const { count: sentTodayCount, error: sentTodayError } = await supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("send_date", today)
    .eq("status", "succeeded");
  if (sentTodayError) throw sentTodayError;

  const schedule = buildSchedule(
    totalActiveMembers,
    sentTodayCount ?? 0,
    today,
    DEFAULT_DAILY_LIMIT,
  );

  const { data: clonedEmail, error: cloneError } = await supabase
    .from("emails")
    .insert({
      author_id: sourceEmail.author_id,
      from_address: sourceEmail.from_address,
      subject: sourceEmail.subject,
      html: sourceEmail.html,
      text: sourceEmail.text ?? textFromHtml(sourceEmail.html),
      status: "draft",
      scheduled_at: null,
      campaigns: [...(sourceEmail.campaigns ?? []), `big-list-${today}`],
      tags: [...(sourceEmail.tags ?? []), "big-list", "manual-held"],
    })
    .select("id")
    .single();
  if (cloneError) throw cloneError;

  const emailId = clonedEmail.id;
  const campaignLabel = `${emailId}:${today}`;

  const { error: recipientError } = await supabase.from("email_recipients").insert({
    email_id: emailId,
    recipient_address: list.address,
  });
  if (recipientError) throw recipientError;

  const recipientCsv = createWriteStream(join(logDir, "recipients.csv"));
  const chunkLog = createWriteStream(join(logDir, "queue-chunks.ndjson"));
  recipientCsv.write("email,toName,member_id,metadata\n");

  let queued = 0;
  let offset = 0;

  while (offset < totalActiveMembers) {
    const { data: members, error: memberError } = await supabase
      .from("list_members")
      .select("id,email,metadata")
      .eq("list_id", BIG_LIST_ID)
      .eq("status", "active")
      .order("email", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (memberError) throw memberError;
    if (!members || members.length === 0) break;

    const rows = members.map((member) => {
      const toName = memberToName(member.metadata);
      recipientCsv.write(
        [
          csvCell(member.email),
          csvCell(toName),
          csvCell(member.id),
          csvCell(JSON.stringify(member.metadata ?? {})),
        ].join(",") + "\n",
      );
      return {
        email_id: emailId,
        list_id: BIG_LIST_ID,
        payload: {
          to: member.email,
          toName,
          tags: [...(sourceEmail.tags ?? []), "big-list", "manual-held"],
          campaigns: [...(sourceEmail.campaigns ?? []), `big-list-${today}`],
        },
        status: "pending",
        available_at: QUEUE_HOLD_AT,
        send_date: null,
        campaign_label: campaignLabel,
        dedupe_hash: dedupeHash(emailId, member.email),
      };
    });

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
      const { error: insertError } = await supabase
        .from("mail_queue")
        .insert(chunk);
      if (insertError) throw insertError;
      queued += chunk.length;
      chunkLog.write(
        JSON.stringify({
          at: new Date().toISOString(),
          offset,
          chunkStart: i,
          chunkSize: chunk.length,
          queuedSoFar: queued,
        }) + "\n",
      );
    }

    offset += members.length;
    console.log(`prepared ${queued}/${totalActiveMembers}`);
  }

  recipientCsv.end();
  chunkLog.end();

  const { error: queuedError } = await supabase
    .from("emails")
    .update({ status: "queued" })
    .eq("id", emailId);
  if (queuedError) throw queuedError;

  const [{ count: heldCount }, { count: dueCount }, { count: totalQueueCount }] = await Promise.all([
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", emailId)
      .eq("status", "pending")
      .gt("available_at", now.toISOString()),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", emailId)
      .eq("status", "pending")
      .lte("available_at", now.toISOString()),
    supabase
      .from("mail_queue")
      .select("id", { count: "exact", head: true })
      .eq("email_id", emailId),
  ]);

  const summary = {
    preparedAt: now.toISOString(),
    sourceEmailId: SOURCE_EMAIL_ID,
    queuedEmailId: emailId,
    subject: sourceEmail.subject,
    from: sourceEmail.from_address,
    list,
    totalActiveMembers,
    queuedRowsWritten: queued,
    verifiedTotalQueueRows: totalQueueCount ?? null,
    verifiedHeldPendingRows: heldCount ?? null,
    verifiedDuePendingRows: dueCount ?? null,
    holdUntil: QUEUE_HOLD_AT,
    sentTodayBeforePreparation: sentTodayCount ?? 0,
    assumedDailyLimit: DEFAULT_DAILY_LIMIT,
    plannedReleaseSchedule: schedule,
    logDir,
  };

  writeFileSync(join(logDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
