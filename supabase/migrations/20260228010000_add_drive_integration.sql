-- ============================================================
-- Migration: 20260228010000_add_drive_integration.sql
--
-- Adds Google Drive integration support:
--   1. New table: user_integrations — stores per-user OAuth tokens
--   2. Alter table: documents — adds Drive-specific columns
--
-- Run via:
--   Supabase Dashboard → SQL Editor → paste & run
--   OR: supabase db push (if using Supabase CLI)
-- ============================================================


-- ── Table: user_integrations ─────────────────────────────────
-- Stores OAuth 2.0 tokens for each user's Google Drive connection.
-- The backend refreshes access_token using refresh_token automatically.

create table if not exists public.user_integrations (
  id              uuid        primary key default gen_random_uuid(),

  -- The Supabase auth user this token belongs to.
  user_id         uuid        not null references auth.users (id) on delete cascade,

  -- OAuth provider identifier (e.g. 'google_drive').
  provider        text        not null,

  -- OAuth 2.0 tokens. Stored encrypted-at-rest by Supabase (AES-256).
  access_token    text        not null,
  refresh_token   text        not null,

  -- When the access_token expires (UTC). Used to decide if a refresh is needed.
  token_expires_at timestamptz not null,

  -- Google user email — useful for display/debug; never used for auth decisions.
  google_email    text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One integration record per user per provider.
  unique (user_id, provider)
);

-- Auto-update updated_at (reuse the trigger function from migration 1)
create or replace trigger user_integrations_set_updated_at
  before update on public.user_integrations
  for each row
  execute function public.set_updated_at();

-- Index for fast lookup by user_id (most common query)
create index if not exists user_integrations_user_id_idx
  on public.user_integrations (user_id);


-- ── RLS: user_integrations ────────────────────────────────────
alter table public.user_integrations enable row level security;

-- Users can only see their own integration record.
create policy "users can read own integrations"
  on public.user_integrations
  for select
  to authenticated
  using (user_id = auth.uid());

-- Users can insert their own integration record.
create policy "users can insert own integrations"
  on public.user_integrations
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- Users can update their own integration record (e.g. token refresh).
create policy "users can update own integrations"
  on public.user_integrations
  for update
  to authenticated
  using (user_id = auth.uid());

-- Users can delete their own integration record (revoke).
create policy "users can delete own integrations"
  on public.user_integrations
  for delete
  to authenticated
  using (user_id = auth.uid());


-- ── Alter: documents — add Drive-specific columns ─────────────
-- These columns are null for legacy rows that predate Drive integration.

alter table public.documents
  -- The Google Drive file ID (e.g. "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms")
  add column if not exists drive_file_id    text,

  -- The Google Drive folder where the file currently lives.
  add column if not exists drive_folder_id  text,

  -- MIME type of the Drive file (e.g. "application/pdf", "application/vnd.google-apps.document").
  add column if not exists mime_type        text,

  -- Transfer lifecycle status.
  -- 'none'       — no transfer requested
  -- 'pending'    — POST /transfer called, job not yet started
  -- 'in_progress'— Drive API call in flight
  -- 'done'       — transfer completed successfully
  -- 'error'      — last transfer attempt failed (see transfer_error)
  add column if not exists transfer_status  text not null default 'none'
    check (transfer_status in ('none', 'pending', 'in_progress', 'done', 'error')),

  -- Target folder for the next/current transfer (Drive folder ID).
  add column if not exists transfer_target_folder_id text,

  -- Error message from the last failed transfer attempt.
  add column if not exists transfer_error   text,

  -- When the last successful transfer completed.
  add column if not exists transferred_at   timestamptz;

-- Index: find all documents that need processing.
create index if not exists documents_transfer_status_idx
  on public.documents (transfer_status)
  where transfer_status in ('pending', 'in_progress');

-- Index: look up documents by their Drive file ID.
create index if not exists documents_drive_file_id_idx
  on public.documents (drive_file_id)
  where drive_file_id is not null;
