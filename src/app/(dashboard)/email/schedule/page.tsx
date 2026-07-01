import Link from "next/link";
import { requireServerAuthContext } from "@/lib/authAccess";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ScheduleActions, QueueSafetyNotice } from "./schedule-actions";
import { RecipientBadges } from "./recipient-badges";

const QUEUE_LOOKUP_PAGE_SIZE = 1_000;
const MAX_GLOBAL_ACTIVE_QUEUE_ROWS = 20_000;
const DIRECT_RECIPIENTS_ID = "__direct_recipients__";
const ACTIVE_QUEUE_STATUSES = ["pending", "processing"] as const;

type ScheduleQueueRow = {
  id: string;
  email_id: string | null;
  list_id: string | null;
  status: string | null;
  available_at: string | null;
};

type ScheduleQueueSampleRow = {
  email_id: string | null;
  list_id: string | null;
  payload: unknown;
};

type ScheduleEmailRow = {
  id: string;
  subject: string | null;
  from_address: string | null;
  status: "draft" | "queued" | "sending" | "sent" | "failed" | "canceled" | string | null;
  created_at: string | null;
  updated_at: string | null;
};

async function loadQueueRowsForEmailIds(
  admin: ReturnType<typeof getSupabaseAdmin>,
  emailIds: string[],
) {
  if (emailIds.length === 0) return [] as ScheduleQueueRow[];

  const rows: ScheduleQueueRow[] = [];
  for (let from = 0; ; from += QUEUE_LOOKUP_PAGE_SIZE) {
    const { data, error } = await admin
      .from("mail_queue")
      .select("id, email_id, list_id, status, available_at")
      .in("email_id", emailIds)
      .in("status", [...ACTIVE_QUEUE_STATUSES])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + QUEUE_LOOKUP_PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data ?? []) as ScheduleQueueRow[]));
    if (!data || data.length < QUEUE_LOOKUP_PAGE_SIZE) break;
  }

  return rows;
}

async function loadGlobalActiveQueueRows(admin: ReturnType<typeof getSupabaseAdmin>) {
  const rows: ScheduleQueueRow[] = [];
  for (let from = 0; from < MAX_GLOBAL_ACTIVE_QUEUE_ROWS; from += QUEUE_LOOKUP_PAGE_SIZE) {
    const { data, error } = await admin
      .from("mail_queue")
      .select("id, email_id, list_id, status, available_at")
      .in("status", [...ACTIVE_QUEUE_STATUSES])
      .order("available_at", { ascending: true })
      .range(from, from + QUEUE_LOOKUP_PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data ?? []) as ScheduleQueueRow[]));
    if (!data || data.length < QUEUE_LOOKUP_PAGE_SIZE) break;
  }

  return {
    rows,
    truncated: rows.length >= MAX_GLOBAL_ACTIVE_QUEUE_ROWS,
  };
}

async function loadRecipientSamplesForEmailIds(
  admin: ReturnType<typeof getSupabaseAdmin>,
  emailIds: string[],
) {
  const entries = await Promise.all(
    emailIds.map(async (emailId) => {
      const { data, error } = await admin
        .from("mail_queue")
        .select("email_id, list_id, payload")
        .eq("email_id", emailId)
        .in("status", [...ACTIVE_QUEUE_STATUSES])
        .order("available_at", { ascending: true })
        .limit(40);

      if (error) throw error;
      return [emailId, (data ?? []) as ScheduleQueueSampleRow[]] as const;
    }),
  );

  return entries.flatMap(([, rows]) => rows);
}

