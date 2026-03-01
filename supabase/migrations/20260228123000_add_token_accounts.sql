-- ============================================================
-- Migration: 20260228123000_add_token_accounts.sql
--
-- Adds a dedicated token_accounts table for the entropy oracle.
-- The oracle reads pubkeys from this table instead of relying on
-- local config/token_accounts.json.
--
-- Run via:
--   Supabase Dashboard -> SQL Editor -> paste & run
--   OR: supabase db push
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists public.token_accounts (
  id          uuid        primary key default gen_random_uuid(),
  pubkey      text        not null unique,
  is_active   boolean     not null default true,
  source      text        not null default 'bootstrap',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint token_accounts_pubkey_nonempty check (length(trim(pubkey)) > 0)
);

create index if not exists token_accounts_active_idx
  on public.token_accounts (is_active)
  where is_active = true;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger token_accounts_set_updated_at
  before update on public.token_accounts
  for each row
  execute function public.set_updated_at();

alter table public.token_accounts enable row level security;

create policy "authenticated can read token accounts"
  on public.token_accounts
  for select
  to authenticated
  using (true);
