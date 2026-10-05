-- =============================================================================
-- Migration: 011_intake_link.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 6b (intake link by text, interim version)
--
-- The intake form link texted back when someone texts "intake". Only a link is
-- ever sent; no intake answers pass through texting.
-- IDEMPOTENT. ROLLBACK: ALTER TABLE public.org_profiles DROP COLUMN IF EXISTS intake_url;
-- =============================================================================
ALTER TABLE public.org_profiles ADD COLUMN IF NOT EXISTS intake_url text
  CHECK (intake_url IS NULL OR intake_url ~ '^https://');
