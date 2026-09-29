// /ai — the agent front door. Server-rendered, script-free HTML with stable
// ids and labeled forms; every page is also available as JSON via
// ?format=json (or Accept: application/json). State changes go through
// POST /ai/do/<action> (see src/lib/ai/actions.ts).
import { NextResponse } from "next/server";
import { getServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getMailerRuntimeLimits } from "@/lib/dailyQuota";
import { describeAutopilot, estimateSendDuration, getAutopilotRecord, getAutopilotRecords, listActiveAutopilotRecords } from "@/lib/sendAutopilot";
import { ACTION_SPECS, type ActionResult } from "@/lib/ai/actions";
import { dl, esc, form, link, page, table, type ActionSpec } from "@/lib/ai/html";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Auth = Awaited<ReturnType<typeof getServerAuthContext>>;
type View = { status?: number; title: string; html: string; data: Record<string, unknown>; actions?: ActionSpec[] };

const spec = (name: string, overrides: Partial<ActionSpec> = {}, values: Record<string, unknown> = {}): ActionSpec => {
  const base = ACTION_SPECS.find((candidate) => candidate.action === name)!;
  return {
    ...base,
    ...overrides,
    fields: (overrides.fields ?? base.fields).map((field) => (field.name in values ? { ...field, value: values[field.name] as string } : field)),
  };
};

type Summary = { pending_due: number; pending_held: number; processing: number; succeeded: number; failed: number; dead: number; canceled: number; total: number };
async function summaries(emailIds: string[]) {
  const map = new Map<string, Summary>();
  if (!emailIds.length) return map;
  const { data, error } = await getSupabaseAdmin().rpc("get_queue_campaign_summaries", { p_email_ids: emailIds, p_now: new Date().toISOString() });
  if (error) throw error;
  for (const row of (data ?? []) as Array<Summary & { email_id: string }>) {
    const current = map.get(row.email_id) ?? { pending_due: 0, pending_held: 0, processing: 0, succeeded: 0, failed: 0, dead: 0, canceled: 0, total: 0 };
    for (const key of Object.keys(current) as (keyof Summary)[]) current[key] += Number(row[key] ?? 0);
    map.set(row.email_id, current);
  }
  return map;
}

