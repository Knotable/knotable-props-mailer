-- Suppress follow-up reminder domains from all mailing lists.
-- App code also prevents these domains from being imported as active members
-- or sent if stale queue rows already exist.

update public.list_members
set
  status = 'blocked',
  source = 'block_list',
  unsubscribed_at = coalesce(unsubscribed_at, now()),
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'blocked_by', 'domain_block_list',
    'blocked_domains', jsonb_build_array('followupthen.com', 'fut.io')
  )
where status = 'active'
  and (
    lower(email) like '%@followupthen.com'
    or lower(email) like '%@fut.io'
  );
