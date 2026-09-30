// Delivered/opened SES events are flagged on the delivery ledger instead of
// stored as provider_events rows (see deliveryLedger.ts). The webhook keeps a
// tiny per-day counter for them (table ses_event_counters) so account-wide
// totals and "when did we last hear from SES" stay accurate.

export type CounterRow = { day: string; event_type: string; events: number | string; updated_at: string };

export type FlaggedEventActivity = {
  total: number;
  recent: number;
  totalByType: Record<string, number>;
  recentByType: Record<string, number>;
  latestAt: string | null;
};

export const EMPTY_ACTIVITY: FlaggedEventActivity = { total: 0, recent: 0, totalByType: {}, recentByType: {}, latestAt: null };

export function summarizeCounters(rows: CounterRow[], sinceIso: string): FlaggedEventActivity {
  const sinceDay = sinceIso.slice(0, 10);
  const activity: FlaggedEventActivity = { total: 0, recent: 0, totalByType: {}, recentByType: {}, latestAt: null };
  for (const row of rows) {
    const events = Number(row.events) || 0;
    activity.total += events;
    activity.totalByType[row.event_type] = (activity.totalByType[row.event_type] ?? 0) + events;
    if (row.day >= sinceDay) {
      activity.recent += events;
      activity.recentByType[row.event_type] = (activity.recentByType[row.event_type] ?? 0) + events;
    }
    if (!activity.latestAt || row.updated_at > activity.latestAt) activity.latestAt = row.updated_at;
  }
  return activity;
}

type CounterClient = {
  from: (table: string) => {
    select: (columns: string) => { order: (column: string, options: { ascending: boolean }) => { limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }> } };
  };
};

// Never throws: before the migration is applied the table does not exist and
// the activity is simply zero.
export async function getFlaggedEventActivity(client: unknown, sinceIso: string): Promise<FlaggedEventActivity> {
  try {
    const { data, error } = await (client as CounterClient)
      .from("ses_event_counters")
      .select("day, event_type, events, updated_at")
      .order("day", { ascending: false })
      .limit(2_000);
    if (error || !Array.isArray(data)) return EMPTY_ACTIVITY;
    return summarizeCounters(data as CounterRow[], sinceIso);
  } catch {
    return EMPTY_ACTIVITY;
  }
}

export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (a && b) return a > b ? a : b;
  return a ?? b ?? null;
}
