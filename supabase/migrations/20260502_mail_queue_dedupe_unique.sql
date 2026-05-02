-- Enforce idempotent queue rows for large campaign builds.
--
-- Existing duplicates are retained, but their legacy duplicate hashes are made
-- unique so the new index can be created without deleting historical records.
with ranked as (
  select
    id,
    row_number() over (
      partition by dedupe_hash
      order by created_at nulls last, id
    ) as rn
  from public.mail_queue
  where dedupe_hash is not null
)
update public.mail_queue mq
set dedupe_hash = mq.dedupe_hash || ':legacy-duplicate:' || mq.id::text
from ranked
where mq.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists mail_queue_dedupe_hash_unique_idx
  on public.mail_queue(dedupe_hash);
