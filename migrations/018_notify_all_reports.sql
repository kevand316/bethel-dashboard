-- =============================================================================
-- Migration: 018_notify_all_reports.sql
-- Date:      2026-10-06
-- Roles get a "texted about every report" switch. Members of a role with it on
-- are texted about every report filed in their account (except their own), on
-- top of the sender's supervisor and notification rules. Existing Owner and
-- Operations Manager roles are switched on, matching what new accounts get.
-- IDEMPOTENT. ROLLBACK: ALTER TABLE public.team_roles DROP COLUMN notify_all_reports;
-- =============================================================================
ALTER TABLE public.team_roles
  ADD COLUMN IF NOT EXISTS notify_all_reports boolean NOT NULL DEFAULT false;

UPDATE public.team_roles SET notify_all_reports = true
 WHERE name IN ('Owner', 'Operations Manager') AND notify_all_reports = false;
