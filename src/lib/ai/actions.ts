// Every state-changing capability of the web app, exposed as a plain form
// POST for browser-driving agents. Handlers delegate to the same server
// actions the human UI uses, so validation, permissions, and send safety
// (exact-count approval, content digest, deliverability guards) are identical.
import { buildQueueReleaseConfirmation } from "@/lib/queueReleaseGuard";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { ActionSpec } from "@/lib/ai/html";
import {
  cancelEmailAction,
  deleteEmailAction,
  editQueuedEmailAction,
  markCampaignSentAction,
  pauseQueuedEmailAction,
  prepareInCloudAction,
  queueCampaignAction,
  requeueDeadAction,
  saveDraftAction,
  sendQueuedEmailAction,
  sendQueuedTestAction,
  sendTestAction,
} from "@/app/(dashboard)/email/actions";
import { importMembersAction, suppressListMemberAction, upsertListAction } from "@/app/(dashboard)/lists/actions";
import { bypassLogin, signInWithPassword, signOutAction } from "@/app/(auth)/login/actions";

export type ActionResult = { ok: boolean; message: string; next?: string; data?: Record<string, unknown> };
type Handler = (input: FormData) => Promise<ActionResult>;

const CLOUD_PREP_THRESHOLD = 5_000;
const id = (input: FormData, name = "id") => String(input.get(name) ?? "").trim();
const campaignPage = (emailId: string) => `/ai/campaigns/${emailId}`;
const fd = (entries: Record<string, string | undefined | null>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== null) data.set(key, value);
  return data;
};
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Login/logout server actions end in redirect(); read the destination from
// Next's redirect error instead of letting it escape the route handler.
async function followRedirect(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const digest = (error as { digest?: string })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? "/";
    throw error;
  }
}

async function queueToLists(emailId: string, listIds: string[], confirmRecent: boolean, excludeExact: boolean): Promise<ActionResult> {
  let exclude: string[] = [];
  let skip = confirmRecent || excludeExact;
  let queued = 0;
  let needsCloud = false;
  for (const listId of listIds) {
    let offset = 0;
    for (;;) {
      const res = await queueCampaignAction(fd({
        emailId,
        listId,
        offset: String(offset),
        skipDuplicateCheck: skip ? "true" : undefined,
        excludeRecipients: exclude.length ? JSON.stringify(exclude) : undefined,
      }));
      if (!res.ok) {
        if (!res.requiresConfirmation) return { ok: false, message: res.error };
        if (excludeExact) {
          exclude = [...new Set(res.warningGroups.flatMap((group) => group.exactRecipientAddresses))];
          skip = true;
          continue;
        }
        return {
          ok: false,
          message: `Recent-contact check: ${res.duplicateCount} recipients already received this exact email and ${res.recentlySentCount} got another email to this list in the last 30 days. Resubmit with confirm_recent_contact=yes to queue anyway, or exclude_exact_duplicates=yes to skip exact repeats.`,
          data: { duplicateCount: res.duplicateCount, recentlySentCount: res.recentlySentCount, warningGroups: res.warningGroups.map((group) => ({ date: group.date, subject: group.subject, recipients: group.recipientAddresses.length })) },
        };
      }
      queued = Math.max(queued, res.queuedRecipients);
      if (!res.hasMore || !res.nextOffset) break;
      if (res.totalRecipients > CLOUD_PREP_THRESHOLD) {
        needsCloud = true;
        break;
      }
      offset = res.nextOffset;
    }
  }
  if (needsCloud) {
    const prep = await prepareInCloudAction(fd({
      emailId,
      listIds: JSON.stringify(listIds),
      excludeRecipients: JSON.stringify(exclude),
      sendAfterPrepare: "false",
    }));
    if (prep.error) return { ok: false, message: prep.error };
    return { ok: true, message: `Large audience: preparing up to ${prep.maxRecipients} recipients in the cloud. Reload this campaign until autopilot shows "prepared", then use send. ${prep.detail ?? ""}`, next: campaignPage(emailId) };
  }
  return { ok: true, message: `Queued. Review the unsent count on the campaign page, then use send.`, next: campaignPage(emailId), data: { queued } };
}