function indexView(auth: Auth): View {
  const routes: [string, string][] = [
    ["GET /ai", "This catalog."],
    ["GET /ai/login", "Sign-in forms (password or bypass)."],
    ["GET /ai/status", "SES quota, send rate, and the autopilot queue."],
    ["GET /ai/campaigns?status=draft|queued|sending|sent|all&q=text&limit=50", "Campaign list with unsent counts and autopilot state."],
    ["GET /ai/campaigns/new", "Form to create a draft."],
    ["GET /ai/campaigns/{id}", "Campaign detail and every action valid for its state."],
    ["GET /ai/campaigns/{id}/log", "Latest 50 recipient status changes."],
    ["GET /ai/campaigns/{id}/analytics", "Accepted, delivered, bounced, complained, opened, clicked."],
    ["GET /api/email/preview/{id}", "Rendered HTML of the email (human-style preview)."],
    ["GET /ai/lists", "Lists with active member counts."],
    ["GET /ai/lists/{id}?q=text&status=active|unsubscribed|blocked&page=0", "Members (100 per page), import and suppress forms."],
  ];
  const actions = ACTION_SPECS.map((action) => [
    action.action,
    `POST /ai/do/${action.action}`,
    action.fields.filter((field) => field.name !== "return_to").map((field) => `${field.name}${field.required ? "*" : ""}`).join(", "),
    action.description,
  ]);
  const html = `
<p id="purpose">Agent interface for Props Mailer: everything the human web app does, without its UI. Pages are plain HTML with stable element ids; append <code>?format=json</code> to any GET for structured data. Actions are form POSTs to <code>/ai/do/{action}</code> (form-encoded; add <code>format=json</code> for a JSON reply instead of a 303 redirect). Results appear in <code>#result</code> with <code>data-ok</code>.</p>
<h2 id="quickstart">Quickstart: send a campaign</h2>
<ol>
<li>Sign in: ${link("/ai/login", "/ai/login")}.</li>
<li>Create a draft: ${link("/ai/campaigns/new", "/ai/campaigns/new")} (save_draft) — note the id in the redirect.</li>
<li>On /ai/campaigns/{id}: test_to_me, then queue (pick lists).</li>
<li>Reload the campaign; read <code>#unsent</code>; submit send with confirm_recipients equal to it.</li>
<li>Watch /ai/campaigns/{id} (autopilot state) — sending runs in the cloud; nothing needs to stay open.</li>
</ol>
<h2 id="rules">Rules</h2>
<ul>
<li>Nothing is sent to a list until <code>send</code> approves the exact unsent count. Content changes after approval block the send.</li>
<li>Autopilot sends ~13/s within the SES 24h quota, pauses automatically on bounce/complaint spikes, and emails the operator.</li>
<li>Subjects containing draft/test/placeholder/TBD words are refused for sending.</li>
<li>Never use Gmail or any other channel to send campaign email; only these actions.</li>
<li>User/permission admin and account settings remain human-only: /users and /account.</li>
</ul>
<h2 id="routes">Pages</h2>
${table("routes-table", ["Route", "Purpose"], routes)}
<h2 id="actions">Actions</h2>
${table("actions-table", ["Action", "Endpoint", "Fields (* required)", "Description"], actions)}`;
  return { title: "Props Mailer — agent interface", html, data: { signedIn: Boolean(auth?.userId), routes, actions: ACTION_SPECS } };
}

function loginView(auth: Auth, returnTo: string): View {
  const forms = [spec("login_password"), spec("login_bypass"), ...(auth?.userId ? [spec("logout")] : [])];
  return { title: "Sign in", html: forms.map((action) => form(action, returnTo)).join("\n"), data: { signedIn: Boolean(auth?.userId), email: auth?.email ?? null }, actions: forms };
}

async function statusView(): Promise<View> {
  const [runtime, autopilot] = await Promise.all([getMailerRuntimeLimits(null), listActiveAutopilotRecords()]);
  const rows = autopilot.map((record) => {
    const view = describeAutopilot(record);
    return [link(`/ai/campaigns/${record.emailId}`, record.subject ?? record.emailId), esc(view?.label ?? record.state), esc(view?.detail ?? "")];
  });
  const html = `${dl("quota", [
    ["SES rolling 24h cap", runtime.quota.dailyCap],
    ["Accepted in rolling 24h", runtime.quota.rolling24hSent],
    ["Remaining in rolling 24h", runtime.quota.remainingRolling24h],
    ["SES max send rate / s", runtime.sesMaxSendRatePerSecond],
    ["Accepted last 7 days", runtime.sentLast7Days],
  ])}
<h2 id="autopilot">Autopilot queue (sent one at a time, oldest approval first)</h2>
${table("autopilot-table", ["Campaign", "State", "Detail"], rows, [0, 1, 2])}
<p>${link("/api/health", "Health checks (JSON)", "health-link")}</p>`;
  return { title: "Status", html, data: { quota: runtime.quota, sesMaxSendRatePerSecond: runtime.sesMaxSendRatePerSecond, sentLast7Days: runtime.sentLast7Days, autopilot } };
}

