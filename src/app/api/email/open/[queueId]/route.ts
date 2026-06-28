import { parseUuid } from "@/lib/ids";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { Json } from "@/supabase/types";

export const dynamic = "force-dynamic";

const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

type QueueOpenRow = {
  id: string;
  email_id: string | null;
  payload: unknown;
  ses_message_id: string | null;
};

function imageResponse() {
  return new Response(TRANSPARENT_GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Expires": "0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function payloadToRecipient(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as { to?: unknown }).to;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ queueId: string }> },
) {
  const { queueId: rawQueueId } = await params;
  const queueId = parseUuid(rawQueueId);
  if (!queueId) return imageResponse();

  try {
    const supabase = getSupabaseAdmin();
    const { data: queueRow, error } = await supabase
      .from("mail_queue")
      .select("id, email_id, payload, ses_message_id")
      .eq("id", queueId)
      .maybeSingle();

    const row = queueRow as QueueOpenRow | null;
    if (!error && row) {
      const userAgent = request.headers.get("user-agent");
      const payload = {
        source: "tracking_pixel",
        queue_id: row.id,
        user_agent: userAgent,
      };

      await supabase.from("provider_events").insert({
        provider: "props",
        event_type: "opened",
        message_id: row.ses_message_id ?? row.id,
        recipient: payloadToRecipient(row.payload),
        email_id: row.email_id,
        payload: payload as Json,
      });
    }
  } catch (error) {
    console.warn("[open tracking] failed to record open event", error);
  }

  return imageResponse();
}
