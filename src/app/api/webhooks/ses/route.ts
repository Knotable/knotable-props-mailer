/**
 * POST /api/webhooks/ses
 *
 * Receives SNS notifications from Amazon SES and writes events into
 * the `provider_events` table so the analytics page can display them.
 *
 * AWS setup (one-time, manual):
 *  1. In SES → Configuration Sets → your set → Event Destinations, add an
 *     SNS destination for the event types you care about (Delivery, Bounce,
 *     Complaint, Open, Click, Send, Reject).
 *  2. Create an SNS topic, subscribe this URL:
 *       https://<your-domain>/api/webhooks/ses
 *  3. SNS sends a SubscriptionConfirmation first — this handler auto-confirms it.
 *
 * SES event types mapped to provider_events.event_type:
 *   Send        → "sent"
 *   Delivery    → "delivered"
 *   Bounce      → "bounced"
 *   Complaint   → "complained"
 *   Open        → "opened"
 *   Click       → "clicked"
 *   Reject      → "rejected"
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// Map SES event types to our internal event_type values
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

export async function POST(request: Request) {
  let body: Record<string, unknown>;

  try {
    const text = await request.text();
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messageType = body["Type"] as string | undefined;

  // ── SNS Subscription Confirmation ──────────────────────────────────────────
  // SNS sends this once when you first subscribe the endpoint.
  // We must GET the SubscribeURL to confirm the subscription.
  if (messageType === "SubscriptionConfirmation") {
    const subscribeUrl = body["SubscribeURL"] as string | undefined;
    if (!subscribeUrl) {
      return NextResponse.json({ error: "Missing SubscribeURL" }, { status: 400 });
    }

    // Validate the URL is from SNS (security check)
    try {
      const url = new URL(subscribeUrl);
      if (!url.hostname.endsWith(".amazonaws.com")) {
        return NextResponse.json({ error: "Invalid SubscribeURL host" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Malformed SubscribeURL" }, { status: 400 });
    }

    // Confirm the subscription
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
    // Unsubscribe confirmation or unknown type — acknowledge and ignore
    return NextResponse.json({ ok: true, action: "ignored" });
  }

  // The SES event payload is JSON-encoded inside the SNS Message field
  let sesEvent: Record<string, unknown>;
  try {
    sesEvent = JSON.parse(body["Message"] as string);
  } catch {
    return NextResponse.json({ error: "Could not parse SNS Message as JSON" }, { status: 400 });
  }

  const sesEventType = sesEvent["eventType"] as string | undefined;
  if (!sesEventType) {
    // Some SNS test messages have no eventType — ignore them
    return NextResponse.json({ ok: true, action: "ignored_no_event_type" });
  }

  const eventType = SES_EVENT_MAP[sesEventType] ?? sesEventType.toLowerCase();
  const mail = sesEvent["mail"] as Record<string, unknown> | undefined;
  const messageId = (mail?.["messageId"] as string | undefined) ?? null;

  // Extract recipient from the event-specific sub-object
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
  } else if (sesEventType === "Open" || sesEventType === "Click") {
    const commonHeaders = mail?.["commonHeaders"] as Record<string, unknown> | undefined;
    const to = commonHeaders?.["to"] as string[] | undefined;
    recipient = to?.[0] ?? null;
  } else if (sesEventType === "Send") {
    const commonHeaders = mail?.["commonHeaders"] as Record<string, unknown> | undefined;
    const to = commonHeaders?.["to"] as string[] | undefined;
    recipient = to?.[0] ?? null;
  }

  // Look up the email_id from mail_queue using ses_message_id
  const supabase = getSupabaseAdmin();
  let emailId: string | null = null;

  if (messageId) {
    const { data: queueRow } = await supabase
      .from("mail_queue")
      .select("email_id")
      .eq("ses_message_id", messageId)
      .maybeSingle();
    emailId = queueRow?.email_id ?? null;
  }

  // Insert into provider_events
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

  // On bounce or complaint, mark the list member as unsubscribed
  if (recipient && (sesEventType === "Bounce" || sesEventType === "Complaint")) {
    const bounce = sesEvent["bounce"] as Record<string, unknown> | undefined;
    const bounceType = bounce?.["bounceType"] as string | undefined;

    // Only permanently unsubscribe on hard bounces or complaints
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