async function campaignsView(url: URL): Promise<View> {
  const status = url.searchParams.get("status") ?? "active";
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  let query = getSupabaseAdmin().from("emails").select("id, subject, status, from_address, updated_at").order("updated_at", { ascending: false }).limit(limit);
  if (status === "active") query = query.in("status", ["draft", "queued", "sending"]);
  else if (status !== "all") query = query.eq("status", status);
  if (q) query = query.ilike("subject", `%${q.replace(/[%_]/g, "")}%`);
  const { data, error } = await query;
  if (error) throw error;
  const emails = data ?? [];
  const [counts, records] = await Promise.all([summaries(emails.map((email) => email.id)), getAutopilotRecords(emails.map((email) => email.id))]);
  const items = emails.map((email) => {
    const summary = counts.get(email.id);
    return {
      id: email.id,
      subject: email.subject,
      status: email.status,
      updatedAt: email.updated_at,
      unsent: summary ? summary.pending_due + summary.pending_held : 0,
      accepted: summary?.succeeded ?? 0,
      autopilot: records.get(email.id) ? describeAutopilot(records.get(email.id))?.label : null,
    };
  });
  const filters = ["active", "draft", "queued", "sending", "sent", "all"].map((value) => link(`/ai/campaigns?status=${value}`, value, `filter-${value}`)).join(" | ");
  const html = `<p id="filters">Filter: ${filters}</p>
<form id="search" method="get" action="/ai/campaigns"><input type="hidden" name="status" value="${esc(status)}"><label for="q">Subject contains</label> <input id="q" name="q" value="${esc(q)}"> <button type="submit">Search</button></form>
${table("campaigns-table", ["Subject", "Id", "Status", "Unsent", "Accepted", "Autopilot", "Updated (UTC)"], items.map((item) => [
    link(`/ai/campaigns/${item.id}`, item.subject || "(no subject)"),
    esc(item.id),
    esc(item.status),
    item.unsent,
    item.accepted,
    esc(item.autopilot ?? ""),
    esc(String(item.updatedAt ?? "").replace("T", " ").slice(0, 16)),
  ]), [0, 1, 2, 5, 6])}
<p>${link("/ai/campaigns/new", "Create a new campaign", "new-campaign")}</p>`;
  return { title: `Campaigns (${status})`, html, data: { status, q, campaigns: items } };
}

function newCampaignView(): View {
  const action = spec("save_draft", {}, { from: "Amol Sarva <a@sarva.co>", replyTo: "a@sarva.co" });
  return { title: "New campaign", html: form(action, "/ai/campaigns/new"), data: {}, actions: [action] };
}

