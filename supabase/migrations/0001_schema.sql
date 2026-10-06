-- =============================================================================
-- WhatsApp booking agent: schema.
--
-- Security model: RLS is ON for every table and there are NO policies. Only the
-- edge function (service_role) touches data. Functions are revoked from public,
-- anon and authenticated: in Supabase every new function is executable by the
-- anon key unless you say otherwise.
-- =============================================================================

create table public.contacts (
  id                 uuid primary key default gen_random_uuid(),
  phone              text not null unique,
  name               text,
  registered         boolean not null default false,
  -- 'human' = staff took over from the panel; the bot stays quiet.
  control            text not null default 'bot' check (control in ('bot', 'human')),
  control_changed_at timestamptz not null default now(),
  last_message_at    timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create table public.messages (
  id            bigint generated always as identity primary key,
  contact_id    uuid not null references public.contacts (id) on delete cascade,
  role          text not null check (role in ('customer', 'bot', 'human')),
  body          text not null,
  -- Meta retries webhooks; the unique id makes processing idempotent.
  wa_message_id text unique,
  created_at    timestamptz not null default now()
);
create index messages_contact_recent on public.messages (contact_id, created_at desc);

create table public.bookings (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  date       date not null,
  start_time time not null,
  end_time   time not null,
  status     text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
  created_at timestamptz not null default now(),
  constraint bookings_valid_range check (end_time > start_time),
  -- Two people asking for the same hour at the same second: the database decides,
  -- not a read-then-write in application code.
  constraint bookings_no_overlap exclude using gist (
    tsrange(date + start_time, date + end_time) with &&
  ) where (status <> 'cancelled')
);

create table public.admins (
  phone      text primary key,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- What the team has taught the bot. Injected into every conversation.
-- Turning a row off is the undo button.
create table public.knowledge (
  topic      text primary key,
  answer     text not null,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.knowledge_gaps (
  id          bigint generated always as identity primary key,
  topic       text not null unique,
  question    text not null,
  askers      text[] not null default '{}',
  status      text not null default 'open' check (status in ('open', 'asked', 'answered', 'skipped')),
  asked_admin text,
  asked_at    timestamptz,
  created_at  timestamptz not null default now()
);

-- Editable without redeploying: the base script of the bot lives here.
create table public.bot_config (
  key   text primary key,
  value text not null
);

create table public.delivery_status (
  message_id  text primary key,
  recipient   text not null,
  status      text not null,
  error_code  integer,
  error_title text,
  updated_at  timestamptz not null default now()
);

alter table public.contacts        enable row level security;
alter table public.messages        enable row level security;
alter table public.bookings        enable row level security;
alter table public.admins          enable row level security;
alter table public.knowledge       enable row level security;
alter table public.knowledge_gaps  enable row level security;
alter table public.bot_config      enable row level security;
alter table public.delivery_status enable row level security;

-- -----------------------------------------------------------------------------
-- request_booking: the overlap check is the exclusion constraint.
-- -----------------------------------------------------------------------------
create function public.request_booking(p_contact uuid, p_date date, p_start time, p_end time)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bookings (contact_id, date, start_time, end_time)
  values (p_contact, p_date, p_start, p_end);
  return jsonb_build_object('ok', true);
exception
  when exclusion_violation then
    return jsonb_build_object('ok', false, 'reason', 'slot_taken');
  when check_violation then
    return jsonb_build_object('ok', false, 'reason', 'invalid_range');
end;
$$;

-- -----------------------------------------------------------------------------
-- register_gap: should we bother an admin with this question?
-- One question per topic, ever. At most 3 questions per 24 h.
-- -----------------------------------------------------------------------------
create function public.register_gap(p_topic text, p_question text, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gap   public.knowledge_gaps;
  v_admin text;
begin
  if exists (select 1 from public.knowledge where topic = p_topic and active) then
    return jsonb_build_object('ask_admin', null);
  end if;

  insert into public.knowledge_gaps as g (topic, question, askers)
  values (p_topic, p_question, array[p_phone])
  on conflict (topic) do update
    set askers = case when p_phone = any (g.askers) then g.askers else g.askers || p_phone end
  returning * into v_gap;

  if v_gap.status <> 'open' then
    return jsonb_build_object('ask_admin', null);
  end if;

  if (select count(*) from public.knowledge_gaps where asked_at > now() - interval '24 hours') >= 3 then
    return jsonb_build_object('ask_admin', null);
  end if;

  select phone into v_admin from public.admins where active order by created_at limit 1;
  if v_admin is null then
    return jsonb_build_object('ask_admin', null);
  end if;

  update public.knowledge_gaps
     set status = 'asked', asked_admin = v_admin, asked_at = now()
   where id = v_gap.id;

  return jsonb_build_object('ask_admin', v_admin);
end;
$$;

-- -----------------------------------------------------------------------------
-- answer_gap: the admin replied. Learn it (or skip it) and return who to notify.
-- -----------------------------------------------------------------------------
create function public.answer_gap(p_admin_phone text, p_answer text, p_skip boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gap public.knowledge_gaps;
begin
  select * into v_gap
    from public.knowledge_gaps
   where status = 'asked'
     and asked_admin = p_admin_phone
     and asked_at > now() - interval '48 hours'
   order by asked_at desc
   limit 1;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  if p_skip then
    update public.knowledge_gaps set status = 'skipped' where id = v_gap.id;
    return jsonb_build_object('found', true, 'action', 'skipped', 'topic', v_gap.topic);
  end if;

  if length(trim(p_answer)) < 12 then
    return jsonb_build_object('found', true, 'action', 'too_short', 'topic', v_gap.topic);
  end if;

  insert into public.knowledge (topic, answer)
  values (v_gap.topic, trim(p_answer))
  on conflict (topic) do update set answer = excluded.answer, active = true, updated_at = now();

  update public.knowledge_gaps set status = 'answered' where id = v_gap.id;

  return jsonb_build_object(
    'found', true,
    'action', 'learned',
    'topic', v_gap.topic,
    'answer', trim(p_answer),
    -- Everyone who asked gets the answer, capped to avoid a message burst.
    'notify', to_jsonb((array_remove(v_gap.askers, p_admin_phone))[1:10])
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Lock everything down. Defaults grant EXECUTE to PUBLIC, which includes anon:
-- revoking from anon alone is not enough.
-- -----------------------------------------------------------------------------
revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.request_booking(uuid, date, time, time) to service_role;
grant execute on function public.register_gap(text, text, text) to service_role;
grant execute on function public.answer_gap(text, text, boolean) to service_role;
