import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";
import pg from "pg";
import QueryStream from "pg-query-stream";

const TERMINAL_QUEUE_STATUSES = ["succeeded", "failed", "dead", "canceled"];
const ARCHIVE_ROOT = path.resolve("local-database-archives");
const BATCH_SIZE = 2_000;
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : true];
}));
const command = process.argv[2]?.startsWith("--") ? "archive" : (process.argv[2] ?? "archive");

function usage() {
  process.stdout.write(`Usage:
  node scripts/archive-database-history.mjs archive [--archive-dir=<path>]
  node scripts/archive-database-history.mjs verify --archive-dir=<path>
  node scripts/archive-database-history.mjs reconcile --archive-dir=<path>
  node scripts/archive-database-history.mjs purge --archive-dir=<path> --confirm=PURGE_VERIFIED_HISTORY

Archive and verify production history before using purge. Archive files contain
recipient data and must remain under the gitignored local-database-archives/ path.
`);
}

function poolerConnectionString() {
  const configured = process.env.SUPABASE_DB_POOLER_CONNECTION;
  if (configured) return configured;
  const direct = new URL(process.env.SUPABASE_DB_CONNECTION ?? "");
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!direct.password || !ref) throw new Error("Missing SUPABASE_DB_CONNECTION or SUPABASE_PROJECT_REF");
  const host = process.env.SUPABASE_DB_POOLER_HOST ?? "aws-1-us-east-2.pooler.supabase.com";
  const port = process.env.SUPABASE_DB_POOLER_PORT ?? "6543";
  return `postgresql://postgres.${ref}:${encodeURIComponent(decodeURIComponent(direct.password))}@${host}:${port}/postgres`;
}

function client() {
  return new pg.Client({
    connectionString: poolerConnectionString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
    statement_timeout: 120_000,
  });
}

function archiveSpecs(cutoff) {
  return [
    { table: "mail_queue", order: "created_at, id", where: "updated_at < $1 and status = any($2::text[])", values: [cutoff, TERMINAL_QUEUE_STATUSES] },
    { table: "provider_events", order: "received_at, id", where: "received_at < $1", values: [cutoff] },
    { table: "error_logs", order: "created_at, id", where: "created_at < $1", values: [cutoff] },
    { table: "queue_metrics", order: "last_run_at, id", where: "last_run_at < $1", values: [cutoff] },
    { table: "audit_logs", order: "created_at, id", where: "created_at < $1", values: [cutoff] },
    { table: "admin_audit", order: "created_at, id", where: "created_at < $1", values: [cutoff] },
    { table: "draft_snapshots", order: "created_at, id", where: "created_at < $1", values: [cutoff] },
  ];
}

async function exportSpec(db, dir, spec) {
  const file = path.join(dir, `${spec.table}.ndjson.gz`);
  const hash = createHash("sha256");
  let rows = 0;
  let uncompressedBytes = 0;
  const query = new QueryStream(
    `select * from public.${spec.table} where ${spec.where} order by ${spec.order}`,
    spec.values,
    { batchSize: BATCH_SIZE },
  );
  const source = db.query(query);
  const serialize = new Transform({
    objectMode: true,
    transform(row, _encoding, callback) {
      const line = `${JSON.stringify(row)}\n`;
      rows += 1;
      uncompressedBytes += Buffer.byteLength(line);
      hash.update(line);
      callback(null, line);
    },
  });
  await pipeline(source, serialize, createGzip({ level: 9 }), createWriteStream(file, { flags: "wx", mode: 0o600 }));
  return {
    table: spec.table,
    file: path.basename(file),
    rows,
    uncompressedBytes,
    compressedBytes: (await stat(file)).size,
    sha256: hash.digest("hex"),
    predicate: spec.where,
  };
}

async function verifyEntry(dir, entry) {
  const hash = createHash("sha256");
  let rows = 0;
  let carry = "";
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      const text = carry + chunk.toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      rows += lines.length;
      callback();
    },
    flush(callback) {
      if (carry.length) rows += 1;
      callback();
    },
  });
  await pipeline(createReadStream(path.join(dir, entry.file)), createGunzip(), verifier);
  return rows === entry.rows && hash.digest("hex") === entry.sha256;
}

async function inspectExistingFile(file) {
  const hash = createHash("sha256");
  let rows = 0;
  let uncompressedBytes = 0;
  let carry = "";
  const inspector = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      uncompressedBytes += chunk.length;
      const text = carry + chunk.toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      rows += lines.length;
      callback();
    },
    flush(callback) {
      if (carry.length) rows += 1;
      callback();
    },
  });
  await pipeline(createReadStream(file), createGunzip(), inspector);
  return { rows, uncompressedBytes, sha256: hash.digest("hex") };
}

