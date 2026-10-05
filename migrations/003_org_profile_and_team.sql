-- =============================================================================
-- Migration: 003_org_profile_and_team.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 1 (Organization profile + Team page)
--
-- What this does:
--   1. org_profiles  — one row per account: the organization name shown under
--                      "HouseBoss" and used in every outbound text.
--   2. team_roles    — per-account, user-editable roles with permission flags.
--   3. team_members  — per-account people + phone numbers, role, homes,
--                      reports-to. A phone may appear on several accounts.
--   4. RLS on all three: every row is scoped to user_id = auth.uid().
--   5. Cross-account references are impossible: role and reports-to are
--      composite foreign keys that include user_id.
--   6. A member's status can never be set to 'active' from the dashboard.
--      Only the texting server (service_role) can, after the phone replies YES.
--
-- How to apply: paste this whole file into the Supabase SQL editor and Run.
-- IDEMPOTENT: safe to run twice.
--
-- ROLLBACK (paste into Supabase SQL editor; deletes all team/profile data):
--   DROP TABLE IF EXISTS public.team_members;
--   DROP TABLE IF EXISTS public.team_roles;
--   DROP TABLE IF EXISTS public.org_profiles;
--   DROP FUNCTION IF EXISTS public.team_members_guard_status();
-- =============================================================================

-- 1. Organization profile ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org_profiles (
  user_id    uuid PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  org_name   text NOT NULL CHECK (char_length(btrim(org_name)) BETWEEN 1 AND 80),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Roles -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_roles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  sort_order         int  NOT NULL DEFAULT 0,
  can_file_reports   boolean NOT NULL DEFAULT true,
  can_approve_roster boolean NOT NULL DEFAULT false,
  can_log_rent       boolean NOT NULL DEFAULT false,
  can_announce       boolean NOT NULL DEFAULT false,
  can_request_intake boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, name)
);

-- 3. Members ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  -- US numbers only for now, stored as E.164: +1 and ten digits.
  phone      text NOT NULL CHECK (phone ~ '^\+1[2-9][0-9]{9}$'),
  role_id    uuid NOT NULL,
  all_homes  boolean NOT NULL DEFAULT false,
  home_ids   int[]   NOT NULL DEFAULT '{}',
  reports_to uuid,
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'active', 'declined', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, phone),
  -- Composite keys: a role or supervisor from another account cannot be referenced.
  FOREIGN KEY (user_id, role_id)    REFERENCES public.team_roles   (user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, reports_to) REFERENCES public.team_members (user_id, id),
  CHECK (reports_to IS NULL OR reports_to <> id)
);

-- Texting server looks members up by phone across accounts.
CREATE INDEX IF NOT EXISTS team_members_phone_idx ON public.team_members (phone);

-- Removing a supervisor leaves their reports with no supervisor rather than
-- blocking the delete. (A composite FK can't use ON DELETE SET NULL on just one
-- column in older Postgres, so do it in a trigger.)
CREATE OR REPLACE FUNCTION public.team_members_clear_reports_to()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.team_members SET reports_to = NULL
   WHERE user_id = OLD.user_id AND reports_to = OLD.id;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS team_members_clear_reports_to ON public.team_members;
CREATE TRIGGER team_members_clear_reports_to
  BEFORE DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_members_clear_reports_to();

-- 6. Consent guard: the dashboard can never mark someone 'active'.
CREATE OR REPLACE FUNCTION public.team_members_guard_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.status := 'pending';
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.status := OLD.status;
    END IF;
    -- Changing the phone number means the new phone hasn't agreed to anything.
    IF TG_OP = 'UPDATE' AND NEW.phone IS DISTINCT FROM OLD.phone THEN
      NEW.status := 'pending';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS team_members_guard_status ON public.team_members;
CREATE TRIGGER team_members_guard_status
  BEFORE INSERT OR UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_members_guard_status();

-- 4. RLS -------------------------------------------------------------------------
ALTER TABLE public.org_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_roles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_profiles', 'team_roles', 'team_members'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "select_own" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "insert_own" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "update_own" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "delete_own" ON public.%I', t);
    EXECUTE format('CREATE POLICY "select_own" ON public.%I FOR SELECT TO authenticated USING (user_id = auth.uid())', t);
    EXECUTE format('CREATE POLICY "insert_own" ON public.%I FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())', t);
    EXECUTE format('CREATE POLICY "update_own" ON public.%I FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())', t);
    EXECUTE format('CREATE POLICY "delete_own" ON public.%I FOR DELETE TO authenticated USING (user_id = auth.uid())', t);
  END LOOP;
END $$;
