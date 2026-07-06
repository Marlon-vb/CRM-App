-- Cadence — Supabase schema (Phase 4: Mac-as-hub cloud publish).
-- Run ONCE in your Supabase project's SQL editor. Safe to run alongside
-- PipeWise's schema in the same project: every table is cadence_-prefixed.
--
-- Model: the Mac is the single compute hub. It publishes the COMPUTED
-- follow-up queue plus the data the phone needs to render and act
-- (relationships, todos, promises, snoozes) after every sweep. The phone
-- is a read/act client: it flips todos, snoozes queue items, resolves
-- promises — those writes flow back and the Mac applies them on its next
-- sync, then republishes. Telegram sessions and all extraction stay on
-- the Mac; nothing sensitive lands here beyond message excerpts inside
-- queue-item payloads (same exposure class as the local telegram cache).
--
-- Identity: rows are keyed by (user_id, local_id) — the Mac's SQLite ids.
-- One hub per account means no cross-device id reconciliation is needed
-- (the PipeWise cloud_id adoption dance does not apply here).

create extension if not exists "uuid-ossp";

-- Shared touch trigger — updated_at drives the Mac's pull cursor and
-- last-write-wins comparisons.
create or replace function cadence_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── relationships (display + cadence edits) ─────────────────────────
create table if not exists cadence_relationships (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  local_id      bigint not null,
  name          text not null,
  company       text,
  cadence_days  integer not null default 14,
  archived_at   text,
  last_activity text,           -- ISO; newest across all the client's chats
  telegram_chat_id text,        -- primary chat — powers tg:// deep links on the phone
  updated_at    timestamptz not null default now(),
  unique (user_id, local_id)
);

-- ── todos (phone can complete / star / My-Day) ──────────────────────
create table if not exists cadence_todos (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  local_id      bigint not null,
  task          text not null,
  relationship_local_id bigint,
  source        text,
  due_date      text,
  priority      text,
  starred       boolean not null default false,
  my_day        boolean not null default false,
  completed     boolean not null default false,
  completed_at  text,
  deleted       boolean not null default false,
  sort_order    double precision,
  updated_at    timestamptz not null default now(),
  unique (user_id, local_id)
);

-- ── promises (phone can resolve kept / dropped) ─────────────────────
create table if not exists cadence_promises (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  local_id      bigint not null,
  relationship_local_id bigint,
  direction     text not null default 'mine',
  text          text not null,
  due_hint      text,
  promised_at   text,
  status        text not null default 'open',
  resolved_at   text,
  updated_at    timestamptz not null default now(),
  unique (user_id, local_id)
);

-- ── snoozes (two-way: phone snoozes, Mac honors on next build) ──────
create table if not exists cadence_snoozes (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  item_key        text not null,
  mode            text not null default 'until',
  until           text,
  last_inbound_at text,
  cleared         boolean not null default false,  -- tombstone: unsnooze syncs as cleared=true
  updated_at      timestamptz not null default now(),
  unique (user_id, item_key)
);

-- ── the computed queue (Mac writes after every build; phone reads) ──
create table if not exists cadence_queue_items (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  item_key      text not null,
  kind          text not null,
  urgency       double precision not null default 0,
  relationship_local_id bigint,
  payload       jsonb not null default '{}'::jsonb,  -- the full queue item (why, messages, bundle, activeChat…)
  swept_at      text,
  generated_at  text,
  updated_at    timestamptz not null default now(),
  unique (user_id, item_key)
);

-- ── touch triggers ──────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['cadence_relationships','cadence_todos','cadence_promises','cadence_snoozes','cadence_queue_items']
  loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format(
      'create trigger %I before update on %I for each row execute function cadence_touch_updated_at()',
      t || '_touch', t
    );
  end loop;
end $$;

-- ── RLS: each user sees only their own rows ─────────────────────────
do $$
declare t text;
begin
  foreach t in array array['cadence_relationships','cadence_todos','cadence_promises','cadence_snoozes','cadence_queue_items']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for select using (user_id = auth.uid())', t || '_select', t);
    execute format('create policy %I on %I for insert with check (user_id = auth.uid())', t || '_insert', t);
    execute format('create policy %I on %I for update using (user_id = auth.uid()) with check (user_id = auth.uid())', t || '_update', t);
    execute format('create policy %I on %I for delete using (user_id = auth.uid())', t || '_delete', t);
  end loop;
end $$;
