import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

const signingKey = process.env.MAILGUN_SIGNING_KEY || "";

const verifySignature = (timestamp: string, token: string, signature: string) => {
  const hmac = crypto.createHmac("sha256", signingKey);
  hmac.update(timestamp + token);
  return hmac.digest("hex") === signature;
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const signature = body.signature;
  const eventData = body["event-data"];
  if (!signature || !eventData) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (signingKey && !verifySignature(signature.timestamp, signature.token, signature.signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabase = createClient(env.supabase.url!, env.supabase.serviceRoleKey!);
  await supabase.from("provider_events").insert({
    provider: "mailgun",
    event_type: eventData.event,
    message_id: eventData.id,
    recipient: eventData.recipient,
    payload: eventData,
  });

  return NextResponse.json({ ok: true });
}
