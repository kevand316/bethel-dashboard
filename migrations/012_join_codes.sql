-- =============================================================================
-- Migration: 012_join_codes.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 7 (join codes)
--
--   org_profiles.join_code / join_enabled — staff text "JOIN <code> <name>"
--   team_members.status gains 'requested' (a join request awaiting the owner)
-- The dashboard still can never set status itself (guard trigger, migration 003);
-- approving a request goes through the join-decide Edge Function.
-- IDEMPOTENT.
-- ROLLBACK:
--   ALTER TABLE public.org_profiles DROP COLUMN IF EXISTS join_code, DROP COLUMN IF EXISTS join_enabled;
--   (and restore the old status CHECK without 'requested')
-- =============================================================================
ALTER TABLE public.org_profiles ADD COLUMN IF NOT EXISTS join_code text;
ALTER TABLE public.org_profiles ADD COLUMN IF NOT EXISTS join_enabled boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS org_profiles_join_code_idx ON public.org_profiles (upper(join_code)) WHERE join_code IS NOT NULL;

ALTER TABLE public.team_members DROP CONSTRAINT IF EXISTS team_members_status_check;
ALTER TABLE public.team_members ADD CONSTRAINT team_members_status_check
  CHECK (status IN ('pending', 'active', 'declined', 'blocked', 'requested'));
