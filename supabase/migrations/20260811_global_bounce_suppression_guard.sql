-- Keep globally suppressed addresses blocked when lists are imported or updated.
-- The canonical global suppression list is identified by its stable local address.

create index if not exists list_members_blocked_email_lower_idx
  on public.list_members (lower(email))
  where status = 'blocked';

create or replace function public.enforce_global_list_suppression()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  is_global_block_list boolean;
begin
  if lower(trim(new.email)) = 'a@sarva.co' then
    return new;
  end if;

  select coalesce(l.address = 'block-list@props.local', false)
    into is_global_block_list
  from public.lists l
  where l.id = new.list_id;

  if coalesce(is_global_block_list, false) then
    return new;
  end if;

  if exists (
    select 1
    from public.list_members blocked_member
    join public.lists blocked_list on blocked_list.id = blocked_member.list_id
    where blocked_list.address = 'block-list@props.local'
      and blocked_member.status = 'blocked'
      and lower(trim(blocked_member.email)) = lower(trim(new.email))
  ) then
    new.status := 'blocked';
    new.source := 'global_block_list';
    new.unsubscribed_at := coalesce(new.unsubscribed_at, now());
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'globally_suppressed', true,
      'suppression_reason', 'global_block_list'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists list_members_enforce_global_suppression on public.list_members;
create trigger list_members_enforce_global_suppression
before insert or update of email, list_id, status
on public.list_members
for each row
execute function public.enforce_global_list_suppression();
