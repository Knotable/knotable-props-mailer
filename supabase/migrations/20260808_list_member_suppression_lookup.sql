-- Keep per-address suppression fast even when mail_queue contains six figures
-- of historical rows. This index is deliberately partial because only unsent
-- work can be canceled by the Lists UI.
create index if not exists mail_queue_unsent_recipient_list_idx
  on public.mail_queue (list_id, (payload->>'to'))
  where status in ('pending', 'processing');

-- List member emails are normalized to lowercase on import. Prefix search can
-- therefore use this compact btree index instead of an expensive wildcard scan.
create index if not exists list_members_list_email_prefix_idx
  on public.list_members (list_id, email text_pattern_ops);
