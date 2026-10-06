-- Runs against a real PostgreSQL after the migration (see .github/workflows/ci.yml).
-- Any failed assertion raises and stops psql with ON_ERROR_STOP.
\set ON_ERROR_STOP on

insert into public.contacts (id, phone, name, registered) values
  ('00000000-0000-0000-0000-00000000000a', '570000000001', 'Ana', true),
  ('00000000-0000-0000-0000-00000000000b', '570000000002', 'Beto', true);
insert into public.admins (phone, name) values ('570000000099', 'Admin');

-- 1. Bookings: overlaps are rejected by the database, cancelled ones free the slot.
do $$
declare r jsonb;
begin
  r := public.request_booking('00000000-0000-0000-0000-00000000000a', '2030-01-10', '09:00', '12:00');
  assert r->>'ok' = 'true', 'first booking should succeed: ' || r::text;

  r := public.request_booking('00000000-0000-0000-0000-00000000000b', '2030-01-10', '11:00', '13:00');
  assert r->>'reason' = 'slot_taken', 'overlap should be rejected: ' || r::text;

  r := public.request_booking('00000000-0000-0000-0000-00000000000b', '2030-01-10', '12:00', '13:00');
  assert r->>'ok' = 'true', 'back-to-back booking should succeed: ' || r::text;

  r := public.request_booking('00000000-0000-0000-0000-00000000000b', '2030-01-11', '15:00', '14:00');
  assert r->>'reason' = 'invalid_range', 'end before start should be rejected: ' || r::text;

  update public.bookings set status = 'cancelled'
   where contact_id = '00000000-0000-0000-0000-00000000000a';
  r := public.request_booking('00000000-0000-0000-0000-00000000000b', '2030-01-10', '10:00', '11:00');
  assert r->>'ok' = 'true', 'cancelled booking should free the slot: ' || r::text;
end $$;

-- 2. Learning: one question per topic, askers accumulate, answer notifies them.
do $$
declare r jsonb;
begin
  r := public.register_gap('parking', 'is there parking?', '570000000001');
  assert r->>'ask_admin' = '570000000099', 'first gap should ask the admin: ' || r::text;

  r := public.register_gap('parking', 'where do I park?', '570000000002');
  assert r->'ask_admin' = 'null'::jsonb, 'same topic must not be asked twice: ' || r::text;

  r := public.answer_gap('570000000099', 'ok');
  assert r->>'action' = 'too_short', 'short answers are rejected: ' || r::text;

  r := public.answer_gap('570000000099', 'Yes, free parking in the basement.');
  assert r->>'action' = 'learned', 'answer should be learned: ' || r::text;
  assert r->'notify' = '["570000000001", "570000000002"]'::jsonb, 'both askers notified: ' || r::text;
  assert (select answer from public.knowledge where topic = 'parking') like 'Yes, free parking%';

  r := public.register_gap('parking', 'parking?', '570000000003');
  assert r->'ask_admin' = 'null'::jsonb, 'known topics are not asked again: ' || r::text;
end $$;

-- 3. Learning: at most 3 questions to admins per 24 hours.
do $$
declare r jsonb;
begin
  -- 'parking' was asked today; two more fill the quota.
  perform public.register_gap('pets', 'can I bring my dog?', '570000000001');
  perform public.register_gap('wifi', 'is there wifi?', '570000000001');
  r := public.register_gap('food', 'can I bring food?', '570000000001');
  assert r->'ask_admin' = 'null'::jsonb, 'fourth question in 24 h must wait: ' || r::text;
end $$;

-- 4. The anon key can't call internal functions or read tables (expects 42501).
set role anon;
do $$
begin
  begin
    perform public.register_gap('x', 'y', 'z');
    raise exception 'anon could execute register_gap';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.messages;
    raise exception 'anon could read messages';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\echo 'schema tests: all passed'
