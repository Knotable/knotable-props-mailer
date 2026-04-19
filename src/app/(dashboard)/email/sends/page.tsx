import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { SendsClient } from "./sends-client";

export default async function PastSendsPage() {
  const supabase = await createServerSupabaseClient();

  // Get all emails that have at least one queued/sent mail_queue entry
  // Join with mail_queue to get per-email send stats and list info
  const { data: queueRows } = await supabase
    .from("mail_queue")
    .select("email_id, list_id, status, send_date, campaign_label, created_at")
    .in("status", ["succeeded", "failed", "dead", "processing", "pending"])
    .order("created_at", { ascending: false });

  if (!queueRows || queueRows.length === 0) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
          No emails have been queued or sent yet.
        </div>
      </div>
    );
  }

  // Aggregate per email_id: collect unique list_ids, counts by status
  type EmailSummary = {
    email_id: string;
    list_ids: Set<string>;
    sent: number;
    failed: number;
    pending: number;
    first_sent: string | null;
    campaign_labels: Set<string>;
  };

  const emailMap = new Map<string, EmailSummary>();
  for (const row of queueRows) {
    const eid = row.email_id as string;
    if (!eid) continue;
    const existing = emailMap.get(eid);
    const isSent = row.status === "succeeded";
    const isFailed = row.status === "failed" || row.status === "dead";
    const isPending = row.status === "pending" || row.status === "processing";

    if (existing) {
      if (row.list_id) existing.list_ids.add(row.list_id as string);
      if (isSent) existing.sent++;
      if (isFailed) existing.failed++;
      if (isPending) existing.pending++;
      if (isSent && row.send_date && (!existing.first_sent || row.send_date < existing.first_sent)) {
        existing.first_sent = row.send_date as string;
      }
      if (row.campaign_label) existing.campaign_labels.add(row.campaign_label as string);
    } else {
      emailMap.set(eid, {
        email_id: eid,
        list_ids: new Set(row.list_id ? [row.list_id as string] : []),
        sent: isSent ? 1 : 0,
        failed: isFailed ? 1 : 0,
        pending: isPending ? 1 : 0,
        first_sent: isSent ? (row.send_date as string | null) : null,
        campaign_labels: new Set(row.campaign_label ? [row.campaign_label as string] : []),
      });
    }
  }

  // Fetch email details
  const emailIds = [...emailMap.keys()];
  const listIds = [...new Set([...emailMap.values()].flatMap((e) => [...e.list_ids]))];

  const [{ data: emails }, { data: lists }] = await Promise.all([
    supabase
      .from("emails")
      .select("id, subject, from_address, html, status, created_at, updated_at")
      .in("id", emailIds),
    listIds.length
      ? supabase.from("lists").select("id, name, address").in("id", listIds)
      : Promise.resolve({ data: [] as { id: string; name: string; address: string }[] }),
  ]);

  const emailDetails = new Map((emails ?? []).map((e) => [e.id, e]));
  const listDetails = new Map((lists ?? []).map((l) => [l.id, l]));

  // Build final sorted list (most recent first)
  const sends = [...emailMap.entries()]
    .map(([eid, summary]) => {
      const email = emailDetails.get(eid);
      const sendLists = [...summary.list_ids]
        .map((lid) => listDetails.get(lid))
        .filter(Boolean) as { id: string; name: string; address: string }[];

      return {
        email_id: eid,
        subject: email?.subject ?? "(untitled)",
        from_address: email?.from_address ?? "",
        status: email?.status ?? "unknown",
        sent: summary.sent,
        failed: summary.failed,
        pending: summary.pending,
        first_sent: summary.first_sent,
        lists: sendLists,
        created_at: email?.created_at ?? null,
      };
    })
    .sort((a, b) => {
      // Sort by first_sent desc, then created_at desc
      const aDate = a.first_sent ?? a.created_at ?? "";
      const bDate = b.first_sent ?? b.created_at ?? "";
      return bDate.localeCompare(aDate);
    });

  return (
    <div className="space-y-6">
      <Header />
      <SendsClient sends={sends} />
    </div>
  );
}

function Header() {
  return (
    <header>
      <p className="text-xs uppercase tracking-wide text-slate-400">History</p>
      <h2 className="text-2xl font-semibold text-slate-900">Past Sends</h2>
      <p className="text-sm text-slate-500">Emails queued or sent, with delivery stats and preview.</p>
    </header>
  );
}
