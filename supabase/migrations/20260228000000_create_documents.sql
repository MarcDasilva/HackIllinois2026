-- ============================================================
-- Migration: 20260228000000_create_documents.sql
--
-- Creates the core "documents" table whose row IDs are
-- fetched by the LAVA entropy oracle each tick, hashed,
-- and committed on-chain.
--
-- Run via:
--   Supabase Dashboard → SQL Editor → paste & run
--   OR: supabase db push (if using Supabase CLI)
-- ============================================================


-- ── Extension: pgcrypto (needed for gen_random_uuid) ────────
-- Already enabled on all Supabase projects by default.
-- Included here for completeness / local dev.
create extension if not exists "pgcrypto";


-- ── Table: documents ────────────────────────────────────────
create table if not exists public.documents (
  -- Primary key: UUID v4, auto-generated on insert.
  -- This is the value the oracle reads and hashes.
  id            uuid        primary key default gen_random_uuid(),

  -- Human-readable label for the document (e.g. file name, title).
  title         text        not null,

  -- Optional free-form content or description.
  content       text,

  -- Who owns this document. References auth.users so you can
  -- enforce per-user RLS policies later.
  -- Set to null if you don't need user-scoped documents.
  owner_id      uuid        references auth.users (id) on delete set null,

  -- Arbitrary key→value metadata (e.g. tags, source system, version).
  metadata      jsonb       not null default '{}'::jsonb,

  -- Document lifecycle status.
  -- Restrict to known values via the check constraint below.
  status        text        not null default 'active'
                  check (status in ('active', 'archived', 'deleted')),

  -- Timestamps (all stored as UTC).
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);


-- ── Indexes ──────────────────────────────────────────────────

-- Fast lookup by owner (common query pattern).
create index if not exists documents_owner_id_idx
  on public.documents (owner_id);

-- Fast lookup by status (e.g. fetch only 'active' docs).
create index if not exists documents_status_idx
  on public.documents (status);

-- Fast ordering/filtering by creation time.
create index if not exists documents_created_at_idx
  on public.documents (created_at desc);


-- ── Auto-update updated_at ────────────────────────────────────
-- Trigger function (shared; create once, reuse across tables).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger documents_set_updated_at
  before update on public.documents
  for each row
  execute function public.set_updated_at();


-- ── Row Level Security ────────────────────────────────────────
-- RLS is enabled so anonymous/public access is blocked by default.
-- The oracle uses the SERVICE ROLE key which bypasses RLS entirely.
-- Add policies below only if you also expose this table to frontend clients.

alter table public.documents enable row level security;

-- Policy: authenticated users can read their own documents.
create policy "owners can read their documents"
  on public.documents
  for select
  to authenticated
  using (owner_id = auth.uid());

-- Policy: authenticated users can insert their own documents.
create policy "owners can insert documents"
  on public.documents
  for insert
  to authenticated
  with check (owner_id = auth.uid());

-- Policy: authenticated users can update their own documents.
create policy "owners can update their documents"
  on public.documents
  for update
  to authenticated
  using (owner_id = auth.uid());

-- Policy: authenticated users can delete their own documents.
create policy "owners can delete their documents"
  on public.documents
  for delete
  to authenticated
  using (owner_id = auth.uid());


-- ── Seed: insert a few example rows ──────────────────────────
-- These are inserted without an owner_id so they are visible
-- to the oracle (service role bypasses RLS) immediately.
-- Remove or replace with your own seed data.

insert into public.documents (title, content, status, metadata) values
  ('Genesis Document',   'First document committed to the entropy oracle.', 'active',   '{"source": "seed"}'),
  ('Alpha Record',       'Second seeded document.',                          'active',   '{"source": "seed"}'),
  ('Beta Record',        'Third seeded document.',                           'active',   '{"source": "seed"}'),
  ('Gamma Record',       'Fourth seeded document.',                          'active',   '{"source": "seed"}'),
  ('Delta Record',       'Fifth seeded document.',                           'archived', '{"source": "seed"}');
