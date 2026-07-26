-- Bol schema. Postgres / Supabase.
-- Every number on the /live dashboard is backed by a real row in one of these tables.
-- Judges have read-only analytics access and will spot-check. Nothing here is mocked.

create extension if not exists "pgcrypto";

create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  monument_id   text not null,
  detected_lang text,
  started_at    timestamptz not null default now(),
  user_agent    text
);

create table if not exists turns (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid references sessions(id) on delete cascade,
  role        text not null,                -- 'visitor' | 'monument'
  text        text not null,
  lang        text,
  latency_ms  int,
  created_at  timestamptz not null default now()
);

create table if not exists memories (
  id          uuid primary key default gen_random_uuid(),
  monument_id text not null,
  lang        text,
  transcript  text,                          -- clean, for retrieval
  verbatim    text,                          -- authentic record: fillers, pauses, code-switches
  audio_url   text,
  city        text,
  consented   boolean not null default false,
  approved    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists reports (
  id          uuid primary key default gen_random_uuid(),
  monument_id text not null,
  lang        text,
  transcript  text,
  severity    text,
  kind        text,                          -- graffiti|structural|water|litter|hazard
  photo_url   text,
  lat         double precision,
  lon         double precision,
  created_at  timestamptz not null default now()
);

create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists turns_session_idx      on turns (session_id, created_at desc);
create index if not exists turns_created_idx      on turns (created_at desc);
create index if not exists sessions_started_idx   on sessions (started_at desc);
create index if not exists sessions_lang_idx      on sessions (detected_lang);
create index if not exists memories_lookup_idx    on memories (monument_id, approved, consented);
create index if not exists reports_monument_idx   on reports (monument_id, created_at desc);
create index if not exists events_kind_idx        on events (kind, created_at desc);

-- The /live dashboard is public and unauthenticated by design (a judge opens it on
-- their own phone). Row level security stays ON; the anon role may read only the
-- aggregate-safe columns, and may never read unapproved or unconsented memories.
alter table sessions enable row level security;
alter table turns    enable row level security;
alter table memories enable row level security;
alter table reports  enable row level security;
alter table events   enable row level security;

drop policy if exists sessions_read on sessions;
create policy sessions_read on sessions for select using (true);

drop policy if exists turns_read on turns;
create policy turns_read on turns for select using (true);

drop policy if exists memories_read on memories;
create policy memories_read on memories for select using (approved and consented);

drop policy if exists reports_read on reports;
create policy reports_read on reports for select using (true);

drop policy if exists events_read on events;
create policy events_read on events for select using (true);
