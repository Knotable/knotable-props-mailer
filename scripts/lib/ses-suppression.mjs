// SES account-level suppression list → Props list members.
//
// SES silently refuses to deliver to addresses on the account's suppression
// list (bounce subtype "OnAccountSuppressionList"). Props only learns about
// them when it sends and the refusal comes back, so an old list re-queued
// after months can be full of addresses SES will never deliver to. The worker
// periodically pulls the suppression list and marks matching active list
// members unsubscribed (the same treatment the SES webhook gives a hard
// bounce), so the queue's late-suppression check cancels them before sending.

export const SES_SUPPRESSION_SYNC_KEY = "ses_suppression_sync";
export const SES_SUPPRESSION_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;

export function normalizeSuppressedAddresses(summaries) {
  const out = new Set();
  for (const summary of summaries ?? []) {
    const address = String(summary?.EmailAddress ?? "").trim().toLowerCase();
    if (address.includes("@")) out.add(address);
  }
  return [...out];
}

export function suppressionSyncDue(state, nowMs, everyMs = SES_SUPPRESSION_SYNC_EVERY_MS) {
  // Finish a partial pass before anything else (including records written
  // before page tokens were saved, which only say complete: false).
  if (state?.resumeToken || (state && state.complete === false && !state.error)) return true;
  const last = Date.parse(state?.attemptedAt ?? "");
  return !Number.isFinite(last) || nowMs - last >= everyMs;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