async function campaignView(emailId: string, returnTo: string): Promise<View> {
  const admin = getSupabaseAdmin();
  const { data: email, error } = await admin
    .from("emails")
    .select("id, subject, status, from_address, reply_to, html, campaigns, tags, updated_at, created_at")
    .eq("id", emailId)
    .maybeSingle();
  if (error) throw error;
  if (!email) return { status: 404, title: "Campaign not found", html: `<p>No campaign ${esc(emailId)}. ${link("/ai/campaigns", "All campaigns")}</p>`, data: { error: "not_found" } };
  const [counts, record, { data: lists }] = await Promise.all([
    summaries([emailId]),
    getAutopilotRecord(emailId),
    admin.from("lists").select("id, name, address").order("name"),
  ]);
  const summary = counts.get(emailId) ?? { pending_due: 0, pending_held: 0, processing: 0, succeeded: 0, failed: 0, dead: 0, canceled: 0, total: 0 };
  const unsent = summary.pending_due + summary.pending_held;
  const view = describeAutopilot(record);
  const status = email.status as string;
  const active = Boolean(record && ["preparing", "approved", "running", "waiting_quota", "waiting_window", "waiting_reconcile", "waiting_retry"].includes(record.state));
  const values = { id: emailId };
  const available: ActionSpec[] = [];
  const listOptions = (lists ?? []).map((list) => ({ value: list.id, label: `${list.name} <${list.address}> [${list.id}]` }));
  if (status === "draft") {
    available.push(spec("save_draft", {}, { id: emailId, from: email.from_address, replyTo: email.reply_to ?? "", subject: email.subject, html: email.html, campaigns: (email.campaigns ?? []).join(","), tags: (email.tags ?? []).join(",") }));
    available.push(spec("test_send", {}, values));
    available.push(spec("queue", { fields: spec("queue").fields.map((field) => (field.name === "list_id" ? { ...field, options: listOptions } : field)) }, values));
  }
  if (status === "queued" || status === "sending") {
    if (unsent > 0) available.push(spec("test_to_me", {}, values));
    if (unsent > 0 && record?.state !== "preparing" && !(status === "sending" && active)) {
      available.push(spec("send", {}, { ...values, confirm_recipients: "" }));
    }
    if (active || status === "sending") available.push(spec("pause", {}, values));
    if (unsent === 0 && summary.processing === 0 && !active) available.push(spec("mark_sent", {}, values));
    available.push(spec("edit", {}, values), spec("unqueue", {}, values));
  }
  if (summary.dead + summary.failed > 0) available.push(spec("retry_failed", {}, values));
  available.push(spec("duplicate", {}, values), spec("delete", {}, values));

  const html = `${dl("campaign", [
    ["id", email.id],
    ["subject", email.subject],
    ["status", status],
    ["from", email.from_address],
    ["reply_to", email.reply_to],
    ["updated_at", email.updated_at],
  ])}
<h2 id="counts">Recipients</h2>
<p>Unsent: <strong id="unsent" data-value="${unsent}">${unsent}</strong> · accepted by SES: <span id="accepted">${summary.succeeded}</span> · in flight: <span id="in-flight">${summary.processing}</span> · failed: <span id="failed">${summary.dead + summary.failed}</span> · canceled: <span id="canceled">${summary.canceled}</span>${unsent ? ` · estimated send time: <span id="estimate">${esc(estimateSendDuration(unsent) ?? "")}</span>` : ""}</p>
<h2 id="autopilot">Autopilot</h2>
${record ? dl("autopilot-state", [
    ["state", record.state],
    ["label", view?.label],
    ["detail", view?.detail],
    ["approved_recipients", record.approvedRecipients],
    ["approved_at", record.approvedAt],
    ["heartbeat_at", record.heartbeatAt],
    ["next_check_at", record.nextCheckAt],
    ["send_window", record.sendWindow],
    ["deliverability", record.deliverability ? JSON.stringify(record.deliverability) : null],
    ["report", record.report ? JSON.stringify(record.report) : null],
    ["worker_run", record.run?.url],
  ]) : `<p id="autopilot-state">Not approved for sending.</p>`}
<p>${link(`/ai/campaigns/${emailId}/log`, "Recipient log", "log-link")} | ${link(`/ai/campaigns/${emailId}/analytics`, "Analytics", "analytics-link")} | ${link(`/api/email/preview/${emailId}`, "Rendered preview", "preview-link")}</p>
<h2 id="available-actions">Available actions</h2>
${available.map((action) => form(action, returnTo)).join("\n<hr>\n")}`;
  return {
    title: email.subject || "(no subject)",
    html,
    data: { campaign: { id: email.id, subject: email.subject, status, from: email.from_address, replyTo: email.reply_to, updatedAt: email.updated_at }, counts: { ...summary, unsent }, autopilot: record, lists },
    actions: available,
  };
}

