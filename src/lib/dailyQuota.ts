/**
 * Daily send-quota helpers.
 *
 * SES production quota: 50,000 emails / 24-hour period.
 * We cap at DAILY_SEND_LIMIT (45,000) to leave a safety buffer.
 */

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const DAILY_SEND_LIMIT = 45_000;

/** Returns today's date string in UTC (YYYY-MM-DD). */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns how many queue items have already been marked `succeeded` today (UTC).
 */
export async function getDailySentCount(date: string = todayUTC()): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("mail_queue")
    .select("id", { count: "exact", head: true })
    .eq("send_date", date)
    .eq("status", "succeeded");

  if (error) throw error;
  return count ?? 0;
}

/**
 * Returns how many more emails can be sent today.
 */
export async function getRemainingQuota(date: string = todayUTC()): Promise<number> {
  const sent = await getDailySentCount(date);
  return Math.max(0, DAILY_SEND_LIMIT - sent);
}

/**
 * Given a total recipient count and a start date, returns an array of
 * { date: string; count: number } objects describing how many to send on
 * each calendar day, respecting the daily cap.
 *
 * @param total      Total number of recipients.
 * @param alreadySentToday  Emails already sent today (so first day gets a reduced slot).
 * @param startDate  Starting calendar date (YYYY-MM-DD), defaults to today.
 */
export function buildSendSchedule(
  total: number,
  alreadySentToday: number,
  startDate: string = todayUTC()
): Array<{ date: string; count: number }> {
  const schedule: Array<{ date: string; count: number }> = [];
  let remaining = total;

  const date = new Date(startDate + "T00:00:00Z");

  // First day: respect whatever quota is left today.
  const firstSlot = Math.min(remaining, Math.max(0, DAILY_SEND_LIMIT - alreadySentToday));
  if (firstSlot > 0) {
    schedule.push({ date: startDate, count: firstSlot });
    remaining -= firstSlot;
  }

  // Subsequent days: full DAILY_SEND_LIMIT each.
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const dayStr = date.toISOString().slice(0, 10);
    const chunk = Math.min(remaining, DAILY_SEND_LIMIT);
    schedule.push({ date: dayStr, count: chunk });
    remaining -= chunk;
  }

  return schedule;
}
