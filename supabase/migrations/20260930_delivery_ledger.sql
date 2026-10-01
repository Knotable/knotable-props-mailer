-- Delivery ledger: one tiny row per (campaign, recipient) instead of a full
-- queue row plus ~2 event rows per recipient kept forever.
--
-- What the app needs to remember about a send is "did this address get this
-- email, and did it deliver / open / click / bounce?". That is a few bytes of
-- state, not a 1 KB work-item row and two 500-byte event rows. After this
-- migration:
--   * finalize_ses_bulk_queue_batch records the outcome in email_deliveries
--     in the same transaction that checkpoints the queue row;
--   * the SES webhook sets a flag bit on that row for delivered/opened events
--     (record_delivery_event) instead of inserting a provider_events row;
--     bounces, complaints and clicks still insert a row (they are rare and
--     carry evidence / link detail) and set the flag too;
--   * get_email_provider_analytics_metric counts the flags, so per-campaign
--     analytics stay exact;
--   * compact_campaign_history folds a finished campaign into its
--     email_history_rollups row and deletes its terminal queue rows and its
--     delivered/opened event rows, leaving the ledger as the permanent record.
--   * after compaction the per-recipient rows collapse into one compact array
--     per campaign (email_delivery_archive): ~9 bytes per recipient forever.
-- Measured on 200k recipients: queue rows ~725 B each (plus up to ~2x until
-- vacuumed) and ~2 event rows each, vs ~80 B hot ledger row, ~9 B archived.

-- ── Ledger ──────────────────────────────────────────────────────────────────

-- Recipients are keyed by an 8-byte hash of the normalized address: smaller
-- and faster than address text, and a 64-bit collision inside one campaign
-- (~1e-9 at 200k recipients) could at worst skip one recipient on a re-queue.
create or replace function public.recipient_hash(p_recipient text)
returns bigint
language sql
immutable
parallel safe
as $$
  select ('x' || substr(md5(lower(trim(coalesce(p_recipient, '')))), 1, 16))::bit(64)::bigint;
$$;

create table if not exists public.email_deliveries (
  email_id uuid not null references public.emails(id) on delete cascade,
  recipient_hash bigint not null,             -- recipient_hash(address)
  outcome smallint not null default 1,        -- 1 accepted by SES, 2 failed, 3 canceled, 4 ambiguous
  flags smallint not null default 0,          -- bit 1 delivered, 2 opened, 4 clicked, 8 bounced, 16 complained
  primary key (email_id, recipient_hash)
) with (fillfactor = 90);                     -- leave room so flag updates stay in-page (HOT)

alter table public.email_deliveries enable row level security;
revoke all on public.email_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.email_deliveries to service_role;

-- A finished campaign's ledger rows are folded into one row: sorted recipient
-- hashes plus one state byte each (outcome in the low 3 bits, flags above).
create table if not exists public.email_delivery_archive (
  email_id uuid primary key references public.emails(id) on delete cascade,
  recipients integer not null,
  hashes bigint[] not null,                   -- sorted ascending
  states bytea not null,                      -- states[i] belongs to hashes[i]
  archived_at timestamptz not null default now()
);

alter table public.email_delivery_archive enable row level security;
revoke all on public.email_delivery_archive from public, anon, authenticated;
grant select, insert, update, delete on public.email_delivery_archive to service_role;

-- Events that are flagged on the ledger instead of stored as rows still need
-- to show up in account-wide totals and in "when did we last hear from SES".
create table if not exists public.ses_event_counters (
  day date not null,
  event_type text not null,
  events bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, event_type)
);

alter table public.ses_event_counters enable row level security;
revoke all on public.ses_event_counters from public, anon, authenticated;
grant select, insert, update, delete on public.ses_event_counters to service_role;

-- ── Queue checkpoint also writes the ledger ─────────────────────────────────

create or replace function public.finalize_ses_bulk_queue_batch(
  p_email_id uuid,
  p_worker_id text,
  p_results jsonb,
  p_now timestamptz default now()
)
returns integer
language sql
security definer
set search_path = public
as $$
  with result_rows as (
    select result.id, result.outcome, result.ses_message_id, result.last_error
    from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
      as result(id uuid, outcome text, ses_message_id text, last_error text)
    where result.id is not null
      and result.outcome in ('succeeded', 'retry', 'dead', 'canceled')
  ),
  updated as (
    update public.mail_queue mq
    set
      status = case result_rows.outcome
        when 'succeeded' then 'succeeded'
        when 'retry' then 'pending'
        when 'dead' then 'dead'
        when 'canceled' then 'canceled'
      end,
      attempts = case
        when result_rows.outcome in ('retry', 'dead') then mq.attempts + 1
        else mq.attempts
      end,
      send_date = case
        when result_rows.outcome = 'succeeded' then (p_now at time zone 'UTC')::date
        else mq.send_date
      end,
      ses_message_id = case
        when result_rows.outcome = 'succeeded' then result_rows.ses_message_id
        else mq.ses_message_id
      end,
      available_at = case
        when result_rows.outcome = 'retry'
          then p_now + make_interval(mins => greatest(1, mq.attempts + 1) * 10)
        else mq.available_at
      end,
      locked_at = null,
      last_heartbeat = p_now,
      last_error = nullif(result_rows.last_error, ''),
      updated_at = p_now
    from result_rows
    where mq.id = result_rows.id
      and mq.email_id = p_email_id
      and mq.status = 'processing'
      and mq.correlation_id = p_worker_id
    returning mq.id, nullif(trim(coalesce(mq.payload->>'to', '')), '') as recipient, mq.status, mq.last_error
  ),
  ledger as (
    insert into public.email_deliveries (email_id, recipient_hash, outcome)
    select
      p_email_id,
      public.recipient_hash(u.recipient),
      case
        when u.status = 'succeeded' then 1
        when u.status = 'canceled' then 3
        when u.status = 'dead' and coalesce(u.last_error, '') like 'ambiguous_claim:%' then 4
        else 2
      end
    from updated u
    where u.recipient is not null and u.status in ('succeeded', 'canceled', 'dead')
    on conflict (email_id, recipient_hash) do update set outcome = excluded.outcome
    returning 1
  ),
  already_applied as (
    select mq.id
    from public.mail_queue mq
    join result_rows on result_rows.id = mq.id
    where mq.email_id = p_email_id
      and mq.correlation_id = p_worker_id
      and result_rows.outcome = 'succeeded'
      and mq.status = 'succeeded'
      and mq.ses_message_id = result_rows.ses_message_id
  )
  select count(distinct id)::integer
  from (
    select id from updated
    union all
    select id from already_applied
  ) applied;