async function logView(emailId: string): Promise<View> {
  const { data, error } = await getSupabaseAdmin()
    .from("mail_queue")
    .select("payload, status, attempts, updated_at, last_error")
    .eq("email_id", emailId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = ((data ?? []) as Array<{ payload: { to?: string } | null; status: string; attempts: number; updated_at: string; last_error: string | null }>).map((row) => ({
    recipient: row.payload?.to ?? null,
    status: row.status,
    attempts: row.attempts,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  }));
  return {
    title: "Recipient log",
    html: `<p>${link(`/ai/campaigns/${emailId}`, "Back to campaign")}</p>${table("log-table", ["Recipient", "Status", "Attempts", "Updated", "Last error"], rows.map((row) => [row.recipient, row.status, row.attempts, row.updatedAt, row.lastError]))}`,
    data: { emailId, rows },
  };
}

async function analyticsView(emailId: string): Promise<View> {
  const admin = getSupabaseAdmin();
  const queue = await admin.rpc("get_email_queue_analytics_metric", { p_email_id: emailId });
  const metrics: Record<string, number | string> = { accepted: Number((queue.data as Array<{ sent?: number }> | null)?.[0]?.sent ?? 0) };
  for (const metric of ["delivered", "bounced", "complained", "opened", "clicked"]) {
    const result = await admin.rpc("get_email_provider_analytics_metric", { p_email_id: emailId, p_event_type: metric });
    metrics[metric] = result.error ? `error: ${result.error.message}` : Number((result.data as Array<{ unique_recipients?: number }> | null)?.[0]?.unique_recipients ?? 0);
  }
  return {
    title: "Analytics",
    html: `<p>${link(`/ai/campaigns/${emailId}`, "Back to campaign")}</p>${dl("metrics", Object.entries(metrics))}<p>Unique recipients per event type. Opens are inflated by Apple Mail privacy.</p>`,
    data: { emailId, metrics },
  };
}

async function listsView(returnTo: string): Promise<View> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.from("lists").select("id, name, address, description, access_level").order("name");
  if (error) throw error;
  const lists = await Promise.all((data ?? []).map(async (list) => {
    const { count } = await admin.from("list_members").select("id", { count: "exact", head: true }).eq("list_id", list.id).eq("status", "active");
    return { ...list, activeMembers: count ?? 0 };
  }));
  const action = spec("list_upsert");
  return {
    title: "Lists",
    html: `${table("lists-table", ["Name", "Id", "Address", "Active members", "Description"], lists.map((list) => [link(`/ai/lists/${list.id}`, list.name), esc(list.id), esc(list.address), list.activeMembers, esc(list.description ?? "")]), [0, 1, 2, 4])}
${form(action, returnTo)}`,
    data: { lists },
    actions: [action],
  };
}

async function listView(listId: string, url: URL, returnTo: string): Promise<View> {
  const admin = getSupabaseAdmin();
  const { data: list, error } = await admin.from("lists").select("id, name, address, description").eq("id", listId).maybeSingle();
  if (error) throw error;
  if (!list) return { status: 404, title: "List not found", html: `<p>${link("/ai/lists", "All lists")}</p>`, data: { error: "not_found" } };
  const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const status = url.searchParams.get("status") ?? "";
  const pageIndex = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
  let query = admin.from("list_members").select("id, email, status, metadata", { count: "exact" }).eq("list_id", listId).order("email").range(pageIndex * 100, pageIndex * 100 + 99);
  if (q) query = query.ilike("email", `%${q.replace(/[%_]/g, "")}%`);
  if (status) query = query.eq("status", status);
  const { data: members, count, error: membersError } = await query;
  if (membersError) throw membersError;
  const rows = (members ?? []).map((member) => {
    const metadata = (member.metadata ?? {}) as Record<string, unknown>;
    return { id: member.id, email: member.email, status: member.status, name: typeof metadata.name === "string" ? metadata.name : null };
  });
  const importAction = spec("list_import", {}, { list_id: listId });
  const suppressAction = spec("member_suppress", {}, { list_id: listId });
  const next = (count ?? 0) > (pageIndex + 1) * 100 ? link(`/ai/lists/${listId}?${new URLSearchParams({ q, status, page: String(pageIndex + 1) })}`, "Next page", "next-page") : "";
  return {
    title: `List: ${list.name}`,
    html: `${dl("list", [["id", list.id], ["name", list.name], ["address", list.address], ["description", list.description], ["matching members", count ?? 0]])}
<form id="member-search" method="get" action="/ai/lists/${esc(listId)}"><label for="q">Email contains</label> <input id="q" name="q" value="${esc(q)}"> <label for="status">Status</label> <select id="status" name="status"><option value="">any</option>${["active", "unsubscribed", "blocked", "bounced", "complained"].map((value) => `<option value="${value}"${value === status ? " selected" : ""}>${value}</option>`).join("")}</select> <button type="submit">Search</button></form>
${table("members-table", ["Email", "Member id", "Status", "Name"], rows.map((row) => [row.email, row.id, row.status, row.name]))}
<p>Page ${pageIndex}. ${next}</p>
${form(importAction, returnTo)}
${form(suppressAction, returnTo)}`,
    data: { list, total: count ?? 0, page: pageIndex, members: rows },
    actions: [importAction, suppressAction],
  };
}

