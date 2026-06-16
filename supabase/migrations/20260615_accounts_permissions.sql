-- Open account signup while keeping mail sending explicitly permissioned.
--
-- New profiles default to ordinary users with sending disabled. The owner
-- account remains admin and send-enabled. Mail/list records are shared across
-- authenticated users so collaborators can draft, review, and monitor work.

alter table public.profiles
  add column if not exists can_send boolean not null default false;

alter table public.profiles
  alter column role set default 'user';

update public.profiles
set role = 'user'
where role is null or role not in ('admin', 'user');

do $$
begin
  alter table public.profiles
    add constraint profiles_role_check check (role in ('admin', 'user'));
exception
  when duplicate_object then null;
end $$;

update public.profiles
set role = 'admin',
    can_send = true
where lower(email) = 'a@sarva.co';

drop policy if exists "emails: owner full access" on public.emails;
drop policy if exists "emails: authenticated shared access" on public.emails;
create policy "emails: authenticated shared access"
  on public.emails
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "email_recipients: owner full access" on public.email_recipients;
drop policy if exists "email_recipients: authenticated shared access" on public.email_recipients;
create policy "email_recipients: authenticated shared access"
  on public.email_recipients
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "draft_snapshots: owner full access" on public.draft_snapshots;
drop policy if exists "draft_snapshots: authenticated shared access" on public.draft_snapshots;
create policy "draft_snapshots: authenticated shared access"
  on public.draft_snapshots
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "lists: owner full access" on public.lists;
drop policy if exists "lists: authenticated shared access" on public.lists;
create policy "lists: authenticated shared access"
  on public.lists
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "list_members: owner full access" on public.list_members;
drop policy if exists "list_members: authenticated shared access" on public.list_members;
create policy "list_members: authenticated shared access"
  on public.list_members
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

notify pgrst, 'reload schema';
