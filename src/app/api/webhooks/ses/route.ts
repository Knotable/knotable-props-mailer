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
import { logError } from "@/lib/logger";
import { checkRateLimitSync } from "@/lib/rateLimit";

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

function verifyWithAlgorithm(algorithm: string, pem: string, stringToSign: string, signature: string): boolean {
  const verifier = createVerify(algorithm);
  verifier.update(stringToSign, "utf8");
  verifier.end();
  return verifier.verify(pem, Buffer.from(signature, "base64"));
}

async function verifySnsSignature(body: Record<string, unknown>): Promise<{ valid: boolean; reason?: string }> {
  try {
    const certUrl = body["SigningCertURL"] as string | undefined;
    const signature = body["Signature"] as string | undefined;
    const sigVer = body["SignatureVersion"] as string | undefined;
    if (!certUrl || !signature) return { valid: false, reason: "missing_cert_or_signature" };

    const algorithms = sigVer === "2"
      ? ["RSA-SHA256", "sha256WithRSAEncryption"]
      : ["RSA-SHA1", "sha1WithRSAEncryption"];
    const pem = await fetchSigningCert(certUrl);
    const stringsToSign = [buildStringToSign(body)];

    for (const stringToSign of stringsToSign) {
      for (const algorithm of algorithms) {
        if (verifyWithAlgorithm(algorithm, pem, stringToSign, signature)) {
          return { valid: true };
        }
      }
    }

    return { valid: false, reason: "signature_mismatch" };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function expectedSnsTopicArn(): string | null {
  return process.env.AWS_SES_SNS_TOPIC_ARN?.trim() || null;
}

function isExpectedTopic(body: Record<string, unknown>): boolean {
  const expected = expectedSnsTopicArn();
  if (!expected) return true;
  return body["TopicArn"] === expected;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function extractRecipient(sesEventType: string, sesEvent: Record<string, unknown>): string | null {
  const mail = sesEvent["mail"] as Record<string, unknown> | undefined;
  const destination = toStringArray(mail?.["destination"]);

  if (sesEventType === "Delivery") {
    const delivery = sesEvent["delivery"] as Record<string, unknown> | undefined;
    return toStringArray(delivery?.["recipients"])[0] ?? destination[0] ?? null;
  }

  if (sesEventType === "Bounce") {
    const bounce = sesEvent["bounce"] as Record<string, unknown> | undefined;
    const recipients = bounce?.["bouncedRecipients"] as Array<Record<string, unknown>> | undefined;
    return (recipients?.[0]?.["emailAddress"] as string | undefined) ?? destination[0] ?? null;
  }

  if (sesEventType === "Complaint") {
    const complaint = sesEvent["complaint"] as Record<string, unknown> | undefined;
    const recipients = complaint?.["complainedRecipients"] as Array<Record<string, unknown>> | undefined;
    return (recipients?.[0]?.["emailAddress"] as string | undefined) ?? destination[0] ?? null;
  }

  const commonHeaders = mail?.["commonHeaders"] as Record<string, unknown> | undefined;
  return toStringArray(commonHeaders?.["to"])[0] ?? destination[0] ?? null;
}

async function logWebhookFailure(message: string, payload: Record<string, unknown>) {
  try {
    await logError({
      source: "ses-webhook",
      message,
      payload,
    });
  } catch (err) {
    console.warn("[ses-webhook] failed to write error log", err);
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
  // Avoid two database operations per SNS delivery. During a large campaign,
  // DB-backed webhook limiting amplifies SNS retries precisely when Supabase
  // is under pressure. SNS signature verification below remains authoritative.
  const { allowed } = checkRateLimitSync(`ses-webhook:${ip}`, 30, 60_000);
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
  const signatureVerification = await verifySnsSignature(body);
  if (!signatureVerification.valid) {
    console.warn("[ses-webhook] SNS signature verification failed");
    await logWebhookFailure("SNS signature verification failed", {
      messageType,
      topicArn: body["TopicArn"],
      signingCertUrl: body["SigningCertURL"],
      signatureVersion: body["SignatureVersion"],
      reason: signatureVerification.reason,
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (!isExpectedTopic(body)) {
    console.warn("[ses-webhook] unexpected SNS topic", body["TopicArn"]);
    await logWebhookFailure("Unexpected SNS topic", {
      messageType,
      topicArn: body["TopicArn"],
      expectedTopicArn: expectedSnsTopicArn(),
    });
    return NextResponse.json({ error: "Unexpected topic" }, { status: 403 });
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
      const confirmResponse = await fetch(subscribeUrl);
      if (!confirmResponse.ok) {
        throw new Error(`SNS confirmation returned HTTP ${confirmResponse.status}`);
      }
      console.info("[ses-webhook] SNS subscription confirmed");
    } catch (err) {
      console.error("[ses-webhook] Failed to confirm SNS subscription", err);
      await logWebhookFailure("Subscription confirmation failed", {
        error: err instanceof Error ? err.message : String(err),
        topicArn: body["TopicArn"],
      });
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
    await logWebhookFailure("Could not parse SNS Message as JSON", {
      messageType,
      topicArn: body["TopicArn"],
      messageId: body["MessageId"],
    });
    return NextResponse.json({ error: "Could not parse SNS Message as JSON" }, { status: 400 });
  }

  const sesEventType = sesEvent["eventType"] as string | undefined;
  if (!sesEventType) {
    return NextResponse.json({ ok: true, action: "ignored_no_event_type" });
  }

  const eventType = SES_EVENT_MAP[sesEventType] ?? sesEventType.toLowerCase();
  const mail = sesEvent["mail"] as Record<string, unknown> | undefined;
  const messageId = (mail?.["messageId"] as string | undefined) ?? null;
  const recipient = extractRecipient(sesEventType, sesEvent);

  const supabase = getSupabaseAdmin();

  // ── Deduplication ──────────────────────────────────────────────────────────
  // SNS guarantees at-least-once delivery; retries after a 500 would create
  // duplicate rows without this check. Open and Click are engagement events,
  // so retain repeated opens/clicks instead of collapsing them to one row.
  if (messageId && sesEventType !== "Open" && sesEventType !== "Click") {
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
  let queueId: string | null = null;
  if (messageId) {
    const { data: queueRow } = await supabase
      .from("mail_queue")
      .select("email_id")
      .eq("ses_message_id", messageId)
      .maybeSingle();
    emailId = queueRow?.email_id ?? null;
  }

  // The bulk worker tags each destination with its durable queue id. This is
  // the recovery path for the narrow crash window where SES accepted a batch
  // but the worker exited before it checkpointed the returned message ids.
  const mailTags = mail?.["tags"] as Record<string, unknown> | undefined;
  const taggedQueueIds = toStringArray(mailTags?.["queue_id"]);
  if (taggedQueueIds[0] && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taggedQueueIds[0])) {
    queueId = taggedQueueIds[0];
    const { data: taggedQueueRow } = await supabase
      .from("mail_queue")
      .select("email_id, status")
      .eq("id", queueId)
      .maybeSingle();
    emailId = emailId ?? taggedQueueRow?.email_id ?? null;

    if (messageId && taggedQueueRow?.status === "processing" && sesEventType === "Send") {
      const now = new Date();
      await supabase
        .from("mail_queue")
        .update({
          status: "succeeded",
          ses_message_id: messageId,
          send_date: now.toISOString().slice(0, 10),
          locked_at: null,
          last_error: null,
          updated_at: now.toISOString(),
        })
        .eq("id", queueId)
        .eq("status", "processing");
    }
  }

  if (!emailId) {
    const commonHeaders = mail?.["commonHeaders"] as Record<string, unknown> | undefined;
    const subject = commonHeaders?.["subject"];
    if (typeof subject === "string" && subject.trim()) {
      const { data: matches } = await supabase
        .from("emails")
        .select("id")
        .eq("subject", subject.trim())
        .limit(2);
      if (matches?.length === 1) emailId = matches[0].id;
    }
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
    await logWebhookFailure("Failed to insert provider_event", {
      error: error.message,
      eventType,
      messageId,
      recipient,
      emailId,
    });
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
