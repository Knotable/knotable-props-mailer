const DAY_MS = 24 * 60 * 60 * 1000;

export function isoDaysAgo(days: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

export function isoDateDaysAgo(days: number, nowMs: number = Date.now()): string {
  return isoDaysAgo(days, nowMs).slice(0, 10);
}
