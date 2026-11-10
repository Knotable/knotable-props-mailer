# Rationalizing Supabase storage (2026-11-10)

**Observed:** Database Size 1.375 GB against a 0.5 GB free-plan limit (275%),
grace period ends 19 Nov 2026. Log Query at 135% is a separate, unrelated
meter (log *retention*, not database disk) and is not addressed by anything
here.

## The likely reason deleting rows did not help

Postgres does not return space to the operating system when rows are deleted
or updated. `DELETE` marks tuples dead; plain `VACUUM` (which the worker runs
every 5,000 accepted recipients, and which autovacuum runs) marks those pages
reusable *by that same table*. The file on disk stays at its high-water mark.
Only `VACUUM FULL`, `REINDEX`, or `pg_repack` rewrite the relation and shrink
the files.

That matters here because of how this system has been used:

- The 180k send rewrote every `mail_queue` row twice (held → processing →
  terminal). Each rewrite leaves a dead copy plus index entries. The measured
  model in README-AI.md is 145 MB queued → 417 MB after the send.
- The 2026-08-10 archive-and-purge (`scripts/archive-database-history.mjs`)
  deleted ~449k queue rows, ~804k error-log rows and ~143k provider events.
  Logically the data is gone; physically the files are still the size they
  were at peak.
- `provider_events` carried the fat pre-2026-09-30 payload (2–3 KB of repeated
  headers per row) for most of its life.

So the first thing to do is not delete more data — it is to reclaim what has
already been deleted. **Measure before cutting anything.**

## Step 1 — measure (5 minutes, read-only)

Run `scripts/sql/storage-audit.sql` in the Supabase SQL editor, or open
`/email/storage` in the app. The numbers to look at:

- **Section 2:** `total` vs `live_rows` per table. Any table with a large
  `total` and few `live_rows` is pure bloat.
- **Section 3:** indexes with `scans = 0`. `provider_events` carries seven
  indexes; `list_members` five, two of which overlap.
- **Section 7:** a stuck replication slot retains WAL indefinitely. Rare, but
  it alone can account for hundreds of MB and nothing else will fix it.

## Step 2 — reclaim, in order of expected return

Run from `scripts/sql/storage-reclaim.sql`, **between sends only**.

1. **`VACUUM FULL` + `REINDEX` on `mail_queue`, `provider_events`,
   `error_logs`, `queue_metrics`.** Free, loses nothing, and on this history
   is the single largest expected win — plausibly several hundred MB. Note
   `VACUUM FULL` takes an exclusive lock and needs scratch disk the size of
   the rewritten table, so go one table at a time, largest first.
2. **Compact finished campaigns** (`compact_campaign_history`). It folds the
   per-recipient ledger into ~9 bytes per recipient and deletes the terminal
   queue rows. Campaigns that started sending before the 2026-09-30 migration
   are refused by the function and need `scripts/archive-database-history.mjs`
   instead.
3. **Retention on the event tables.** Opens/delivers/clicks older than 90 days
   are superseded by the ledger flags and `ses_event_counters`; error logs and
   queue metrics older than 30 days are read by nothing. Delete, then
   `VACUUM FULL` those tables (step 1 again — the delete alone does nothing).
4. **Drop never-scanned indexes** identified in section 3 of the audit. On a
   246k-row `list_members` each redundant index is tens of MB.
   `20260930_drop_redundant_queue_indexes.sql` already covers three on
   `mail_queue` — confirm it has actually been applied.

## Step 3 — what the real floor looks like

After reclamation the irreducible content is roughly:

- `list_members`, ~246k rows across 16 lists, plus five indexes. This is the
  real data and it is probably 100–150 MB. It can be trimmed: members that
  are `unsubscribed`, `bounced` or `blocked` only need address + status, not
  `metadata jsonb` or `source`; nulling `metadata` on non-active members is a
  meaningful cut if that column was populated by the imports.
- `email_delivery_archive`, ~1.75 MB per 200k-recipient campaign. Cheap.
- `emails`, `lists`, `app_settings`, rollups. Small.

If that lands under ~400 MB, the free plan holds with headroom for a send. If
it does not, the honest answer is Supabase Pro at $25/mo for 8 GB — the
engineering time to squeeze a 246k-member list into 500 MB is worth more than
that, and the free-tier ceiling has now caused two incidents.

## Step 4 — stop it recurring

- Confirm the GitHub secret `SUPABASE_DB_CONNECTION` is set. Without it the
  worker's in-send `VACUUM` does not run and the queue balloons to the 417 MB
  shape rather than the 174 MB one.
- Confirm `20260930_delivery_ledger.sql` and
  `20260930_drop_redundant_queue_indexes.sql` are applied in production. The
  README still lists their application status as unverified, and without them
  none of the per-send savings exist.
- Leave `SES_COMPACT_HISTORY` on so compaction runs an hour after each results
  report rather than waiting for a manual purge.
- Check `/email/storage` ("what if I send to N") before each large send.