export const ACTION_SPECS: ActionSpec[] = [
  {
    action: "login_password",
    label: "Sign in with password",
    description: "Supabase email + password sign-in. Sets a session cookie.",
    fields: [
      { name: "email", label: "Email", type: "email", required: true },
      { name: "password", label: "Password", type: "password", required: true },
    ],
  },
  {
    action: "login_bypass",
    label: "Sign in with bypass password",
    description: "Emergency bypass (signs in as the owner for 12 hours). Rate-limited to 5 attempts per 15 minutes.",
    fields: [{ name: "password", label: "Bypass password", type: "password", required: true }],
  },
  { action: "logout", label: "Sign out", description: "Clears the session.", fields: [] },
  {
    action: "save_draft",
    label: "Save draft",
    description: "Create (omit id) or update a draft. Saving an existing queued campaign returns it to draft.",
    fields: [
      { name: "id", label: "Campaign id (blank = new)", type: "text" },
      { name: "from", label: "From", type: "text", required: true, help: "e.g. Amol Sarva <a@sarva.co>" },
      { name: "replyTo", label: "Reply-To", type: "email" },
      { name: "subject", label: "Subject", type: "text", required: true, help: "Merge tags like {{firstName | friend}} allowed. Words like draft/test/TBD block sending." },
      { name: "html", label: "HTML body", type: "textarea", required: true },
      { name: "recipients", label: "Direct recipients (comma/newline separated, optional)", type: "textarea" },
      { name: "campaigns", label: "Campaign labels (comma separated)", type: "text" },
      { name: "tags", label: "Tags (comma separated)", type: "text" },
    ],
  },
  { action: "duplicate", label: "Duplicate", description: "Copy this campaign into a new draft.", fields: [{ name: "id", label: "Campaign id", type: "hidden" }] },
  { action: "test_to_me", label: "Test to me", description: "Email the signed-in user this exact content, personalized as the first unsent recipient.", fields: [{ name: "id", label: "Campaign id", type: "hidden" }] },
  {
    action: "test_send",
    label: "Send test",
    description: "Send the saved content to specific addresses as a test (does not change campaign status).",
    fields: [
      { name: "id", label: "Campaign id", type: "hidden" },
      { name: "recipients", label: "Test recipients (comma separated)", type: "text", required: true },
    ],
  },
  {
    action: "queue",
    label: "Queue to lists",
    description: "Build the held recipient queue from one or more lists (deduplicated across lists). Nothing sends until 'send'. Lists over 5,000 finish preparing in the cloud.",
    fields: [
      { name: "id", label: "Campaign id", type: "hidden" },
      { name: "list_id", label: "Lists", type: "checkbox", options: [] },
      { name: "confirm_recent_contact", label: "Queue even if recipients were contacted recently", type: "checkbox" },
      { name: "exclude_exact_duplicates", label: "Skip recipients who already received this exact email", type: "checkbox" },
    ],
  },
  {
    action: "send",
    label: "Send (approve for autopilot)",
    description: "Approves the exact unsent count for the cloud sender. confirm_recipients must equal the current unsent count shown on the campaign page.",
    danger: true,
    fields: [
      { name: "id", label: "Campaign id", type: "hidden" },
      { name: "confirm_recipients", label: "Confirm unsent recipient count", type: "number", required: true },
      { name: "send_at", label: "Send at (optional ISO-8601, e.g. 2026-10-01T13:00:00Z)", type: "text" },
      { name: "send_window", label: "Send window (optional, e.g. 07:00-21:00 America/New_York)", type: "text" },
    ],
  },
  { action: "pause", label: "Pause", description: "Stop sending within ~15 seconds; unsent recipients are kept. Resume with send.", fields: [{ name: "id", label: "Campaign id", type: "hidden" }] },
  { action: "unqueue", label: "Unqueue", description: "Cancel unsent recipients and return the campaign to draft.", danger: true, fields: [{ name: "id", label: "Campaign id", type: "hidden" }] },
  { action: "edit", label: "Reopen for editing", description: "Cancel unsent recipients and return to draft so content can change.", fields: [{ name: "id", label: "Campaign id", type: "hidden" }] },
  { action: "mark_sent", label: "Mark as sent", description: "Close out a campaign with nothing left to send.", fields: [{ name: "id", label: "Campaign id", type: "hidden" }] },
  { action: "retry_failed", label: "Retry failed", description: "Requeue permanently failed recipients (never ambiguous ones); then send again.", fields: [{ name: "id", label: "Campaign id", type: "hidden" }] },
  { action: "delete", label: "Delete", description: "Delete the campaign and its queue rows.", danger: true, fields: [{ name: "id", label: "Campaign id", type: "hidden" }, { name: "confirm", label: "Type delete to confirm", type: "text", required: true }] },
  {
    action: "list_upsert",
    label: "Create or update list",
    description: "Address is the unique key.",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "address", label: "Address", type: "email", required: true },
      { name: "description", label: "Description", type: "text" },
    ],
  },
  {
    action: "list_import",
    label: "Import members",
    description: "CSV/TSV or one email per line; optional name column. Upserts; invalid rows are skipped.",
    fields: [
      { name: "list_id", label: "List id", type: "hidden" },
      { name: "members", label: "Members", type: "textarea", required: true },
    ],
  },
  {
    action: "member_suppress",
    label: "Suppress member",
    description: "Unsubscribe one member from this list.",
    fields: [
      { name: "list_id", label: "List id", type: "hidden" },
      { name: "member_id", label: "Member id", type: "text", required: true },
    ],
  },
];

