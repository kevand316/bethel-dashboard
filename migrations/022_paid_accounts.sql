-- =============================================================================
-- Migration: 022_paid_accounts.sql
-- Date:      2026-10-06
-- Plan:      plans/paid-features.md
--
-- Accounts allowed the costly features (texting, Outreach, Edit with AI).
-- Rows are written only by the service role; a signed-in user may read their own
-- row so the dashboard knows what to show. Edge Functions enforce it server-side.
-- IDEMPOTENT. ROLLBACK: DROP TABLE IF EXISTS public.paid_accounts;
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.paid_accounts (
  user_id    uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.paid_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paid_accounts_read_own ON public.paid_accounts;
CREATE POLICY paid_accounts_read_own ON public.paid_accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());

INSERT INTO public.paid_accounts (user_id, note)
SELECT id, CASE WHEN email = 'info@bethelresidency.com' THEN 'platform owner' ELSE 'e2e robot' END
FROM auth.users
WHERE email IN ('info@bethelresidency.com', 'playwright-a@bethel.test', 'playwright-b@bethel.test')
ON CONFLICT DO NOTHING;
