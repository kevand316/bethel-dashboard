-- =============================================================================
-- Migration: 014_intake_links.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 6b full version (intake link by text)
--
--   google_connections — the owner's Google refresh token (drive.file, offline),
--                        so a texted link can save to their Drive. Server-only.
--   intake_links       — one-time, 24-hour links; only a SHA-256 of the token is
--                        stored. Owners can read their own (audit), server writes.
-- No intake answers are stored anywhere here: the phone saves straight to Drive.
-- IDEMPOTENT. ROLLBACK: DROP TABLE IF EXISTS public.intake_links, public.google_connections;
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.google_connections (
  user_id       uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  refresh_token text NOT NULL,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.google_connections ENABLE ROW LEVEL SECURITY; -- no policies: server only

CREATE TABLE IF NOT EXISTS public.intake_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  member_id   uuid,
  member_name text,
  prefill     jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.intake_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own" ON public.intake_links;
CREATE POLICY "select_own" ON public.intake_links FOR SELECT TO authenticated USING (user_id = auth.uid());