$$;

grant execute on function public.finalize_ses_bulk_queue_batch(uuid, text, jsonb, timestamptz)
  to service_role;

-- A row the worker parked as ambiguous that SES's Send event later proved
-- delivered: the webhook flips the queue row and calls this.
create or replace function public.mark_delivery_accepted(p_email_id uuid, p_recipient text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.email_deliveries (email_id, recipient_hash, outcome)
  select p_email_id, public.recipient_hash(p_recipient), 1
  where p_email_id is not null and nullif(trim(coalesce(p_recipient, '')), '') is not null
  on conflict (email_id, recipient_hash) do update set outcome = 1;
$$;

grant execute on function public.mark_delivery_accepted(uuid, text) to service_role;

-- ── Webhook: flag instead of insert ─────────────────────────────────────────

-- Returns 'flagged' when the event was folded into the ledger (the caller must
-- NOT insert a provider_events row), or 'row' when the caller should store it:
--   * no ledger row exists (legacy/test sends, or an event that beat the
--     worker's checkpoint),
--   * the campaign was already compacted (late events are rare; they count as
--     rows after the rollup's archived_through, exactly as before),
--   * the event type carries evidence or detail worth a row (clicked, bounced,
--     complained) - those still get their flag set here as well.
create or replace function public.record_delivery_event(
  p_email_id uuid,
  p_recipient text,
  p_event_type text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flag smallint;
  v_hash bigint;
  v_found boolean;
begin
  v_flag := case p_event_type
    when 'delivered' then 1
    when 'opened' then 2
    when 'clicked' then 4
    when 'bounced' then 8
    when 'complained' then 16
    else null
  end;
  if v_flag is null or p_email_id is null or nullif(trim(coalesce(p_recipient, '')), '') is null then
    return 'row';
  end if;
  v_hash := public.recipient_hash(p_recipient);

  update public.email_deliveries
  set flags = flags | v_flag
  where email_id = p_email_id and recipient_hash = v_hash and (flags & v_flag) <> v_flag;
  v_found := found;
  if not v_found then
    v_found := exists (
      select 1 from public.email_deliveries where email_id = p_email_id and recipient_hash = v_hash
    );
  end if;
  if not v_found then
    return 'row';
  end if;

  if p_event_type not in ('delivered', 'opened') then
    return 'row';
  end if;
  if exists (select 1 from public.email_history_rollups where email_id = p_email_id) then
    return 'row';
  end if;

  insert into public.ses_event_counters (day, event_type, events)
  values ((now() at time zone 'UTC')::date, p_event_type, 1)
  on conflict (day, event_type) do update
    set events = public.ses_event_counters.events + 1, updated_at = now();
  return 'flagged';
end;
$$;

grant execute on function public.record_delivery_event(uuid, text, text) to service_role;

-- ── Per-campaign analytics read the flags ───────────────────────────────────

create or replace function public.get_email_provider_analytics_metric(
  p_email_id uuid,
  p_event_type text
)
returns table (
  unique_recipients bigint,
  event_count bigint,
  latest_event_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flag smallint;
begin
  if p_event_type not in ('delivered', 'opened', 'clicked', 'bounced', 'complained') then
    raise exception 'Unsupported provider event type';
  end if;

  -- Delivered/opened events of a campaign that has not been compacted yet are
  -- flags on the ledger, not rows. Union them with any rows (events that beat
  -- the checkpoint) so nobody is counted twice.
  if p_event_type in ('delivered', 'opened')
     and not exists (select 1 from public.email_history_rollups where email_id = p_email_id) then
    v_flag := case p_event_type when 'delivered' then 1 else 2 end;
    return query
    with ev as (
      select public.recipient_hash(pe.recipient) as r, pe.received_at, pe.recipient
      from public.provider_events pe
      where pe.email_id = p_email_id and pe.event_type = p_event_type
    ), fl as (
      select d.recipient_hash as r
      from public.email_deliveries d
      where d.email_id = p_email_id and (d.flags & v_flag) <> 0
    ), u as (
      select r from ev where recipient is not null
      union
      select r from fl
    )
    select
      (select count(*) from u)::bigint,
      ((select count(*) from ev) + (select count(*) from u)
        - (select count(distinct r) from ev where recipient is not null))::bigint,
      coalesce(
        (select max(received_at) from ev),
        (select max(c.updated_at) from public.ses_event_counters c where c.event_type = p_event_type)
      );
    return;
  end if;

  return query
  with history as (
    select * from public.email_history_rollups where email_id = p_email_id
  ), live as (
    select
      count(distinct lower(pe.recipient)) filter (where pe.recipient is not null) as unique_recipients,
      count(*) as event_count,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    left join history h on true
    where pe.email_id = p_email_id
      and pe.event_type = p_event_type
      and (h.email_id is null or pe.received_at >= h.archived_through)
  )
  select
    case p_event_type
      when 'delivered' then coalesce(h.delivered_unique, 0)
      when 'opened' then coalesce(h.opened_unique, 0)
      when 'clicked' then coalesce(h.clicked_unique, 0)
      when 'bounced' then coalesce(h.bounced_unique, 0)
      when 'complained' then coalesce(h.complained_unique, 0)
    end + coalesce(l.unique_recipients, 0),
    case p_event_type
      when 'delivered' then coalesce(h.delivery_events, 0)
      when 'opened' then coalesce(h.open_events, 0)
      when 'clicked' then coalesce(h.click_events, 0)
      when 'bounced' then coalesce(h.bounce_events, 0)
      when 'complained' then coalesce(h.complaint_events, 0)
    end + coalesce(l.event_count, 0),
    coalesce(greatest(h.latest_event_at, l.latest_event_at), h.latest_event_at, l.latest_event_at)
  from live l
  left join history h on true;
end;
$$;

revoke all on function public.get_email_provider_analytics_metric(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_email_provider_analytics_metric(uuid, text)
  to service_role;

-- ── Compaction: finished campaign -> rollup + ledger, raw rows deleted ──────

-- Safe to call repeatedly: it does nothing unless the campaign has a ledger,
-- has no pending/processing rows, and has not been compacted before.
-- Kept after compaction: the ledger, bounce/complaint/click event rows (rare,
-- and they hold evidence and link detail), and the rollup totals.
-- Removed: terminal queue rows and delivered/opened/sent event rows.
create or replace function public.compact_campaign_history(p_email_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := now();
  v_queue_deleted bigint := 0;
  v_events_deleted bigint := 0;
begin
  if p_email_id is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'no campaign id');
  end if;
  if exists (select 1 from public.email_history_rollups where email_id = p_email_id) then
    return jsonb_build_object('status', 'skipped', 'reason', 'already compacted');
  end if;
  if not exists (select 1 from public.email_deliveries where email_id = p_email_id limit 1) then
    return jsonb_build_object('status', 'skipped', 'reason', 'no delivery ledger');
  end if;
  if exists (
    select 1 from public.mail_queue
    where email_id = p_email_id and status in ('pending', 'processing')
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'campaign still has unsent rows');
  end if;

  -- Never delete queue rows the ledger does not fully cover (e.g. a campaign
  -- that began sending before this migration was applied): their recipient-level
  -- outcomes would be lost.
  if (
    select count(*) from public.mail_queue mq
    where mq.email_id = p_email_id
      and mq.status in ('succeeded', 'failed', 'dead', 'canceled')
      and nullif(trim(coalesce(mq.payload->>'to', '')), '') is not null
  ) > (select count(*) from public.email_deliveries where email_id = p_email_id) then
    return jsonb_build_object('status', 'skipped', 'reason', 'ledger incomplete');
  end if;

  insert into public.email_history_rollups (
    email_id, total_queued, succeeded, failed, dead, canceled,
    permanent_failures, with_ses_message_id, list_ids,
    first_queued_at, last_updated_at, first_send_date, last_send_date,
    delivered_unique, bounced_unique, complained_unique, opened_unique, clicked_unique,
    delivery_events, bounce_events, complaint_events, open_events, click_events,
    first_event_at, latest_event_at, archived_through, updated_at
  )
  with queue_agg as (
    select
      count(*) as total_queued,
      count(*) filter (where mq.status = 'succeeded') as succeeded,
      count(*) filter (where mq.status = 'failed') as failed,
      count(*) filter (where mq.status = 'dead') as dead,
      count(*) filter (where mq.status = 'canceled') as canceled,
      count(*) filter (where mq.status = 'dead' and mq.attempts = 999) as permanent_failures,
      count(*) filter (where mq.ses_message_id is not null) as with_ses_message_id,
      coalesce(array_agg(distinct mq.list_id) filter (where mq.list_id is not null), '{}') as list_ids,
      min(mq.created_at) as first_queued_at,
      max(mq.updated_at) as last_updated_at,
      min(mq.send_date) as first_send_date,
      max(mq.send_date) as last_send_date
    from public.mail_queue mq
    where mq.email_id = p_email_id
      and mq.status in ('succeeded', 'failed', 'dead', 'canceled')
      and mq.updated_at < v_cutoff
  ), ev as (
    select public.recipient_hash(pe.recipient) as r, pe.event_type, pe.received_at
    from public.provider_events pe
    where pe.email_id = p_email_id and pe.recipient is not null and pe.received_at < v_cutoff
  ), kinds(event_type, flag) as (
    values ('delivered', 1), ('opened', 2), ('clicked', 4), ('bounced', 8), ('complained', 16)
  ), per as (
    select
      k.event_type,
      (
        select count(*) from (
          select e.r from ev e where e.event_type = k.event_type
          union
          select d.recipient_hash from public.email_deliveries d
          where d.email_id = p_email_id and (d.flags & k.flag) <> 0
        ) x
      ) as uniq,
      (select count(*) from ev e where e.event_type = k.event_type) as row_events,
      (select count(distinct e.r) from ev e where e.event_type = k.event_type) as row_recipients
    from kinds k
  ), event_times as (
    select min(received_at) as first_event_at, max(received_at) as latest_event_at from ev
  )
  select
    p_email_id,
    coalesce(q.total_queued, 0), coalesce(q.succeeded, 0), coalesce(q.failed, 0),
    coalesce(q.dead, 0), coalesce(q.canceled, 0), coalesce(q.permanent_failures, 0),
    coalesce(q.with_ses_message_id, 0), coalesce(q.list_ids, '{}'),
    q.first_queued_at, q.last_updated_at, q.first_send_date, q.last_send_date,
    coalesce(max(p.uniq) filter (where p.event_type = 'delivered'), 0),
    coalesce(max(p.uniq) filter (where p.event_type = 'bounced'), 0),
    coalesce(max(p.uniq) filter (where p.event_type = 'complained'), 0),
    coalesce(max(p.uniq) filter (where p.event_type = 'opened'), 0),
    coalesce(max(p.uniq) filter (where p.event_type = 'clicked'), 0),
    coalesce(max(p.row_events + p.uniq - p.row_recipients) filter (where p.event_type = 'delivered'), 0),
    coalesce(max(p.row_events + p.uniq - p.row_recipients) filter (where p.event_type = 'bounced'), 0),
    coalesce(max(p.row_events + p.uniq - p.row_recipients) filter (where p.event_type = 'complained'), 0),
    coalesce(max(p.row_events + p.uniq - p.row_recipients) filter (where p.event_type = 'opened'), 0),
    coalesce(max(p.row_events + p.uniq - p.row_recipients) filter (where p.event_type = 'clicked'), 0),
    t.first_event_at, t.latest_event_at, v_cutoff, now()
  from queue_agg q
  cross join per p
  cross join event_times t
  group by q.total_queued, q.succeeded, q.failed, q.dead, q.canceled, q.permanent_failures,
    q.with_ses_message_id, q.list_ids, q.first_queued_at, q.last_updated_at,
    q.first_send_date, q.last_send_date, t.first_event_at, t.latest_event_at;

  -- Fold the per-recipient rows into one compact record (sorted hashes plus a
  -- state byte each) and drop the hot rows.
  insert into public.email_delivery_archive (email_id, recipients, hashes, states)
  select
    p_email_id,
    count(*)::integer,
    array_agg(d.recipient_hash order by d.recipient_hash),
    decode(
      string_agg(lpad(to_hex((d.outcome | (d.flags << 3))::integer), 2, '0'), '' order by d.recipient_hash),
      'hex'
    )
  from public.email_deliveries d
  where d.email_id = p_email_id
  on conflict (email_id) do nothing;
  delete from public.email_deliveries where email_id = p_email_id;

  delete from public.mail_queue
  where email_id = p_email_id
    and status in ('succeeded', 'failed', 'dead', 'canceled')
    and updated_at < v_cutoff;
  get diagnostics v_queue_deleted = row_count;

  delete from public.provider_events
  where email_id = p_email_id
    and event_type in ('delivered', 'opened', 'sent')
    and received_at < v_cutoff;
  get diagnostics v_events_deleted = row_count;

  return jsonb_build_object(
    'status', 'compacted',
    'archived_recipients', (select recipients from public.email_delivery_archive where email_id = p_email_id),
    'queue_rows_deleted', v_queue_deleted,
    'event_rows_deleted', v_events_deleted
  );
end;
$$;

revoke all on function public.compact_campaign_history(uuid) from public, anon, authenticated;
grant execute on function public.compact_campaign_history(uuid) to service_role;

-- ── "Did they get this email?" ──────────────────────────────────────────────

-- State byte for one recipient: outcome in the low 3 bits (1 accepted, 2 failed,
-- 3 canceled, 4 ambiguous), flags above (delivered 8, opened 16, clicked 32,
-- bounced 64, complained 128). NULL when this campaign has no record of them.
-- Reads the hot ledger first, then the compact archive.
create or replace function public.get_delivery_state(p_email_id uuid, p_recipient text)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hash bigint := public.recipient_hash(p_recipient);
  v_state integer;
  v_hashes bigint[];
  v_states bytea;
  v_lo integer;
  v_hi integer;
  v_mid integer;
begin
  select d.outcome | (d.flags << 3) into v_state
  from public.email_deliveries d
  where d.email_id = p_email_id and d.recipient_hash = v_hash;
  if found then
    return v_state;
  end if;

  select a.hashes, a.states into v_hashes, v_states
  from public.email_delivery_archive a where a.email_id = p_email_id;
  if not found then
    return null;
  end if;
  v_lo := 1;
  v_hi := coalesce(array_length(v_hashes, 1), 0);
  while v_lo <= v_hi loop
    v_mid := (v_lo + v_hi) / 2;
    if v_hashes[v_mid] = v_hash then
      return get_byte(v_states, v_mid - 1);
    elsif v_hashes[v_mid] < v_hash then
      v_lo := v_mid + 1;
    else
      v_hi := v_mid - 1;
    end if;
  end loop;
  return null;
end;
$$;

-- Of the given addresses, those SES already accepted for this campaign. Used
-- before (re)building a queue so a finished or compacted campaign can never be
-- sent twice to the same person. The archive is read once per call.
create or replace function public.delivery_accepted_among(p_email_id uuid, p_recipients text[])
returns setof text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hashes bigint[];
  v_states bytea;
  v_has_archive boolean := false;
  v_recipient text;
  v_hash bigint;
  v_lo integer;
  v_hi integer;
  v_mid integer;
  v_accepted boolean;
begin
  select a.hashes, a.states into v_hashes, v_states
  from public.email_delivery_archive a where a.email_id = p_email_id;
  v_has_archive := found;

  foreach v_recipient in array coalesce(p_recipients, array[]::text[]) loop
    v_hash := public.recipient_hash(v_recipient);
    v_accepted := exists (
      select 1 from public.email_deliveries d
      where d.email_id = p_email_id and d.recipient_hash = v_hash and d.outcome = 1
    );
    if not v_accepted and v_has_archive then
      v_lo := 1;
      v_hi := coalesce(array_length(v_hashes, 1), 0);
      while v_lo <= v_hi loop
        v_mid := (v_lo + v_hi) / 2;
        if v_hashes[v_mid] = v_hash then
          v_accepted := (get_byte(v_states, v_mid - 1) & 7) = 1;
          exit;
        elsif v_hashes[v_mid] < v_hash then
          v_lo := v_mid + 1;
        else
          v_hi := v_mid - 1;
        end if;
      end loop;
    end if;
    if v_accepted then
      return next v_recipient;
    end if;
  end loop;
end;
$$;

revoke all on function public.get_delivery_state(uuid, text) from public, anon, authenticated;
revoke all on function public.delivery_accepted_among(uuid, text[]) from public, anon, authenticated;
grant execute on function public.get_delivery_state(uuid, text) to service_role;
grant execute on function public.delivery_accepted_among(uuid, text[]) to service_role;

-- ── The manual archive/purge script must not overwrite compacted campaigns ──

-- refresh_email_history_rollups recomputes a campaign's rollup from the rows that
-- still exist. After compact_campaign_history only bounce/complaint/click rows
-- remain, so a later run would replace the real totals with near-zeros. Campaigns
-- with a delivery archive are skipped. (Otherwise unchanged from
-- 20260810_compact_history_rollups.sql.)
create or replace function public.refresh_email_history_rollups(p_cutoff timestamptz)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  affected bigint;
begin
  insert into public.email_history_rollups (
    email_id, total_queued, succeeded, failed, dead, canceled,
    permanent_failures, with_ses_message_id, list_ids,
    first_queued_at, last_updated_at, first_send_date, last_send_date,
    delivered_unique, bounced_unique, complained_unique, opened_unique, clicked_unique,
    delivery_events, bounce_events, complaint_events, open_events, click_events,
    first_event_at, latest_event_at, archived_through, updated_at
  )
  with queue_agg as (
    select
      mq.email_id,
      count(*) as total_queued,
      count(*) filter (where mq.status = 'succeeded') as succeeded,
      count(*) filter (where mq.status = 'failed') as failed,
      count(*) filter (where mq.status = 'dead') as dead,
      count(*) filter (where mq.status = 'canceled') as canceled,
      count(*) filter (where mq.status = 'dead' and mq.attempts = 999) as permanent_failures,
      count(*) filter (where mq.ses_message_id is not null) as with_ses_message_id,
      coalesce(array_agg(distinct mq.list_id) filter (where mq.list_id is not null), '{}') as list_ids,
      min(mq.created_at) as first_queued_at,
      max(mq.updated_at) as last_updated_at,
      min(mq.send_date) as first_send_date,
      max(mq.send_date) as last_send_date
    from public.mail_queue mq
    where mq.email_id is not null
      and not exists (select 1 from public.email_delivery_archive a where a.email_id = mq.email_id)
      and mq.updated_at < p_cutoff
      and mq.status in ('succeeded','failed','dead','canceled')
    group by mq.email_id
  ), event_agg as (
    select
      pe.email_id,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'delivered' and pe.recipient is not null) as delivered_unique,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'bounced' and pe.recipient is not null) as bounced_unique,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'complained' and pe.recipient is not null) as complained_unique,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'opened' and pe.recipient is not null) as opened_unique,
      count(distinct lower(pe.recipient)) filter (where pe.event_type = 'clicked' and pe.recipient is not null) as clicked_unique,
      count(*) filter (where pe.event_type = 'delivered') as delivery_events,
      count(*) filter (where pe.event_type = 'bounced') as bounce_events,
      count(*) filter (where pe.event_type = 'complained') as complaint_events,
      count(*) filter (where pe.event_type = 'opened') as open_events,
      count(*) filter (where pe.event_type = 'clicked') as click_events,
      min(pe.received_at) as first_event_at,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    where pe.email_id is not null
      and not exists (select 1 from public.email_delivery_archive a where a.email_id = pe.email_id)
      and pe.received_at < p_cutoff
    group by pe.email_id
  ), ids as (
    select email_id from queue_agg union select email_id from event_agg
  )
  select
    ids.email_id,
    coalesce(q.total_queued, 0), coalesce(q.succeeded, 0), coalesce(q.failed, 0),
    coalesce(q.dead, 0), coalesce(q.canceled, 0), coalesce(q.permanent_failures, 0),
    coalesce(q.with_ses_message_id, 0), coalesce(q.list_ids, '{}'),
    q.first_queued_at, q.last_updated_at, q.first_send_date, q.last_send_date,
    coalesce(e.delivered_unique, 0), coalesce(e.bounced_unique, 0),
    coalesce(e.complained_unique, 0), coalesce(e.opened_unique, 0), coalesce(e.clicked_unique, 0),
    coalesce(e.delivery_events, 0), coalesce(e.bounce_events, 0),
    coalesce(e.complaint_events, 0), coalesce(e.open_events, 0), coalesce(e.click_events, 0),
    e.first_event_at, e.latest_event_at, p_cutoff, now()
  from ids
  left join queue_agg q using (email_id)
  left join event_agg e using (email_id)
  on conflict (email_id) do update set
    total_queued = excluded.total_queued,
    succeeded = excluded.succeeded,
    failed = excluded.failed,
    dead = excluded.dead,
    canceled = excluded.canceled,
    permanent_failures = excluded.permanent_failures,
    with_ses_message_id = excluded.with_ses_message_id,
    list_ids = excluded.list_ids,
    first_queued_at = excluded.first_queued_at,
    last_updated_at = excluded.last_updated_at,
    first_send_date = excluded.first_send_date,
    last_send_date = excluded.last_send_date,
    delivered_unique = excluded.delivered_unique,
    bounced_unique = excluded.bounced_unique,
    complained_unique = excluded.complained_unique,
    opened_unique = excluded.opened_unique,
    clicked_unique = excluded.clicked_unique,
    delivery_events = excluded.delivery_events,
    bounce_events = excluded.bounce_events,
    complaint_events = excluded.complaint_events,
    open_events = excluded.open_events,
    click_events = excluded.click_events,
    first_event_at = excluded.first_event_at,
    latest_event_at = excluded.latest_event_at,
    archived_through = excluded.archived_through,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end
$$;

grant execute on function public.refresh_email_history_rollups(timestamptz) to service_role;

-- ── Storage page: report whether the ledger is installed ────────────────────

-- Same function as 20260930_database_storage_stats.sql, plus an explicit
-- ledger_installed flag (a just-created ledger table is tiny and could fall off
-- the "largest tables" list) and room for more tables.
create or replace function public.get_database_storage_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'ledger_installed', to_regclass('public.email_deliveries') is not null,
    'tables', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.total_bytes desc)
      from (
        select
          s.relname as name,
          pg_total_relation_size(s.relid) as total_bytes,
          pg_relation_size(s.relid) as heap_bytes,
          pg_indexes_size(s.relid) as index_bytes,
          s.n_live_tup as live_rows,
          s.n_dead_tup as dead_rows,
          s.last_autovacuum as last_autovacuum
        from pg_stat_user_tables s
        where s.schemaname = 'public'
        order by pg_total_relation_size(s.relid) desc
        limit 40
      ) t
    ), '[]'::jsonb),
    'indexes', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.bytes desc)
      from (
        select
          s.relname as table_name,
          s.indexrelname as name,
          pg_relation_size(s.indexrelid) as bytes,
          s.idx_scan as scans,
          x.indisunique as is_unique,
          x.indisprimary as is_primary
        from pg_stat_user_indexes s
        join pg_index x on x.indexrelid = s.indexrelid
        where s.schemaname = 'public'
        order by pg_relation_size(s.indexrelid) desc
        limit 30
      ) i
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_database_storage_stats() from public, anon, authenticated;
grant execute on function public.get_database_storage_stats() to service_role;