function payloadToEmail(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as { to?: unknown }).to;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export default async function SchedulePage() {
  const auth = await requireServerAuthContext();
  const admin = getSupabaseAdmin();

  const { data: emails } = await admin
    .from("emails")
    .select("id, subject, from_address, status, created_at, updated_at")
    .in("status", ["draft", "queued", "sending"])
    .order("updated_at", { ascending: false })
    .limit(50);

  const baseEmails = ((emails ?? []) as ScheduleEmailRow[]);
  const baseEmailIds = baseEmails.map((e) => e.id);
  const activeQueueSummary = await loadGlobalActiveQueueRows(admin);
  const activeQueueRows = activeQueueSummary.rows;
  const activeEmailIds = [
    ...new Set(activeQueueRows.map((row) => row.email_id).filter((id): id is string => Boolean(id))),
  ];
  const missingActiveEmailIds = activeEmailIds.filter((id) => !baseEmailIds.includes(id));
  const { data: missingActiveEmails } = missingActiveEmailIds.length
    ? await admin
        .from("emails")
        .select("id, subject, from_address, status, created_at, updated_at")
        .in("id", missingActiveEmailIds)
    : { data: [] as ScheduleEmailRow[] };

  const emailMap = new Map<string, ScheduleEmailRow>();
  for (const email of [...baseEmails, ...((missingActiveEmails ?? []) as ScheduleEmailRow[])]) {
    emailMap.set(email.id, email);
  }

  const emailIds = [...emailMap.keys()];
  const visibleQueueRows = await loadQueueRowsForEmailIds(admin, emailIds);
  const recipientSampleRows = await loadRecipientSamplesForEmailIds(admin, emailIds);
  const queueRowKeys = new Set<string>();
  const queueRows: ScheduleQueueRow[] = [];
  for (const row of [...visibleQueueRows, ...activeQueueRows]) {
    if (queueRowKeys.has(row.id)) continue;
    queueRowKeys.add(row.id);
    queueRows.push(row);
  }

  // Unique list IDs across all emails
  const listIds = [...new Set(queueRows.map((r) => r.list_id).filter(Boolean) as string[])];

  const [{ data: lists }] = await Promise.all([
    listIds.length
      ? admin.from("lists").select("id, name, address").in("id", listIds)
      : Promise.resolve({ data: [] as { id: string; name: string; address: string }[] }),
  ]);

  const queuedCountByEmailList = new Map<string, number>();
  const samplesByEmailList = new Map<string, string[]>();
  const statusCountsByEmail = new Map<string, Map<string, number>>();
  const activeCountsByEmail = new Map<
    string,
    { pendingDue: number; pendingHeld: number; processing: number }
  >();
  const nowMs = Date.now();
  for (const row of queueRows) {
    if (!row.email_id) continue;
    const groupId = row.list_id ?? DIRECT_RECIPIENTS_ID;
    const key = `${row.email_id}:${groupId}`;
    queuedCountByEmailList.set(key, (queuedCountByEmailList.get(key) ?? 0) + 1);
    const statusCounts = statusCountsByEmail.get(row.email_id) ?? new Map<string, number>();
    const status = row.status ?? "unknown";
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    statusCountsByEmail.set(row.email_id, statusCounts);

    if (status === "pending" || status === "processing") {
      const activeCounts = activeCountsByEmail.get(row.email_id) ?? {
        pendingDue: 0,
        pendingHeld: 0,
        processing: 0,
      };
      if (status === "processing") {
        activeCounts.processing += 1;
      } else if (row.available_at && new Date(row.available_at).getTime() > nowMs) {
        activeCounts.pendingHeld += 1;
      } else {
        activeCounts.pendingDue += 1;
      }
      activeCountsByEmail.set(row.email_id, activeCounts);
    }

  }

  for (const row of recipientSampleRows) {
    if (!row.email_id) continue;
    const groupId = row.list_id ?? DIRECT_RECIPIENTS_ID;
    const key = `${row.email_id}:${groupId}`;
    const sample = payloadToEmail(row.payload);
    if (!sample) continue;
    const samples = samplesByEmailList.get(key) ?? [];
    if (samples.length < 20 && !samples.includes(sample)) samples.push(sample);
    samplesByEmailList.set(key, samples);
  }

  const listMap = new Map(
    (lists ?? []).map((l) => [
      l.id,
      {
        id: l.id,
        name: l.name,
        address: l.address,
      },
    ])
  );

  // Build email_id → lists[]
  const listsByEmail = new Map<string, { id: string; name: string; address: string; memberCount: number; sampleEmails: string[] }[]>();
  for (const row of queueRows) {
    if (!row.email_id) continue;
    const groupId = row.list_id ?? DIRECT_RECIPIENTS_ID;
    const list = row.list_id
      ? listMap.get(row.list_id)
      : {
          id: DIRECT_RECIPIENTS_ID,
          name: "Direct recipients",
          address: "No list recorded",
        };
    if (!list) continue;
    const key = `${row.email_id}:${groupId}`;
    const arr = listsByEmail.get(row.email_id) ?? [];
    if (!arr.find((l) => l.id === list.id)) {
      arr.push({
        ...list,
        memberCount: queuedCountByEmailList.get(key) ?? 0,
        sampleEmails: samplesByEmailList.get(key) ?? [],
      });
    }
    listsByEmail.set(row.email_id, arr);
  }

  const visibleEmails = [...emailMap.values()].sort((a, b) => {
    const aActive = activeCountsByEmail.has(a.id) ? 1 : 0;
    const bActive = activeCountsByEmail.has(b.id) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return String(b.updated_at ?? b.created_at ?? "").localeCompare(
      String(a.updated_at ?? a.created_at ?? ""),
    );
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Queue</p>
          <h2 className="text-2xl font-semibold text-slate-900">Drafts &amp; Active Queue</h2>
          <p className="text-sm text-slate-500">
            Drafts, manually held mailings, and campaigns with unsent queue rows.
          </p>
        </div>
        <QueueSafetyNotice />
      </header>

      {activeQueueRows.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-medium">
            {activeQueueRows.length.toLocaleString()} active unsent queue row{activeQueueRows.length === 1 ? "" : "s"} found.
          </span>{" "}
          Campaigns with due, held, or processing rows are listed first below.
          {activeQueueSummary.truncated && (
            <span className="block text-xs text-amber-700">
              Showing the first {MAX_GLOBAL_ACTIVE_QUEUE_ROWS.toLocaleString()} active rows; narrow by campaign before draining.
            </span>
          )}
        </div>
      )}

      <div className="divide-y rounded-lg border border-slate-200">
        {visibleEmails.length ? (
          visibleEmails.map((item) => {
            const isDraft = item.status === "draft";
            const updatedIso = item.updated_at ?? null;
            const itemLists = listsByEmail.get(item.id) ?? [];
            const statusCounts = statusCountsByEmail.get(item.id);
            const activeCounts = activeCountsByEmail.get(item.id);
            const hasActiveQueue = Boolean(
              activeCounts &&
                activeCounts.pendingDue + activeCounts.pendingHeld + activeCounts.processing > 0,
            );
            const displayStatus = isDraft
              ? "Draft"
              : item.status === "sending"
                ? "Sending"
                : hasActiveQueue
                  ? "Unsent"
                  : item.status === "queued"
                    ? "Queued"
                    : item.status ?? "Unknown";

            return (
              <div
                key={item.id}
                className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                        isDraft
                          ? "bg-slate-100 text-slate-600"
                          : hasActiveQueue
                            ? "bg-amber-100 text-amber-800"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {displayStatus}
                    </span>
                    <p className="min-w-0 truncate text-sm font-medium text-slate-800 sm:text-base">
                      {item.subject || "(no subject)"}
                    </p>
                  </div>

                  <div className="text-sm text-slate-500">
                    <span>
                      From: {item.from_address || "unknown sender"} ·{" "}
                      {isDraft
                        ? updatedIso
                          ? `Updated ${updatedIso.replace("T", " ").slice(0, 16)} UTC`
                          : "Draft only"
                        : updatedIso
                          ? `Queued for manual send · Updated ${updatedIso.replace("T", " ").slice(0, 16)} UTC`
                          : "Queued for manual send"}
                    </span>
                  </div>

                  {statusCounts && (
                    <QueueStatusSummary
                      statusCounts={statusCounts}
                      activeCounts={activeCounts}
                    />
                  )}

                  {itemLists.length > 0 && (
                    <RecipientBadges lists={itemLists} />
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:justify-self-end">
                  {!isDraft && (
                    <Link
                      href={`/api/email/preview/${item.id}`}
                      target="_blank"
                      className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Preview
                    </Link>
                  )}
                  {!isDraft && (
                    <Link
                      href={`/email/monitor?emailId=${item.id}`}
                      className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Monitor
                    </Link>
                  )}
                  {(isDraft || item.status === "sent" || item.status === "failed" || item.status === "canceled") && (
                    <Link
                      href={`/email/composer?id=${item.id}`}
                      className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {isDraft ? "Edit" : "Open"}
                    </Link>
                  )}
                  {isScheduleActionStatus(item.status) ? (
                    <ScheduleActions
                      id={item.id}
                      subject={item.subject ?? ""}
                      status={item.status}
                      canSend={auth.canSend}
                    />
                  ) : null}
                </div>
              </div>
            );
          })
        ) : (
          <p className="p-6 text-sm text-slate-500">No drafts or queued emails.</p>
        )}
      </div>
    </div>
  );
}

function QueueStatusSummary({
  statusCounts,
  activeCounts,
}: {
  statusCounts: Map<string, number>;
  activeCounts?: { pendingDue: number; pendingHeld: number; processing: number };
}) {
  const orderedStatuses = ["pending", "processing", "succeeded", "failed", "dead", "canceled"];
  const total = [...statusCounts.values()].reduce((sum, count) => sum + count, 0);
  const activeTotal = activeCounts
    ? activeCounts.pendingDue + activeCounts.pendingHeld + activeCounts.processing
    : 0;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-slate-500">
        {total.toLocaleString()} queued recipient{total === 1 ? "" : "s"}
      </span>
      {activeTotal > 0 && (
        <>
          <span className="font-medium text-amber-700">
            {activeCounts?.pendingDue.toLocaleString()} due
          </span>
          <span className="font-medium text-blue-700">
            {activeCounts?.processing.toLocaleString()} processing
          </span>
          <span className="font-medium text-slate-500">
            {activeCounts?.pendingHeld.toLocaleString()} held
          </span>
        </>
      )}
      {orderedStatuses.map((status) => {
        const count = statusCounts.get(status) ?? 0;
        if (count === 0) return null;
        return (
          <span key={status} className={queueStatusClassName(status)}>
            {count.toLocaleString()} {status}
          </span>
        );
      })}
    </div>
  );
}

function queueStatusClassName(status: string) {
  if (status === "succeeded") return "font-medium text-green-700";
  if (status === "failed" || status === "dead") return "font-medium text-red-600";
  if (status === "pending" || status === "processing") return "font-medium text-amber-600";
  if (status === "canceled") return "font-medium text-slate-500";
  return "font-medium text-slate-400";
}

function isScheduleActionStatus(status: ScheduleEmailRow["status"]): status is "draft" | "queued" | "sending" {
  return status === "draft" || status === "queued" || status === "sending";
}