async function sourceCount(db, spec) {
  const result = await db.query(`select count(*)::bigint as rows from public.${spec.table} where ${spec.where}`, spec.values);
  return Number(result.rows[0].rows);
}

async function archive() {
  const cutoff = new Date().toISOString();
  const stamp = cutoff.replace(/[:.]/g, "-");
  const requestedDir = args.get("archive-dir");
  const dir = requestedDir ? path.resolve(String(requestedDir)) : path.join(ARCHIVE_ROOT, stamp);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const priorManifestPath = path.join(dir, "manifest.partial.json");
  let effectiveCutoff = cutoff;
  try {
    effectiveCutoff = JSON.parse(await readFile(priorManifestPath, "utf8")).cutoff;
  } catch {}
  await writeFile(priorManifestPath, `${JSON.stringify({ cutoff: effectiveCutoff }, null, 2)}\n`, { mode: 0o600 });
  const db = client();
  await db.connect();
  const entries = [];
  try {
    for (const spec of archiveSpecs(effectiveCutoff)) {
      process.stdout.write(`Exporting ${spec.table}...\n`);
      const file = path.join(dir, `${spec.table}.ndjson.gz`);
      try {
        const existing = await inspectExistingFile(file);
        const expectedRows = await sourceCount(db, spec);
        if (existing.rows === expectedRows) {
          entries.push({
            table: spec.table,
            file: path.basename(file),
            ...existing,
            compressedBytes: (await stat(file)).size,
            predicate: spec.where,
          });
          process.stdout.write(`  reused verified ${existing.rows.toLocaleString()} rows\n`);
          continue;
        }
        process.stdout.write(`  replacing incomplete ${existing.rows.toLocaleString()}/${expectedRows.toLocaleString()} row file\n`);
        await unlink(file);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          process.stdout.write(`  replacing unreadable partial file: ${error.message}\n`);
          await unlink(file).catch(() => undefined);
        }
      }
      entries.push(await exportSpec(db, dir, spec));
      process.stdout.write(`  ${entries.at(-1).rows.toLocaleString()} rows\n`);
    }
  } finally {
    await db.end();
  }
  const manifest = {
    format: "props-mailer-database-archive-v1",
    projectRef: process.env.SUPABASE_PROJECT_REF,
    createdAt: new Date().toISOString(),
    cutoff: effectiveCutoff,
    terminalQueueStatuses: TERMINAL_QUEUE_STATUSES,
    verified: false,
    entries,
  };
  for (const entry of entries) {
    if (!await verifyEntry(dir, entry)) throw new Error(`Verification failed for ${entry.table}`);
  }
  manifest.verified = true;
  manifest.verifiedAt = new Date().toISOString();
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${dir}\n`);
}

async function applyMigration(db) {
  const sql = await readFile(path.resolve("supabase/migrations/20260810_compact_history_rollups.sql"), "utf8");
  await db.query({ text: sql, queryMode: "simple" });
}

async function batchDelete(db, label, sql, values) {
  let total = 0;
  while (true) {
    const result = await db.query(sql, values);
    const removed = result.rowCount ?? 0;
    total += removed;
    if (removed === 0) break;
    if (total % 20_000 === 0 || removed < 5_000) process.stdout.write(`${label}: ${total.toLocaleString()} deleted\n`);
  }
  return total;
}

async function purge() {
  const dirArg = args.get("archive-dir");
  if (!dirArg || args.get("confirm") !== "PURGE_VERIFIED_HISTORY") {
    throw new Error("Use purge --archive-dir=<verified archive> --confirm=PURGE_VERIFIED_HISTORY");
  }
  const dir = path.resolve(String(dirArg));
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  if (!manifest.verified) throw new Error("Archive manifest is not verified");
  for (const entry of manifest.entries) {
    if (!await verifyEntry(dir, entry)) throw new Error(`Archive no longer verifies: ${entry.table}`);
  }
  const db = client();
  await db.connect();
  try {
    await applyMigration(db);
    await db.query("select public.refresh_email_history_rollups($1::timestamptz)", [manifest.cutoff]);
    const cutoff = manifest.cutoff;
    const deleted = {};
    deleted.mail_queue = await batchDelete(db, "mail_queue", `with doomed as (select ctid from public.mail_queue where updated_at < $1 and status = any($2::text[]) limit 5000) delete from public.mail_queue t using doomed where t.ctid = doomed.ctid`, [cutoff, manifest.terminalQueueStatuses]);
    deleted.provider_events = await batchDelete(db, "provider_events", `with doomed as (select ctid from public.provider_events where received_at < $1 and event_type not in ('bounced','complained') limit 5000) delete from public.provider_events t using doomed where t.ctid = doomed.ctid`, [cutoff]);
    deleted.error_logs = await batchDelete(db, "error_logs", `with doomed as (select ctid from public.error_logs where created_at < $1 and source = 'ses-webhook' limit 5000) delete from public.error_logs t using doomed where t.ctid = doomed.ctid`, [cutoff]);
    deleted.queue_metrics = await batchDelete(db, "queue_metrics", `with doomed as (select ctid from public.queue_metrics where last_run_at < $1 limit 5000) delete from public.queue_metrics t using doomed where t.ctid = doomed.ctid`, [cutoff]);
    await writeFile(path.join(dir, "purge-result.json"), `${JSON.stringify({ completedAt: new Date().toISOString(), deleted }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(deleted, null, 2)}\n`);
  } finally {
    await db.end();
  }
}

async function verify() {
  const dirArg = args.get("archive-dir");
  if (!dirArg) throw new Error("Use verify --archive-dir=<verified archive>");
  const dir = path.resolve(String(dirArg));
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  if (!manifest.verified) throw new Error("Archive manifest is not marked verified");
  for (const entry of manifest.entries) {
    if (!await verifyEntry(dir, entry)) throw new Error(`Verification failed for ${entry.table}`);
  }
  process.stdout.write(`${JSON.stringify({
    verified: true,
    cutoff: manifest.cutoff,
    rows: manifest.entries.reduce((total, entry) => total + entry.rows, 0),
    files: manifest.entries.length,
  }, null, 2)}\n`);
}

async function readNdjsonGzip(file, onRow) {
  const input = createReadStream(file).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) await onRow(JSON.parse(line));
  }
}

function emptyEventAggregate() {
  return {
    counts: { delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0 },
    unique: {
      delivered: new Set(), bounced: new Set(), complained: new Set(), opened: new Set(), clicked: new Set(),
    },
    firstEventAt: null,
    latestEventAt: null,
  };
}

async function reconcile() {
  const dirArg = args.get("archive-dir");
  if (!dirArg) throw new Error("Use reconcile --archive-dir=<verified archive>");
  const dir = path.resolve(String(dirArg));
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  if (!manifest.verified) throw new Error("Archive manifest is not verified");
  for (const entry of manifest.entries) {
    if (!await verifyEntry(dir, entry)) throw new Error(`Archive no longer verifies: ${entry.table}`);
  }

  const messageToEmail = new Map();
  await readNdjsonGzip(path.join(dir, "mail_queue.ndjson.gz"), (row) => {
    if (!row.email_id) return;
    messageToEmail.set(row.id, row.email_id);
    if (row.ses_message_id) messageToEmail.set(row.ses_message_id, row.email_id);
  });

  const aggregates = new Map();
  let unresolved = 0;
  await readNdjsonGzip(path.join(dir, "provider_events.ndjson.gz"), (row) => {
    const emailId = row.email_id ?? messageToEmail.get(row.message_id);
    if (!emailId) {
      unresolved += 1;
      return;
    }
    const aggregate = aggregates.get(emailId) ?? emptyEventAggregate();
    aggregates.set(emailId, aggregate);
    if (row.event_type in aggregate.counts) {
      aggregate.counts[row.event_type] += 1;
      if (row.recipient) aggregate.unique[row.event_type].add(String(row.recipient).toLowerCase());
    }
    if (!aggregate.firstEventAt || row.received_at < aggregate.firstEventAt) aggregate.firstEventAt = row.received_at;
    if (!aggregate.latestEventAt || row.received_at > aggregate.latestEventAt) aggregate.latestEventAt = row.received_at;
  });

  const db = client();
  await db.connect();
  try {
    for (const [emailId, aggregate] of aggregates) {
      await db.query(`
        update public.email_history_rollups set
          delivered_unique = $2, bounced_unique = $3, complained_unique = $4,
          opened_unique = $5, clicked_unique = $6,
          delivery_events = $7, bounce_events = $8, complaint_events = $9,
          open_events = $10, click_events = $11,
          first_event_at = $12, latest_event_at = $13, updated_at = now()
        where email_id = $1
      `, [
        emailId,
        aggregate.unique.delivered.size,
        aggregate.unique.bounced.size,
        aggregate.unique.complained.size,
        aggregate.unique.opened.size,
        aggregate.unique.clicked.size,
        aggregate.counts.delivered,
        aggregate.counts.bounced,
        aggregate.counts.complained,
        aggregate.counts.opened,
        aggregate.counts.clicked,
        aggregate.firstEventAt,
        aggregate.latestEventAt,
      ]);
    }
  } finally {
    await db.end();
  }
  process.stdout.write(`${JSON.stringify({ campaigns: aggregates.size, messageKeys: messageToEmail.size, unresolvedEvents: unresolved }, null, 2)}\n`);
}

if (args.has("help") || command === "help") usage();
else if (command === "archive") await archive();
else if (command === "verify") await verify();
else if (command === "purge") await purge();
else if (command === "reconcile") await reconcile();
else throw new Error(`Unknown command: ${command}`);