function respond(view: View, auth: Auth, url: URL, request: Request) {
  const result: ActionResult | null = url.searchParams.has("result")
    ? { ok: url.searchParams.get("ok") === "1", message: url.searchParams.get("result") ?? "" }
    : null;
  const wantsJson = url.searchParams.get("format") === "json" || (request.headers.get("accept") ?? "").startsWith("application/json");
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (wantsJson) {
    return NextResponse.json(
      {
        page: url.pathname,
        title: view.title,
        signedInAs: auth?.email ?? null,
        result,
        data: view.data,
        actions: (view.actions ?? []).map((action) => ({
          action: action.action,
          method: "POST",
          url: `/ai/do/${action.action}`,
          description: action.description,
          fields: action.fields.map((field) => ({ name: field.name, type: field.type ?? "text", required: Boolean(field.required), value: field.value ?? null, options: field.options })),
        })),
      },
      { status: view.status ?? 200, headers },
    );
  }
  const jsonUrl = new URL(url);
  jsonUrl.searchParams.delete("result");
  jsonUrl.searchParams.delete("ok");
  jsonUrl.searchParams.set("format", "json");
  return new NextResponse(page({ title: view.title, who: auth?.email ?? null, result, body: view.html, jsonHref: `${jsonUrl.pathname}${jsonUrl.search}` }), {
    status: view.status ?? 200,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const url = new URL(request.url);
  const segments = (await params).path ?? [];
  const auth = await getServerAuthContext();
  const returnTo = url.pathname;
  try {
    if (segments.length === 0) return respond(indexView(auth), auth, url, request);
    if (segments[0] === "login" && segments.length === 1) return respond(loginView(auth, "/ai"), auth, url, request);
    if (!auth?.userId) {
      return respond({ status: 401, title: "Sign in required", html: `<p id="auth-required">This page needs a session. ${link("/ai/login", "Sign in")}, then return to ${esc(url.pathname)}.</p>`, data: { error: "unauthenticated", login: "/ai/login" } }, auth, url, request);
    }
    const [section, itemId, sub] = segments;
    let view: View | null = null;
    if (section === "status" && !itemId) view = await statusView();
    else if (section === "campaigns" && !itemId) view = await campaignsView(url);
    else if (section === "campaigns" && itemId === "new" && !sub) view = newCampaignView();
    else if (section === "campaigns" && UUID.test(itemId ?? "") && !sub) view = await campaignView(itemId!, returnTo);
    else if (section === "campaigns" && UUID.test(itemId ?? "") && sub === "log") view = await logView(itemId!);
    else if (section === "campaigns" && UUID.test(itemId ?? "") && sub === "analytics") view = await analyticsView(itemId!);
    else if (section === "lists" && !itemId) view = await listsView(returnTo);
    else if (section === "lists" && UUID.test(itemId ?? "") && !sub) view = await listView(itemId!, url, returnTo);
    view ??= { status: 404, title: "Not found", html: `<p>No such page. ${link("/ai", "Catalog")}</p>`, data: { error: "not_found" } };
    return respond(view, auth, url, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error);
    return respond({ status: 500, title: "Error", html: `<p id="error">${esc(message)}</p>`, data: { error: message } }, auth, url, request);
  }
}
