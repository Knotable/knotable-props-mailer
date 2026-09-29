/**
 * One-click unsubscribe (RFC 8058) for links the SES worker signs into each
 * message's List-Unsubscribe header.
 *
 * POST (from Gmail/Yahoo's unsubscribe button, or the confirm form below)
 * unsubscribes the address from the one list the message was sent from; its
 * other lists are untouched. GET only shows a confirm button, so link
 * scanners that prefetch URLs cannot unsubscribe anyone.
 *
 * Public by design (/api is outside the auth proxy); the HMAC signature is
 * the only authority, and it covers exactly one campaign + list + address.
 */
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { logError } from "@/lib/logger";
import {
  UNSUBSCRIBE_SETTINGS_KEY,
  normalizeUnsubscribeKey,
  verifyUnsubscribe,
} from "../../../../scripts/lib/one-click-unsubscribe.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function signingKey(): Promise<string | null> {
  const fromEnv = normalizeUnsubscribeKey(process.env.UNSUBSCRIBE_HMAC_KEY);
  if (fromEnv) return fromEnv;
  const { data } = await getSupabaseAdmin()
    .from("app_settings")
    .select("value")
    .eq("key", UNSUBSCRIBE_SETTINGS_KEY)
    .maybeSingle();
  return normalizeUnsubscribeKey((data as { value?: { key?: unknown } } | null)?.value?.key);
}

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#0f172a}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#0f172a;color:#fff;cursor:pointer}</style>
</head><body>${body}</body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

async function verifiedRecipient(url: URL) {
  const emailId = url.searchParams.get("c") ?? "";
  const listId = url.searchParams.get("l") ?? "";
  const secret = await signingKey();
  if (!secret) return { emailId, listId, recipient: null };
  const recipient = verifyUnsubscribe({
    secret,
    emailId,
    listId,
    encodedRecipient: url.searchParams.get("r"),
    signature: url.searchParams.get("s"),
  });
  return { emailId, listId, recipient };
}

async function listName(listId: string) {
  const { data } = await getSupabaseAdmin().from("lists").select("name").eq("id", listId).maybeSingle();
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

const fromList = (name: string | null) => (name ? ` from <strong>${escapeHtml(name)}</strong>` : " from this mailing list");

const INVALID = page("Link not valid", "<h1>This unsubscribe link isn't valid</h1><p>Reply to the email with “unsubscribe” and we'll remove you by hand.</p>", 400);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { listId, recipient } = await verifiedRecipient(url);
  if (!recipient) return INVALID;
  return page(
    "Unsubscribe",
    `<h1>Unsubscribe</h1><p>Unsubscribe <strong>${escapeHtml(recipient)}</strong>${fromList(await listName(listId))}?</p>
<form method="post" action="${escapeHtml(url.pathname + url.search)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`,
  );
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const { emailId, listId, recipient } = await verifiedRecipient(url);
  if (!recipient) return INVALID;

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("list_members")
    .update({ status: "unsubscribed", unsubscribed_at: now })
    .eq("list_id", listId)
    .eq("email", recipient)
    .eq("status", "active");
  if (error) {
    await logError({ source: "unsubscribe", message: "One-click unsubscribe failed", payload: { emailId, listId, error: error.message } }).catch(() => undefined);
    return page("Try again", "<h1>Something went wrong</h1><p>Please try again, or reply to the email with “unsubscribe”.</p>", 500);
  }

  // Audit trail only; the membership update above is what stops mail.
  const { error: auditError } = await supabase
    .from("unsubscribe_requests" as never)
    .insert({
      email: recipient,
      source_email_id: /^[0-9a-f-]{36}$/i.test(emailId) ? emailId : null,
      list_id: /^[0-9a-f-]{36}$/i.test(listId) ? listId : null,
      request_type: "manual",
      status: "handled",
      handled_at: now,
      notes: "One-click List-Unsubscribe",
    } as never);
  if (auditError) console.warn("[unsubscribe] audit insert failed", auditError.message);

  return page("Unsubscribed", `<h1>You're unsubscribed</h1><p>${escapeHtml(recipient)} has been removed${fromList(await listName(listId))}.</p>`);
}