export const ACTION_HANDLERS: Record<string, Handler> = {
  async login_password(input) {
    const target = await followRedirect(() => signInWithPassword(fd({ email: String(input.get("email") ?? ""), password: String(input.get("password") ?? "") })));
    return target && !target.includes("error=")
      ? { ok: true, message: "Signed in.", next: "/ai" }
      : { ok: false, message: `Sign-in failed (${new URL(target ?? "/login?error=unknown", "http://x").searchParams.get("error") ?? "unknown"}).`, next: "/ai/login" };
  },
  async login_bypass(input) {
    const target = await followRedirect(() => bypassLogin(fd({ password: String(input.get("password") ?? "") })));
    return target && !target.includes("error=")
      ? { ok: true, message: "Signed in with bypass.", next: "/ai" }
      : { ok: false, message: `Bypass sign-in failed (${new URL(target ?? "/x?error=unknown", "http://x").searchParams.get("error") ?? "unknown"}).`, next: "/ai/login" };
  },
  async logout() {
    await followRedirect(() => signOutAction());
    return { ok: true, message: "Signed out.", next: "/ai" };
  },
  async save_draft(input) {
    const emailId = id(input);
    const res = await saveDraftAction(fd({
      id: emailId || undefined,
      from: String(input.get("from") ?? ""),
      replyTo: String(input.get("replyTo") ?? input.get("reply_to") ?? ""),
      subject: String(input.get("subject") ?? ""),
      html: String(input.get("html") ?? ""),
      recipients: String(input.get("recipients") ?? ""),
      campaigns: String(input.get("campaigns") ?? ""),
      tags: String(input.get("tags") ?? ""),
    }));
    return { ok: true, message: emailId ? "Draft saved." : "Draft created.", next: campaignPage(res.id), data: { id: res.id } };
  },
  async duplicate(input) {
    const { data: email, error } = await getSupabaseAdmin().from("emails").select("from_address, reply_to, subject, html, campaigns, tags").eq("id", id(input)).maybeSingle();
    if (error || !email) return { ok: false, message: error?.message ?? "Campaign not found" };
    const res = await saveDraftAction(fd({
      from: email.from_address,
      replyTo: email.reply_to ?? "",
      subject: email.subject,
      html: email.html,
      recipients: "",
      campaigns: (email.campaigns ?? []).join(","),
      tags: (email.tags ?? []).join(","),
    }));
    return { ok: true, message: "Duplicated into a new draft.", next: campaignPage(res.id), data: { id: res.id } };
  },
  async test_to_me(input) {
    const res = await sendQueuedTestAction(fd({ id: id(input) }));
    return res.error ? { ok: false, message: res.error } : { ok: true, message: `Test sent to ${res.sentTo}${res.personalizedAs ? `, personalized as ${res.personalizedAs}` : ""}.` };
  },
  async test_send(input) {
    const { data: email, error } = await getSupabaseAdmin().from("emails").select("from_address, reply_to, subject, html, text, campaigns, tags").eq("id", id(input)).maybeSingle();
    if (error || !email) return { ok: false, message: error?.message ?? "Campaign not found" };
    const res = await sendTestAction(fd({
      id: id(input),
      mode: "test",
      from: email.from_address,
      replyTo: email.reply_to ?? "",
      subject: email.subject,
      html: email.html,
      text: email.text ?? "",
      recipients: String(input.get("recipients") ?? ""),
      campaigns: (email.campaigns ?? []).join(","),
      tags: (email.tags ?? []).join(","),
    }));
    return res.error ? { ok: false, message: res.error } : { ok: true, message: `Test sent to ${res.sent} recipient(s).` };
  },
  async queue(input) {
    const listIds = input.getAll("list_id").map(String).filter(Boolean);
    if (!listIds.length) return { ok: false, message: "Select at least one list_id." };
    return queueToLists(id(input), listIds, input.get("confirm_recent_contact") === "yes", input.get("exclude_exact_duplicates") === "yes");
  },
  async send(input) {
    const emailId = id(input);
    const res = await sendQueuedEmailAction(fd({
      id: emailId,
      releaseConfirmation: buildQueueReleaseConfirmation(emailId),
      expectedRecipients: String(input.get("confirm_recipients") ?? ""),
      sendAt: String(input.get("send_at") ?? ""),
      sendWindow: String(input.get("send_window") ?? ""),
    }));
    return res.error
      ? { ok: false, message: res.error }
      : { ok: true, message: `Approved ${res.recipients} recipients. ${res.detail ?? ""}`, next: campaignPage(emailId), data: { recipients: res.recipients, dispatched: res.dispatched } };
  },
  async pause(input) {
    const res = await pauseQueuedEmailAction(fd({ id: id(input) }));
    return res.error ? { ok: false, message: res.error } : { ok: true, message: `Paused; ${res.paused} unsent kept, ${res.processing} in flight.` };
  },
  async unqueue(input) {
    const res = await cancelEmailAction(fd({ id: id(input) }));
    return res.error ? { ok: false, message: res.error } : { ok: true, message: "Unqueued; campaign is a draft again." };
  },
  async edit(input) {
    const res = await editQueuedEmailAction(fd({ id: id(input) }));
    return res.error ? { ok: false, message: res.error } : { ok: true, message: "Reopened as a draft; use save_draft to change content." };
  },
  async mark_sent(input) {
    const res = await markCampaignSentAction(fd({ id: id(input) }));
    return res.error ? { ok: false, message: res.error } : { ok: true, message: "Marked as sent." };
  },
  async retry_failed(input) {
    const res = await requeueDeadAction(fd({ emailId: id(input) }));
    return { ok: true, message: `Requeued ${res.requeued} failed recipients; campaign is back in the queue — use send.` };
  },
  async delete(input) {
    if (String(input.get("confirm") ?? "").trim().toLowerCase() !== "delete") return { ok: false, message: 'Type "delete" in confirm.' };
    const res = await deleteEmailAction(fd({ id: id(input) }));
    return res.error ? { ok: false, message: res.error } : { ok: true, message: "Deleted.", next: "/ai/campaigns" };
  },
  async list_upsert(input) {
    await upsertListAction(fd({ name: String(input.get("name") ?? ""), address: String(input.get("address") ?? ""), description: String(input.get("description") ?? "") }));
    return { ok: true, message: "List saved.", next: "/ai/lists" };
  },
  async list_import(input) {
    const listId = id(input, "list_id");
    const res = await importMembersAction(fd({ listId, members: String(input.get("members") ?? "") }));
    return { ok: true, message: `Imported: ${res.upserted} upserted, ${res.skippedInvalid} invalid, ${res.skippedDuplicate} duplicate.`, next: `/ai/lists/${listId}`, data: res };
  },
  async member_suppress(input) {
    const listId = id(input, "list_id");
    await suppressListMemberAction(fd({ listId, memberId: id(input, "member_id") }));
    return { ok: true, message: "Member suppressed.", next: `/ai/lists/${listId}` };
  },
};

export const PUBLIC_ACTIONS = new Set(["login_password", "login_bypass", "logout"]);

export async function runAction(name: string, input: FormData): Promise<ActionResult> {
  const handler = ACTION_HANDLERS[name];
  if (!handler) return { ok: false, message: `Unknown action "${name}". See /ai for the catalog.` };
  try {
    return await handler(input);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
