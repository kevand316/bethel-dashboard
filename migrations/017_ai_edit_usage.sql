-- =============================================================================
-- Migration: 017_ai_edit_usage.sql
-- Date:      2026-10-05
-- Edit with AI tab: one row per request, so each account can be held to a daily
-- cap (every request is a paid Claude call). Only the ai-edit function writes or
-- reads it, with the service role; RLS is on with no policies, so browsers can't.
-- IDEMPOTENT. ROLLBACK: DROP TABLE public.ai_edit_usage;
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.ai_edit_usage (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_edit_usage_user_time ON public.ai_edit_usage (user_id, created_at);
ALTER TABLE public.ai_edit_usage ENABLE ROW LEVEL SECURITY;
