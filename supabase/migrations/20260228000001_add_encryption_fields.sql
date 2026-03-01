-- ============================================================
-- Migration: 20260228000001_add_encryption_fields.sql
--
-- Adds encryption and Google Drive integration fields to the
-- documents table to support VeilDoc encryption with continuous
-- monitoring via webhooks.
--
-- Run via:
--   Supabase Dashboard → SQL Editor → paste & run
--   OR: supabase db push (if using Supabase CLI)
-- ============================================================


-- ── Add encryption-related columns to documents table ──────

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS google_drive_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS google_drive_name TEXT,
  ADD COLUMN IF NOT EXISTS encryption_status TEXT DEFAULT 'pending' 
    CHECK (encryption_status IN ('pending', 'processing', 'encrypted', 'failed')),
  ADD COLUMN IF NOT EXISTS encryption_method TEXT 
    CHECK (encryption_method IN ('veildoc_full', 'veildoc_pattern')),
  ADD COLUMN IF NOT EXISTS encryption_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS webhook_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS webhook_resource_id TEXT,
  ADD COLUMN IF NOT EXISTS webhook_expiration TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_encrypted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS drive_modified_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_drive_url TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_drive_url TEXT,
  ADD COLUMN IF NOT EXISTS sidecar_json JSONB,
  ADD COLUMN IF NOT EXISTS error_message TEXT;


-- ── Create indexes for efficient querying ──────────────────

-- Fast lookup by Google Drive file ID
CREATE INDEX IF NOT EXISTS documents_google_drive_id_idx 
  ON public.documents(google_drive_id);

-- Fast filtering by encryption status
CREATE INDEX IF NOT EXISTS documents_encryption_status_idx 
  ON public.documents(encryption_status);

-- Efficient queries for actively monitored files
CREATE INDEX IF NOT EXISTS documents_encryption_enabled_idx 
  ON public.documents(encryption_enabled) 
  WHERE encryption_enabled = true;

-- Quick lookup for webhook renewal (find expiring webhooks)
CREATE INDEX IF NOT EXISTS documents_webhook_expiration_idx 
  ON public.documents(webhook_expiration) 
  WHERE encryption_enabled = true;


-- ── Update RLS policies to include new fields ──────────────

-- Note: Existing RLS policies on the documents table will continue
-- to work. The service role key (used by the backend) bypasses RLS.
-- Frontend clients using authenticated user tokens will be subject
-- to the existing RLS policies.

COMMENT ON COLUMN public.documents.google_drive_id IS 
  'Unique identifier for the file in Google Drive';

COMMENT ON COLUMN public.documents.encryption_enabled IS 
  'Whether continuous encryption monitoring is active for this file';

COMMENT ON COLUMN public.documents.webhook_channel_id IS 
  'Google Drive webhook channel ID for monitoring file changes';

COMMENT ON COLUMN public.documents.sidecar_json IS 
  'VeilDoc obfuscation mapping for reversibility';