-- ── Campaign detail, recipient activity and send report understand the ledger ─

-- Before compaction delivered/opened are flags on the ledger; after it they are
-- in the rollup. These read whichever applies (the provider metric function
-- already does), so the campaign detail page keeps its headline numbers for a
-- compacted campaign. Recipient rows exist only while the queue rows do.

create or replace function public.get_email_analytics_detail(p_email_id uuid)
returns table (
  email_id uuid,
  queued bigint,
  ses_accepted bigint,
  with_ses_message_id bigint,
  delivered_unique bigint,
  bounced_unique bigint,
  complained_unique bigint,
  opened_unique bigint,
  props_opened_unique bigint,
  ses_opened_unique bigint,
  clicked_unique bigint,
  delivery_events bigint,
  open_events bigint,
  props_open_events bigint,
  ses_open_events bigint,
  click_events bigint,
  first_event_at timestamptz,
  latest_event_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with h as (
    select * from public.email_history_rollups where email_id = p_email_id
  ), q as (
    select
      count(*) as queued,
      count(*) filter (where mq.status = 'succeeded') as ses_accepted,
      count(*) filter (where mq.ses_message_id is not null) as with_ses_message_id
    from public.mail_queue mq
    left join h on true
    where mq.email_id = p_email_id
      and (h.email_id is null or mq.updated_at >= h.archived_through)
  ), ev as (
    select
      count(*) filter (where pe.event_type = 'opened' and pe.provider = 'props') as props_open_events,
      count(distinct lower(pe.recipient)) filter (
        where pe.event_type = 'opened' and pe.provider = 'props' and pe.recipient is not null
      ) as props_opened_unique,
      min(pe.received_at) as first_event_at
    from public.provider_events pe
    where pe.email_id = p_email_id
  ), d as (select * from public.get_email_provider_analytics_metric(p_email_id, 'delivered')),
  o as (select * from public.get_email_provider_analytics_metric(p_email_id, 'opened')),
  b as (select * from public.get_email_provider_analytics_metric(p_email_id, 'bounced')),
  c as (select * from public.get_email_provider_analytics_metric(p_email_id, 'complained')),
  k as (select * from public.get_email_provider_analytics_metric(p_email_id, 'clicked'))
  select
    p_email_id,
    coalesce(h.total_queued, 0) + q.queued,
    coalesce(h.succeeded, 0) + q.ses_accepted,
    coalesce(h.with_ses_message_id, 0) + q.with_ses_message_id,
    d.unique_recipients,
    b.unique_recipients,
    c.unique_recipients,
    o.unique_recipients,
    ev.props_opened_unique,
    greatest(0, o.unique_recipients - ev.props_opened_unique),
    k.unique_recipients,
    d.event_count,
    o.event_count,
    ev.props_open_events,
    greatest(0, o.event_count - ev.props_open_events),
    k.event_count,
    least(ev.first_event_at, h.first_event_at),
    greatest(d.latest_event_at, o.latest_event_at, b.latest_event_at, c.latest_event_at, k.latest_event_at)
  from q
  cross join ev
  cross join d cross join o cross join b cross join c cross join k
  left join h on true;
$$;

create or replace function public.get_email_recipient_activity(
  p_email_id uuid,
  p_limit integer default 100,
  p_offset integer default 0,
  p_status text default null,
  p_event_type text default null,
  p_search text default null
)
returns table (
  queue_id uuid,
  recipient text,
  recipient_name text,
  list_id uuid,
  queue_status text,
  send_date date,
  queued_at timestamptz,
  queue_updated_at timestamptz,
  ses_message_id text,
  last_error text,
  delivered_events bigint,
  props_open_events bigint,
  ses_open_events bigint,
  click_events bigint,
  bounce_events bigint,
  complaint_events bigint,
  first_open_at timestamptz,
  last_open_at timestamptz,
  first_click_at timestamptz,
  last_click_at timestamptz,
  latest_event_at timestamptz,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with filtered_queue as materialized (
    select mq.id, coalesce(mq.updated_at, mq.created_at) as sort_at
    from public.mail_queue mq
    where mq.email_id = p_email_id
      and (p_status is null or mq.status = p_status)
      and (
        p_search is null
        or p_search = ''
        or lower(mq.payload->>'to') like '%' || lower(p_search) || '%'
      )
      and (
        p_event_type is null
        or exists (
          select 1
          from public.provider_events pe_filter
          where pe_filter.email_id = mq.email_id
            and pe_filter.event_type = p_event_type
            and (
              (mq.ses_message_id is not null and pe_filter.message_id = mq.ses_message_id)
              or pe_filter.message_id = mq.id::text
            )
        )
        or exists (
          select 1
          from public.email_deliveries dfl
          where dfl.email_id = mq.email_id
            and dfl.recipient_hash = public.recipient_hash(mq.payload->>'to')
            and (dfl.flags & case p_event_type
              when 'delivered' then 1 when 'opened' then 2 when 'clicked' then 4
              when 'bounced' then 8 when 'complained' then 16 else 0 end) <> 0
        )
      )
  ), page_rows as (
    select fq.*
    from filtered_queue fq
    order by fq.sort_at desc, fq.id
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    offset greatest(0, coalesce(p_offset, 0))
  ), filtered_count as (
    select count(*) as total_count from filtered_queue
  )
  select
    pr.id as queue_id,
    nullif(lower(pr.payload->>'to'), '') as recipient,
    nullif(pr.payload->>'toName', '') as recipient_name,
    pr.list_id,
    pr.status as queue_status,
    pr.send_date,
    pr.created_at as queued_at,
    pr.updated_at as queue_updated_at,
    pr.ses_message_id,
    pr.last_error,
    greatest(coalesce(ev.delivered_events, 0), (coalesce(dl.flags, 0) & 1)),
    coalesce(ev.props_open_events, 0),
    greatest(coalesce(ev.ses_open_events, 0), case when coalesce(ev.props_open_events, 0) = 0 then (coalesce(dl.flags, 0) & 2) / 2 else 0 end),
    coalesce(ev.click_events, 0),
    coalesce(ev.bounce_events, 0),
    coalesce(ev.complaint_events, 0),
    ev.first_open_at,
    ev.last_open_at,
    ev.first_click_at,
    ev.last_click_at,
    ev.latest_event_at,
    fc.total_count
  from page_rows page
  join public.mail_queue pr on pr.id = page.id
  cross join filtered_count fc
  left join lateral (
    select
      count(*) filter (where pe.event_type = 'delivered') as delivered_events,
      count(*) filter (where pe.event_type = 'opened' and pe.provider = 'props') as props_open_events,
      count(*) filter (where pe.event_type = 'opened' and pe.provider = 'ses') as ses_open_events,
      count(*) filter (where pe.event_type = 'clicked') as click_events,
      count(*) filter (where pe.event_type = 'bounced') as bounce_events,
      count(*) filter (where pe.event_type = 'complained') as complaint_events,
      min(pe.received_at) filter (where pe.event_type = 'opened') as first_open_at,
      max(pe.received_at) filter (where pe.event_type = 'opened') as last_open_at,
      min(pe.received_at) filter (where pe.event_type = 'clicked') as first_click_at,
      max(pe.received_at) filter (where pe.event_type = 'clicked') as last_click_at,
      max(pe.received_at) as latest_event_at
    from public.provider_events pe
    where pe.email_id = pr.email_id
      and (
        (pr.ses_message_id is not null and pe.message_id = pr.ses_message_id)
        or pe.message_id = pr.id::text
      )
  ) ev on true
  left join public.email_deliveries dl
    on dl.email_id = pr.email_id
    and dl.recipient_hash = public.recipient_hash(pr.payload->>'to')
  order by coalesce(ev.latest_event_at, pr.updated_at, pr.created_at) desc, pr.id;
$$;

grant execute on function public.get_email_analytics_detail(uuid)
  to authenticated, service_role;
grant execute on function public.get_email_recipient_activity(uuid, integer, integer, text, text, text)
  to authenticated, service_role;

create or replace view public.email_send_report as
with live_queue as (
  select
    email_id,
    count(*) as total_queued,
    count(*) filter (where status = 'succeeded') as succeeded,
    count(*) filter (where status = 'dead') as dead,
    count(*) filter (where status = 'pending') as pending,
    count(*) filter (where status = 'processing') as processing,
    count(*) filter (where status = 'canceled') as canceled,
    count(*) filter (where status = 'dead' and attempts = 999) as permanent_failures,
    min(created_at) as first_queued_at,
    max(updated_at) as last_updated_at,
    min(send_date) as first_send_date,
    max(send_date) as last_send_date
  from public.mail_queue where email_id is not null group by email_id
), live_events as (
  select
    email_id,
    count(distinct lower(recipient)) filter (where event_type = 'delivered' and recipient is not null) as delivered,
    count(distinct lower(recipient)) filter (where event_type = 'bounced' and recipient is not null) as bounced,
    count(distinct lower(recipient)) filter (where event_type = 'complained' and recipient is not null) as complained,
    count(distinct lower(recipient)) filter (where event_type = 'opened' and recipient is not null) as opened,
    count(distinct lower(recipient)) filter (where event_type = 'clicked' and recipient is not null) as clicked
  from public.provider_events where email_id is not null group by email_id
), flagged as (
  -- delivered/opened are flags on the delivery ledger, not event rows
  select d.email_id,
    count(*) filter (where (d.flags & 1) <> 0) as delivered,
    count(*) filter (where (d.flags & 2) <> 0) as opened
  from public.email_deliveries d group by d.email_id
), ids as (
  select email_id from public.email_history_rollups
  union select email_id from live_queue
  union select email_id from live_events
  union select email_id from flagged
)
select
  ids.email_id,
  coalesce(r.total_queued, 0) + coalesce(q.total_queued, 0) as total_queued,
  coalesce(r.succeeded, 0) + coalesce(q.succeeded, 0) as succeeded,
  coalesce(r.dead, 0) + coalesce(q.dead, 0) as dead,
  coalesce(q.pending, 0) as pending,
  coalesce(q.processing, 0) as processing,
  coalesce(r.canceled, 0) + coalesce(q.canceled, 0) as canceled,
  greatest(coalesce(r.delivered_unique, 0), coalesce(ev.delivered, 0) + coalesce(fl.delivered, 0)) as delivered,
  greatest(coalesce(r.bounced_unique, 0), coalesce(ev.bounced, 0)) as bounced,
  greatest(coalesce(r.complained_unique, 0), coalesce(ev.complained, 0)) as complained,
  greatest(coalesce(r.opened_unique, 0), coalesce(ev.opened, 0) + coalesce(fl.opened, 0)) as opened,
  greatest(coalesce(r.clicked_unique, 0), coalesce(ev.clicked, 0)) as clicked,
  coalesce(r.permanent_failures, 0) + coalesce(q.permanent_failures, 0) as permanent_failures,
  least(r.first_queued_at, q.first_queued_at) as first_queued_at,
  greatest(r.last_updated_at, q.last_updated_at) as last_updated_at,
  least(r.first_send_date, q.first_send_date) as first_send_date,
  greatest(r.last_send_date, q.last_send_date) as last_send_date
from ids
left join public.email_history_rollups r using (email_id)
left join live_queue q using (email_id)
left join live_events ev using (email_id)
left join flagged fl using (email_id);

alter view public.email_send_report set (security_invoker = true);
revoke all on table public.email_send_report from anon;
grant select on table public.email_send_report to authenticated, service_role;

notify pgrst, 'reload schema';
