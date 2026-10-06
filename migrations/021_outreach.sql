-- =============================================================================
-- Migration: 021_outreach.sql
-- Date:      2026-10-06
-- Outreach tab (plans/outreach.md): saved web searches for referral organizations.
--   outreach_lists — one per search (query, area, status searching|done|failed)
--   outreach_orgs  — the organizations found, with the operator's call status + notes
-- Per account with RLS. Only the server (service role) inserts; the dashboard may
-- read, update (notes/status) and delete its own rows.
-- IDEMPOTENT.
-- ROLLBACK: DROP TABLE IF EXISTS public.outreach_orgs, public.outreach_lists;
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.outreach_lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  query      text NOT NULL CHECK (char_length(btrim(query)) BETWEEN 1 AND 300),
  area       text NOT NULL DEFAULT '' CHECK (char_length(area) <= 120),
  status     text NOT NULL DEFAULT 'searching' CHECK (status IN ('searching', 'done', 'failed')),
  summary    text NOT NULL DEFAULT '',
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS outreach_lists_user_idx ON public.outreach_lists (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.outreach_orgs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  list_id       uuid NOT NULL,
  sort          int  NOT NULL DEFAULT 0,
  name          text NOT NULL,
  category      text,
  address       text,
  phone         text,
  phone_label   text,
  contact_name  text,
  contact_title text,
  email         text,
  website       text,
  source_url    text,
  why           text,
  call_status   text NOT NULL DEFAULT 'not_called'
                CHECK (call_status IN ('not_called', 'called', 'left_message', 'interested', 'not_fit')),
  notes         text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 5000),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, list_id) REFERENCES public.outreach_lists (user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS outreach_orgs_list_idx ON public.outreach_orgs (user_id, list_id, sort);

ALTER TABLE public.outreach_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_orgs  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outreach_lists', 'outreach_orgs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "select_own" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "update_own" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "delete_own" ON public.%I', t);
    EXECUTE format('CREATE POLICY "select_own" ON public.%I FOR SELECT TO authenticated USING (user_id = auth.uid())', t);
    EXECUTE format('CREATE POLICY "update_own" ON public.%I FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())', t);
    EXECUTE format('CREATE POLICY "delete_own" ON public.%I FOR DELETE TO authenticated USING (user_id = auth.uid())', t);
  END LOOP;
END $$;
-- No insert policy: only the outreach-search function (service role) creates rows.
