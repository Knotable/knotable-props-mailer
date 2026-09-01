\set ON_ERROR_STOP on
begin;

create temp table ai_unsubscribe_input(email text primary key);
insert into ai_unsubscribe_input(email) values
('a@moya.cc'),
('a@sarva.co'),
('abhi@aminoanalytica.com'),
('alexander.samwer@arvantis.group'),
('alexander@bastionadvisors.co.uk'),
('alexaraki.me@gmail.com'),
('amna.rana@gmail.com'),
('arda.partamian-krieps@affinity.co'),
('auren@nqb8.com'),
('ben.m.berman@gmail.com'),
('bibanez@gmail.com'),
('bonny@mfenterprises.com'),
('brian@teamignite.ventures'),
('camillabottari@gmail.com'),
('carlos@productschool.com'),
('cd1845@gmail.com'),
('cecilia.salcedo@veritasint.com'),
('chris@a16z.com'),
('christyw31@gmail.com'),
('clara.pombo@gmail.com'),
('daryl@thetie.io'),
('david@comma.vc'),
('david@trebellar.com'),
('denis.pettiaux@spdg.be'),
('eddy@intudovc.com'),
('elizabeth@ziggcap.com'),
('ellie.sarmadi@gmail.com'),
('esterlimarcos@gmail.com'),
('extra@drwn.com'),
('fabian@presight.vc'),
('fiddlestring@gmail.com'),
('florian.obst@speedinvest.com'),
('gergely@arcinvestors.com'),
('gmjzellers@gmail.com'),
('halen@gengalactic.com'),
('haroon@autoblocks.ai'),
('henk@tetris.com'),
('jana@janafernandez.es'),
('jarrett.streebin@gmail.com'),
('jasper@zdjasper.com'),
('jeff@radiclescience.com'),
('jeff@uncorkcapital.com'),
('jesse@maximumfun.org'),
('jake@powerset.co'),
('johngerzema@gmail.com'),
('jspencer@buildersvision.com'),
('lawrenceff777@gmail.com'),
('lgarroway@violationlawyers.com'),
('margaret.m.molloy@gmail.com'),
('mariam@brainify.ai'),
('marjonab12@gmail.com'),
('marlon@macventurecapital.com'),
('mbhargava@generalcatalyst.com'),
('mikedelponte@gmail.com'),
('nannancycheng@gmail.com'),
('naval@ravikant.com'),
('nazlie@appliedbioinc.com'),
('neil@twobearcapital.com'),
('nicolas@cure51.com'),
('nick@bonvivants.com'),
('nma@deeporigin.com'),
('rehundt@gmail.com'),
('sarita@embark.com'),
('sherman.gabrielle@gmail.com'),
('sriram@kearnyjackson.com'),
('stefan.leichenauer@sandboxquantum.com'),
('taitlogan00@gmail.com'),
('tak.the.world@gmail.com'),
('tak@tradeshift.com'),
('tang.calvin1@gmail.com'),
('tj@secondup.com'),
('w.schroll@fetchrewards.com');

-- The LifeX full newsletter list documented in README-AI.md.
create temp table matched_before as
select lm.id, lm.email, lm.status
from public.list_members lm
join ai_unsubscribe_input i on lower(trim(lm.email)) = i.email
where lm.list_id = 'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid;

update public.list_members lm
set status = 'unsubscribed',
    source = 'manual_unsubscribe',
    unsubscribed_at = coalesce(lm.unsubscribed_at, now()),
    metadata = coalesce(lm.metadata, '{}'::jsonb)
      || jsonb_build_object('manual_unsubscribe_at', now(), 'manual_unsubscribe_source', 'chatgpt_ops_2026_09_01')
from ai_unsubscribe_input i
where lm.list_id = 'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid
  and lower(trim(lm.email)) = i.email
  and lm.status not in ('unsubscribed','blocked');

insert into public.unsubscribe_requests
  (email, list_id, request_type, status, notes, requested_at, handled_at)
select i.email,
       'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid,
       'manual',
       'handled',
       'Processed from LifeX newsletter unsubscribe replies supplied 2026-09-01',
       now(),
       now()
from ai_unsubscribe_input i
where not exists (
  select 1
  from public.unsubscribe_requests ur
  where ur.list_id = 'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid
    and lower(trim(ur.email)) = i.email
    and ur.status = 'handled'
    and ur.notes = 'Processed from LifeX newsletter unsubscribe replies supplied 2026-09-01'
);

update public.mail_queue mq
set status = 'canceled',
    last_error = 'Canceled due to LifeX newsletter unsubscribe batch 2026-09-01',
    updated_at = now(),
    locked_at = null
from ai_unsubscribe_input i
where mq.list_id = 'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid
  and mq.status in ('pending','processing')
  and lower(trim(coalesce(mq.payload->>'to',''))) = i.email;

select 'INPUT_UNIQUE' as metric, count(*)::text as value from ai_unsubscribe_input;
select 'MATCHED_MEMBERS' as metric, count(*)::text as value from matched_before;
select 'NOW_UNSUBSCRIBED' as metric, count(*)::text as value
from public.list_members lm
join ai_unsubscribe_input i on lower(trim(lm.email)) = i.email
where lm.list_id = 'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid
  and lm.status = 'unsubscribed';
select 'ALREADY_BLOCKED' as metric, count(*)::text as value
from public.list_members lm
join ai_unsubscribe_input i on lower(trim(lm.email)) = i.email
where lm.list_id = 'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid
  and lm.status = 'blocked';
select 'NOT_ON_LIST' as metric, count(*)::text as value
from ai_unsubscribe_input i
where not exists (
  select 1 from public.list_members lm
  where lm.list_id = 'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid
    and lower(trim(lm.email)) = i.email
);
select 'QUEUED_REMAINING' as metric, count(*)::text as value
from public.mail_queue mq
join ai_unsubscribe_input i on lower(trim(coalesce(mq.payload->>'to',''))) = i.email
where mq.list_id = 'dbd52a08-9a38-4573-bf06-09e401015ae9'::uuid
  and mq.status in ('pending','processing');

commit;
