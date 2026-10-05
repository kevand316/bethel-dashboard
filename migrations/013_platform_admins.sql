-- =============================================================================
-- Migration: 013_platform_admins.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 8 (platform admin view)
--
-- Who may see the cross-account Admin view. Server-only (RLS on, no policies):
-- the platform-admin Edge Function checks membership with the service role.
-- Seeded with the platform owner's account.
-- IDEMPOTENT. ROLLBACK: DROP TABLE IF EXISTS public.platform_admins;
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_admins (user_id)
SELECT id FROM auth.users WHERE email = 'info@bethelresidency.com'
ON CONFLICT DO NOTHING;
