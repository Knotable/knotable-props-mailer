/**
 * POST /api/webhooks/ses
 *
 * Receives SNS notifications from Amazon SES and writes events into
 * the `provider_events` table so the analytics page can display them.
 *
 * AWS setup (one-time, manual):
 *  1. In SES → Configuration Sets → your set → Event Destinations, add an
 *     SNS destination for the event types you care about.
 *  2. Create an SNS topic, subscribe this URL:
 *       https://<your-domain>/api/webhooks/ses
 *  3. SNS sends a SubscriptionConfirmation first — this handler auto-confirms it.
 *
 * Event deduplication: before inserting into provider_events we check for an
 * existing row with the same (message_id, event_type).  SNS delivers at-least-
 * once, so retries after a 500 would otherwise create duplicate rows.
 */

import { createVerify } from "crypto";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { checkRateLimit } from "@/lib/rateLimit";

// ── SNS message signature verification ────────────────────────────────────────
// Cache signing certs in memory so we don't fetch the same PEM on every event.
const certCache = new Map<string, string>();

async function fetchSigningCert(certUrl: string): Promise<string> {
  const cached = certCache.get(certUrl);
  if (cached) return cached;

  // Only accept HTTPS certs from SNS hostnames.
  const u = new URL(certUrl);
  if (u.protocol !== "https:" || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) {
    throw new Error("Untrusted SigningCertURL");
  }

  const res = await fetch(certUrl, { next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`Failed to fetch signing cert: ${res.status}`);
  const pem = await res.text();
  certCache.set(certUrl, pem);
  return pem;
}

// Build the canonical string-to-sign per AWS SNS spec.
function buildStringToSign(msg: Record<string, unknown>): string {
  const type = msg["Type"] as string;
  const fields =
    type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];

  return fields
    .filter((k) => msg[k] !== undefined && msg[k] !== null)
    .map((k) => `${k}\n${msg[k]}\n`)
    .join("");
}

