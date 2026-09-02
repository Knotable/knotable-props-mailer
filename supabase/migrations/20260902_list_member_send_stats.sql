-- Preserve recipient-level send facts after terminal mail_queue rows are archived.
create table if not exists public.list_member_send_stats (
  list_id uuid not null references public.lists on delete cascade,
  recipient_email text not null,
  total_received bigint not null default 0,
  last_received_at timestamptz,
  last_email_id uuid references public.emails on delete set null,
  updated_at timestamptz not null default now(),
  primary key (list_id, recipient_email)
);
create index if not exists list_member_send_stats_email_idx
  on public.list_member_send_stats(recipient_email);

alter table public.list_member_send_stats enable row level security;
drop policy if exists "list_member_send_stats: authenticated read" on public.list_member_send_stats;
create policy "list_member_send_stats: authenticated read"
  on public.list_member_send_stats for select to authenticated using (true);
grant select on public.list_member_send_stats to authenticated, service_role;

create or replace function public.record_list_member_send()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  recipient text := lower(trim(coalesce(new.payload->>'to', '')));
begin
  if new.status = 'succeeded' and (old.status is distinct from 'succeeded')
     and new.list_id is not null and recipient <> '' then
    insert into public.list_member_send_stats
      (list_id, recipient_email, total_received, last_received_at, last_email_id, updated_at)
    values (new.list_id, recipient, 1, coalesce(new.updated_at, now()), new.email_id, now())
    on conflict (list_id, recipient_email) do update set
      total_received = public.list_member_send_stats.total_received + 1,
      last_received_at = greatest(public.list_member_send_stats.last_received_at, excluded.last_received_at),
      last_email_id = case when excluded.last_received_at >= public.list_member_send_stats.last_received_at
                           then excluded.last_email_id else public.list_member_send_stats.last_email_id end,
      updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists mail_queue_record_list_member_send on public.mail_queue;
create trigger mail_queue_record_list_member_send
  after update of status on public.mail_queue
  for each row execute function public.record_list_member_send();

-- Capture any surviving successful rows when this migration is applied.
insert into public.list_member_send_stats
  (list_id, recipient_email, total_received, last_received_at, last_email_id)
select mq.list_id, lower(trim(mq.payload->>'to')), count(*), max(mq.updated_at),
       (array_agg(mq.email_id order by mq.updated_at desc))[1]
from public.mail_queue mq
where mq.status = 'succeeded' and mq.list_id is not null
  and nullif(trim(mq.payload->>'to'), '') is not null
group by mq.list_id, lower(trim(mq.payload->>'to'))
on conflict (list_id, recipient_email) do update set
  total_received = greatest(public.list_member_send_stats.total_received, excluded.total_received),
  last_received_at = greatest(public.list_member_send_stats.last_received_at, excluded.last_received_at),
  last_email_id = case when excluded.last_received_at >= public.list_member_send_stats.last_received_at
                       then excluded.last_email_id else public.list_member_send_stats.last_email_id end,
  updated_at = now();
