-- =============================================================================
-- Migration: 005_sms_blocks.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, isolation guarantee 4 (BLOCK)
--
-- A phone that replies BLOCK to an invite can never be invited by that account
-- again, even if the owner deletes and re-adds them. Server-only table.
--
-- IDEMPOTENT. ROLLBACK: DROP TABLE IF EXISTS public.sms_blocks;
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.sms_blocks (
  phone      text NOT NULL,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone, user_id)
);
ALTER TABLE public.sms_blocks ENABLE ROW LEVEL SECURITY; -- no policies: server only