async function verifySnsSignature(body: Record<string, unknown>): Promise<boolean> {
  try {
    const certUrl = body["SigningCertURL"] as string | undefined;
    const signature = body["Signature"] as string | undefined;
    const sigVer = body["SignatureVersion"] as string | undefined;
    if (!certUrl || !signature) return false;

    const algorithm = sigVer === "2" ? "sha256WithRSAEncryption" : "sha1WithRSAEncryption";
    const pem = await fetchSigningCert(certUrl);
    const verifier = createVerify(algorithm);
    verifier.update(buildStringToSign(body));
    return verifier.verify(pem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

const SES_EVENT_MAP: Record<string, string> = {
  Send: "sent",
  Delivery: "delivered",
  Bounce: "bounced",
  Complaint: "complained",
  Open: "opened",
  Click: "clicked",
  Reject: "rejected",
  "Rendering Failure": "rendering_failure",
};

const MAX_WEBHOOK_BODY_BYTES = 256_000;

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const { allowed } = await checkRateLimit(`ses-webhook:${ip}`, 300, 60_000);
  if (!allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Record<string, unknown>;

  try {
    const text = await request.text();
    if (text.length > MAX_WEBHOOK_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messageType = body["Type"] as string | undefined;

  // ── SNS signature verification ─────────────────────────────────────────────
  // Reject forged or tampered notifications before doing any DB work.
  const sigValid = await verifySnsSignature(body);
  if (!sigValid) {
    console.warn("[ses-webhook] SNS signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // ── SNS Subscription Confirmation ─────────────────────────────────────────
  if (messageType === "SubscriptionConfirmation") {
    const subscribeUrl = body["SubscribeURL"] as string | undefined;
    if (!subscribeUrl) {
      return NextResponse.json({ error: "Missing SubscribeURL" }, { status: 400 });
    }

    try {
      const url = new URL(subscribeUrl);
      // Accept only SNS service endpoints — not arbitrary *.amazonaws.com hosts.
      if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
        return NextResponse.json({ error: "Invalid SubscribeURL host" }, { status: 400 });
      }
      if (url.protocol !== "https:") {
        return NextResponse.json({ error: "SubscribeURL must use HTTPS" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Malformed SubscribeURL" }, { status: 400 });
    }

    try {
      await fetch(subscribeUrl);
      console.info("[ses-webhook] SNS subscription confirmed");
    } catch (err) {
      console.error("[ses-webhook] Failed to confirm SNS subscription", err);
      return NextResponse.json({ error: "Subscription confirmation failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, action: "subscription_confirmed" });
  }

  // ── SNS Notification ───────────────────────────────────────────────────────
  if (messageType !== "Notification") {
    return NextResponse.json({ ok: true, action: "ignored" });
  }

  let sesEvent: Record<string, unknown>;
  try {
    sesEvent = JSON.parse(body["Message"] as string);
  } catch {
    return NextResponse.json({ error: "Could not parse SNS Message as JSON" }, { status: 400 });
  }

  const sesEventType = sesEvent["eventType"] as string | undefined;
  if (!sesEventType) {
    return NextResponse.json({ ok: true, action: "ignored_no_event_type" });
  }

  const eventType = SES_EVENT_MAP[sesEventType] ?? sesEventType.toLowerCase();
  const mail = sesEvent["mail"] as Record<string, unknown> | undefined;
  const messageId = (mail?.["messageId"] as string | undefined) ?? null;

  let recipient: string | null = null;
  if (sesEventType === "Delivery") {
    const delivery = sesEvent["delivery"] as Record<string, unknown> | undefined;
    const recipients = delivery?.["recipients"] as string[] | undefined;
    recipient = recipients?.[0] ?? null;
  } else if (sesEventType === "Bounce") {
    const bounce = sesEvent["bounce"] as Record<string, unknown> | undefined;
    const recipients = bounce?.["bouncedRecipients"] as Array<Record<string, unknown>> | undefined;
    recipient = (recipients?.[0]?.["emailAddress"] as string | undefined) ?? null;
  } else if (sesEventType === "Complaint") {
    const complaint = sesEvent["complaint"] as Record<string, unknown> | undefined;
    const recipients = complaint?.["complainedRecipients"] as Array<Record<string, unknown>> | undefined;
    recipient = (recipients?.[0]?.["emailAddress"] as string | undefined) ?? null;
  } else if (sesEventType === "Open" || sesEventType === "Click" || sesEventType === "Send") {
    const commonHeaders = mail?.["commonHeaders"] as Record<string, unknown> | undefined;
    const to = commonHeaders?.["to"] as string[] | undefined;
    recipient = to?.[0] ?? null;
  }

  const supabase = getSupabaseAdmin();

  // ── Deduplication ──────────────────────────────────────────────────────────
  // SNS guarantees at-least-once delivery; retries after a 500 would create
  // duplicate rows without this check.
  if (messageId) {
    const { data: existing } = await supabase
      .from("provider_events")
      .select("id")
      .eq("message_id", messageId)
      .eq("event_type", eventType)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ ok: true, action: "duplicate_ignored" });
    }
  }

  // ── Look up email_id via ses_message_id ────────────────────────────────────
  let emailId: string | null = null;
  if (messageId) {
    const { data: queueRow } = await supabase
      .from("mail_queue")
      .select("email_id")
      .eq("ses_message_id", messageId)
      .maybeSingle();
    emailId = queueRow?.email_id ?? null;
  }

  // ── Insert event ───────────────────────────────────────────────────────────
  const { error } = await supabase.from("provider_events").insert({
    provider: "ses",
    event_type: eventType,
    message_id: messageId,
    recipient,
    email_id: emailId,
    payload: sesEvent as import("@/supabase/types").Json,
  });

  if (error) {
    console.error("[ses-webhook] Failed to insert provider_event", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ── Suppress on hard bounce or complaint ───────────────────────────────────
  if (recipient && (sesEventType === "Bounce" || sesEventType === "Complaint")) {
    const bounce = sesEvent["bounce"] as Record<string, unknown> | undefined;
    const bounceType = bounce?.["bounceType"] as string | undefined;

    if (sesEventType === "Complaint" || bounceType === "Permanent") {
      await supabase
        .from("list_members")
        .update({
          status: "unsubscribed",
          unsubscribed_at: new Date().toISOString(),
        })
        .eq("email", recipient)
        .eq("status", "active");
    }
  }

  return NextResponse.json({ ok: true, event_type: eventType });
}
