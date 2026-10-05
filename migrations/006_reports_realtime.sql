-- =============================================================================
-- Migration: 006_reports_realtime.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 3 (texted reports appear without refresh)
--
-- Adds `reports` to Supabase Realtime. Realtime honours RLS, so a browser only
-- receives changes to its own account's reports.
-- IDEMPOTENT. ROLLBACK: ALTER PUBLICATION supabase_realtime DROP TABLE public.reports;
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'reports'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.reports;
  END IF;
END $$;
