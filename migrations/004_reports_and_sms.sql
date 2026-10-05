-- =============================================================================
-- Migration: 004_reports_and_sms.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 2 (inbound texting + filing reports)
--
-- What this does:
--   1. org_profiles.timezone
--   2. reports + report_photos (per account, RLS)
--   3. private storage bucket report-photos, readable only inside your own folder
--   4. sms_messages (audit log; owner can read their own rows, server writes)
--   5. sms_conversations, sms_phone_prefs (server-only: RLS on, no policies)
--
-- IDEMPOTENT: safe to run twice.
--
-- ROLLBACK (deletes all reports, photos metadata and texting history):
--   DROP TABLE IF EXISTS public.report_photos, public.reports, public.sms_messages,
--     public.sms_conversations, public.sms_phone_prefs;
--   ALTER TABLE public.org_profiles DROP COLUMN IF EXISTS timezone;
-- =============================================================================

-- 1. Timezone ---------------------------------------------------------------------
ALTER TABLE public.org_profiles
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Los_Angeles';

-- 2. Reports ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  bucket           text NOT NULL CHECK (bucket IN ('inventory', 'incidents', 'projections',
                     'maintenance', 'cleanings', 'move_ins_outs', 'announcements')),
  subtype          text,
  urgent           boolean NOT NULL DEFAULT false,
  home_id          int,
  home_name        text,
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary          text NOT NULL DEFAULT '',
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  sender_member_id uuid,
  sender_name      text,
  sender_phone     text,
  source           text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('text', 'dashboard', 'calculator')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS reports_user_created_idx ON public.reports (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.report_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  report_id    uuid NOT NULL,
  storage_path text NOT NULL,
  content_type text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, report_id) REFERENCES public.reports (user_id, id) ON DELETE CASCADE,
  -- A row may only point into its own account's folder.
  CHECK (storage_path LIKE user_id::text || '/%')
);

-- 3. Storage ----------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('report-photos', 'report-photos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "report_photos_read_own" ON storage.objects;
CREATE POLICY "report_photos_read_own" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'report-photos' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "report_photos_insert_own" ON storage.objects;
CREATE POLICY "report_photos_insert_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'report-photos' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "report_photos_delete_own" ON storage.objects;
CREATE POLICY "report_photos_delete_own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'report-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 4. Text message log ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sms_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users (id) ON DELETE CASCADE, -- null until an account is known
  direction   text NOT NULL CHECK (direction IN ('in', 'out')),
  phone       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  media_count int  NOT NULL DEFAULT 0,
  twilio_sid  text,
  status      text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_messages_user_idx  ON public.sms_messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_messages_phone_idx ON public.sms_messages (phone, created_at DESC);

-- 5. Server-only conversation state -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sms_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  phone      text NOT NULL,
  member_id  uuid NOT NULL,
  history    jsonb NOT NULL DEFAULT '[]'::jsonb,
  draft      jsonb,
  photos     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filed', 'expired', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_conversations_open_idx ON public.sms_conversations (user_id, phone, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.sms_phone_prefs (
  phone      text PRIMARY KEY,
  user_id    uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  choosing   boolean NOT NULL DEFAULT false, -- true while "Which org?" is awaiting an answer
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS ---------------------------------------------------------------------------------
ALTER TABLE public.reports           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_photos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_phone_prefs   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reports', 'report_photos'] LOOP
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

-- Owners may read their own text log; nobody but the server writes it.
DROP POLICY IF EXISTS "select_own" ON public.sms_messages;
CREATE POLICY "select_own" ON public.sms_messages FOR SELECT TO authenticated USING (user_id = auth.uid());
-- sms_conversations and sms_phone_prefs: RLS on with no policies = server (service_role) only.
