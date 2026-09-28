// In-memory stand-in for the slice of Supabase PostgREST and SES v2 the bulk
// worker uses, so the real worker script can be exercised end to end.
import http from "node:http";
import crypto from "node:crypto";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

function readPath(row, column) {
  const [base, ...path] = column.split(/->>?/);
  let value = row[base];
  for (const key of path) value = value && typeof value === "object" ? value[key] : undefined;
  return path.length && value !== undefined && value !== null ? String(value) : value;
}

function compare(a, b) {
  if (typeof a === "string" && typeof b === "string" && ISO_RE.test(a) && ISO_RE.test(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" || typeof b === "number") return Number(a) - Number(b);
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function parseInList(raw) {
  return raw.replace(/^\(|\)$/g, "").split(",").map((value) => value.replace(/^"|"$/g, ""));
}

function matches(row, column, expression) {
  const dot = expression.indexOf(".");
  const op = expression.slice(0, dot);
  const raw = expression.slice(dot + 1);
  const value = readPath(row, column);
  switch (op) {
    case "eq": return value !== undefined && value !== null && String(value) === raw;
    case "neq": return String(value) !== raw;
    case "lt": return value != null && compare(value, raw) < 0;
    case "lte": return value != null && compare(value, raw) <= 0;
    case "gt": return value != null && compare(value, raw) > 0;
    case "gte": return value != null && compare(value, raw) >= 0;
    case "in": return parseInList(raw).includes(String(value));
    case "is": return raw === "null" ? value == null : String(value) === raw;
    case "like": {
      const pattern = new RegExp(`^${raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*")}$`);
      return pattern.test(String(value ?? ""));
    }
    default: throw new Error(`unsupported filter ${op}`);
  }
}

const RESERVED = new Set(["select", "order", "limit", "on_conflict", "columns", "offset"]);

export function createFakeBackend({ now = () => Date.now(), lenient = false } = {}) {
  const tables = { app_settings: [], emails: [], mail_queue: [], list_members: [], provider_events: [] };
  // Extra RPCs for running the Next.js app against this fake (lenient mode).
  const rpcHandlers = {
    get_mailer_runtime_limits: () => {
      const dayMs = 24 * 3_600_000;
      const succeeded = tables.mail_queue.filter((row) => row.status === "succeeded");
      const recent = succeeded.filter((row) => Date.parse(row.updated_at ?? 0) > now() - dayMs).length;
      return [{ daily_cap: 65_400, ses_max_send_rate_per_second: 15, rolling_24h_sent: recent, accepted_today_utc: recent, sent_last_7_days: succeeded.length }];
    },
    get_global_active_queue_summary: (args) => {
      const rows = summaries([...new Set(tables.mail_queue.map((row) => row.email_id))], args.p_now);
      return [rows.reduce((total, row) => ({
        pending_due: total.pending_due + row.pending_due,
        pending_held: total.pending_held + row.pending_held,
        processing: total.processing + row.processing,
      }), { pending_due: 0, pending_held: 0, processing: 0 })];
    },
  };
  const ses = {
    quota: { Max24HourSend: 65_400, MaxSendRate: 1_000, SentLast24Hours: 0 },
    sendingEnabled: true,
    bulkRequests: [],
    notices: [],
    throttleNext: 0,
    dropConnectionNext: 0,
    entryStatus: null,
    bounceEvery: 0,
    acceptedCount: 0,
  };
  const failures = { finalizeNext: 0 };

  function filterRows(table, params) {
    let rows = tables[table];
    for (const [column, expression] of params) {
      if (RESERVED.has(column)) continue;
      rows = rows.filter((row) => matches(row, column, expression));
    }
    return rows;
  }

  function project(rows, select) {
    if (!select || select === "*") return rows.map((row) => ({ ...row }));
    const columns = select.split(",").map((column) => column.trim());
    return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
  }

  function order(rows, spec) {
    if (!spec) return rows;
    const [column, direction] = spec.split(".");
    const sorted = [...rows].sort((a, b) => compare(a[column], b[column]));
    return direction === "desc" ? sorted.reverse() : sorted;
  }

  function summaries(emailIds, nowIso) {
    const byEmail = new Map();
    for (const row of tables.mail_queue) {
      if (!emailIds.includes(row.email_id)) continue;
      const summary = byEmail.get(row.email_id) ?? { email_id: row.email_id, list_id: null, pending_due: 0, pending_held: 0, processing: 0, succeeded: 0, failed: 0, dead: 0, canceled: 0, total: 0 };
      if (row.status === "pending") {
        if (compare(row.available_at, nowIso) <= 0) summary.pending_due += 1;
        else summary.pending_held += 1;
      } else summary[row.status] += 1;
      summary.total += 1;
      byEmail.set(row.email_id, summary);
    }
    return [...byEmail.values()];
  }

  function finalize({ p_email_id, p_worker_id, p_results, p_now }) {
    if (failures.finalizeNext > 0) {
      failures.finalizeNext -= 1;
      throw new Error("simulated finalize failure");
    }
    let applied = 0;
    for (const result of p_results) {
      const row = tables.mail_queue.find((candidate) => candidate.id === result.id && candidate.email_id === p_email_id);
      if (!row) continue;
      if (row.status === "processing" && row.correlation_id === p_worker_id) {
        row.status = { succeeded: "succeeded", retry: "pending", dead: "dead", canceled: "canceled" }[result.outcome];
        if (["retry", "dead"].includes(result.outcome)) row.attempts += 1;
        if (result.outcome === "succeeded") {
          row.ses_message_id = result.ses_message_id;
          row.send_date = p_now.slice(0, 10);
        }
        if (result.outcome === "retry") row.available_at = new Date(Date.parse(p_now) + row.attempts * 10 * 60_000).toISOString();
        row.locked_at = null;
        row.last_error = result.last_error || null;
        row.updated_at = p_now;
        applied += 1;
      } else if (result.outcome === "succeeded" && row.status === "succeeded" && row.ses_message_id === result.ses_message_id) {
        applied += 1;
      }
    }
    return applied;
  }

  async function body(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : null;
  }

  function send(response, status, payload, headers = {}) {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(payload === undefined ? "" : JSON.stringify(payload));
  }

  async function handleRest(request, response, url) {
    const params = [...url.searchParams.entries()];
    const get = (name) => url.searchParams.get(name);
    const prefer = request.headers.prefer ?? "";
    const wantsObject = (request.headers.accept ?? "").includes("vnd.pgrst.object");
    const path = url.pathname.replace(/^\/rest\/v1\//, "");

    if (path.startsWith("rpc/")) {
      const args = await body(request);
      const fn = path.slice(4);
      if (fn === "get_queue_campaign_summaries") return send(response, 200, summaries(args.p_email_ids, args.p_now));
      if (fn === "finalize_ses_bulk_queue_batch") {
        try {
          return send(response, 200, finalize(args));
        } catch (error) {
          return send(response, 500, { message: error.message });
        }
      }
      if (rpcHandlers[fn]) return send(response, 200, rpcHandlers[fn](args ?? {}));
      if (lenient) return send(response, 200, []);
      return send(response, 404, { message: `unknown rpc ${fn}` });
    }

    const table = path;
    if (!tables[table] && lenient) tables[table] = [];
    if (!tables[table]) return send(response, 404, { message: `unknown table ${table}` });

    if (request.method === "GET" || request.method === "HEAD") {
      const matched = order(filterRows(table, params), get("order"));
      let rows = matched;
      if (get("limit")) rows = rows.slice(0, Number(get("limit")));
      if (request.method === "HEAD" || prefer.includes("count=")) {
        response.setHeader("content-range", `0-${Math.max(0, rows.length - 1)}/${matched.length}`);
        if (request.method === "HEAD") return send(response, 200);
      }
      const projected = project(rows, get("select"));
      if (wantsObject) return projected.length === 1 ? send(response, 200, projected[0]) : send(response, 406, { code: "PGRST116", message: "not one row" });
      return send(response, 200, projected);
    }

    if (request.method === "PATCH") {
      const patch = await body(request);
      const rows = filterRows(table, params);
      for (const row of rows) Object.assign(row, structuredClone(patch));
      if (prefer.includes("return=representation")) return send(response, 200, project(rows, get("select")));
      return send(response, 204);
    }

    if (request.method === "POST") {
      const payload = await body(request);
      const incoming = Array.isArray(payload) ? payload : [payload];
      const conflict = get("on_conflict");
      const merge = prefer.includes("resolution=merge-duplicates");
      const ignore = prefer.includes("resolution=ignore-duplicates");
      const written = [];
      const uniqueKeys = { app_settings: ["key"], mail_queue: ["id", "dedupe_hash"] }[table] ?? ["id"];
      for (const raw of incoming) {
        const row = structuredClone(raw);
        const keys = conflict ? [conflict] : uniqueKeys;
        const existing = tables[table].find((candidate) => keys.some((key) => row[key] !== undefined && row[key] !== null && candidate[key] === row[key]));
        if (existing) {
          if (ignore) continue;
          if (!merge) return send(response, 409, { code: "23505", message: "duplicate key" });
          Object.assign(existing, row);
          written.push(existing);
        } else {
          if (table !== "app_settings" && !row.id) row.id = crypto.randomUUID();
          if (table === "mail_queue") {
            const stamp = new Date(now()).toISOString();
            for (const [column, value] of Object.entries({ attempts: 0, max_attempts: 5, locked_at: null, correlation_id: null, ses_message_id: null, last_error: null, created_at: stamp, updated_at: stamp })) {
              if (row[column] === undefined) row[column] = value;
            }
          }
          tables[table].push(row);
          written.push(row);
        }
      }
      if (prefer.includes("return=representation")) {
        const projected = project(written, get("select"));
        return send(response, 201, wantsObject ? projected[0] : projected);
      }
      return send(response, 201);
    }
    if (request.method === "DELETE") {
      const doomed = new Set(filterRows(table, params));
      tables[table] = tables[table].filter((row) => !doomed.has(row));
      if (prefer.includes("return=representation")) return send(response, 200, project([...doomed], get("select")));
      return send(response, 204);
    }
    return send(response, 405, { message: "method not allowed" });
  }

  async function handleSes(request, response, url) {
    if (request.method === "GET" && url.pathname === "/v2/email/account") {
      return send(response, 200, { SendQuota: ses.quota, SendingEnabled: ses.sendingEnabled, ProductionAccessEnabled: true });
    }
    if (request.method === "POST" && url.pathname === "/v2/email/outbound-bulk-emails") {
      const payload = await body(request);
      if (ses.dropConnectionNext > 0) {
        ses.dropConnectionNext -= 1;
        ses.bulkRequests.push({ ...payload, dropped: true });
        request.socket.destroy();
        return undefined;
      }
      if (ses.throttleNext > 0) {
        ses.throttleNext -= 1;
        return send(response, 400, { message: "Maximum sending rate exceeded." }, { "x-amzn-errortype": "TooManyRequestsException" });
      }
      ses.bulkRequests.push(payload);
      const results = payload.BulkEmailEntries.map((entry) => {
        if (ses.entryStatus) return { Status: ses.entryStatus };
        ses.quota.SentLast24Hours += 1;
        ses.acceptedCount += 1;
        const messageId = `ses-${crypto.randomUUID()}`;
        // Simulated SNS → webhook: a hard bounce for every Nth accepted recipient.
        if (ses.bounceEvery && ses.acceptedCount % ses.bounceEvery === 0) {
          tables.provider_events.push({
            id: crypto.randomUUID(),
            email_id: entry.ReplacementTags?.find((tag) => tag.Name === "campaign_id")?.Value ?? null,
            event_type: "bounced",
            message_id: messageId,
            payload: { bounce: { bounceType: "Permanent" } },
            received_at: new Date(now()).toISOString(),
          });
        }
        return { Status: "SUCCESS", MessageId: messageId };
      });
      return send(response, 200, { BulkEmailEntryResults: results });
    }
    if (request.method === "POST" && url.pathname === "/v2/email/outbound-emails") {
      ses.notices.push(await body(request));
      return send(response, 200, { MessageId: `notice-${crypto.randomUUID()}` });
    }
    return send(response, 404, { message: `unknown SES path ${url.pathname}` });
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/__state") return send(response, 200, { tables, ses });
      if (url.pathname.startsWith("/rest/v1/")) return await handleRest(request, response, url);
      if (url.pathname.startsWith("/v2/email/")) return await handleSes(request, response, url);
      send(response, 404, { message: "not found" });
    } catch (error) {
      send(response, 500, { message: String(error?.message ?? error) });
    }
  });

  return {
    tables,
    ses,
    failures,
    now,
    rpcHandlers,
    async start(port = 0) {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
