-- =============================================================================
-- Migration: 001_enable_auth_and_rls.sql
-- Project:   bethel-dashboard (yqgccykbdihsjqlapghr.supabase.co)
-- Date:      2026-05-03
--
-- What this does (in order):
--   1. Adds user_id column to bethel_data
--   2. Backfills BOTH existing rows (id='homes' and id='snapshots') with the
--      operator's auth user ID — homes = property/bed/expense data;
--      snapshots = saved portfolio summary reports; both belong to the operator
--   3. Makes user_id NOT NULL (fails loudly if any row was missed in step 2)
--   4. Replaces the single-column primary key (id) with a composite primary key
--      (id, user_id) so multiple users can each have an id='homes' row
--   5. Enables Row Level Security so every query is scoped to the signed-in user
--   6. Creates SELECT / INSERT / UPDATE / DELETE policies, all gated on
--      user_id = auth.uid()
--
-- DEPLOYMENT NOTE:
--   This migration must be applied AT THE SAME TIME as the new code
--   (lib/supabase.js, lib/auth.js, login.html, updated index.html) goes live.
--   The safe sequence is:
--     1. Push new code to GitHub (GitHub Pages takes ~2 min to update)
--     2. Immediately run this migration in the Supabase SQL editor
--     3. Verify the live site works
--   Do NOT run this migration while the old code is still live — the old code
--   uses the anon key with no user JWT, which RLS will block once enabled.
--
-- ROLLBACK (paste into Supabase SQL editor if something goes wrong):
--   ALTER TABLE public.bethel_data DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS "select_own" ON public.bethel_data;
--   DROP POLICY IF EXISTS "insert_own" ON public.bethel_data;
--   DROP POLICY IF EXISTS "update_own" ON public.bethel_data;
--   DROP POLICY IF EXISTS "delete_own" ON public.bethel_data;
--   ALTER TABLE public.bethel_data DROP CONSTRAINT IF EXISTS bethel_data_pkey;
--   ALTER TABLE public.bethel_data ADD PRIMARY KEY (id);
--   ALTER TABLE public.bethel_data ALTER COLUMN user_id DROP NOT NULL;
--   -- Only drop user_id if you want to fully revert and no new rows have been written:
--   -- ALTER TABLE public.bethel_data DROP COLUMN IF EXISTS user_id;
--
-- IDEMPOTENT: safe to run twice — all steps check before acting.
-- =============================================================================

-- ── Step 1: Add user_id column ───────────────────────────────────────────────
ALTER TABLE public.bethel_data
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- ── Step 2: Backfill operator's existing rows ────────────────────────────────
-- Both rows belong to the operator (kevand316).
-- If this UPDATE affects 0 rows, step 3 will fail loudly — that is intentional.
UPDATE public.bethel_data
SET user_id = 'a2d76e85-effe-4146-b967-07fbf9fad6f4'::uuid
WHERE user_id IS NULL;

-- ── Step 3: Make user_id NOT NULL ────────────────────────────────────────────
-- Safe now because all existing rows were backfilled in step 2.
-- Fails loudly if any row still has NULL — do not override the error.
ALTER TABLE public.bethel_data
  ALTER COLUMN user_id SET NOT NULL;

-- ── Step 4: Replace single-column PK with composite PK (id, user_id) ────────
-- Only acts if user_id is not already part of the primary key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_index     i
    JOIN   pg_attribute a ON a.attrelid = i.indrelid
                         AND a.attnum   = ANY(i.indkey)
    WHERE  i.indrelid   = 'public.bethel_data'::regclass
    AND    i.indisprimary
    AND    a.attname    = 'user_id'
  ) THEN
    ALTER TABLE public.bethel_data DROP CONSTRAINT IF EXISTS bethel_data_pkey;
    ALTER TABLE public.bethel_data ADD PRIMARY KEY (id, user_id);
  END IF;
END $$;

-- ── Step 5: Enable Row Level Security ────────────────────────────────────────
ALTER TABLE public.bethel_data ENABLE ROW LEVEL SECURITY;

-- ── Step 6: Per-user access policies ─────────────────────────────────────────
-- DROP IF EXISTS before each CREATE so re-running this migration is safe.

DROP POLICY IF EXISTS "select_own" ON public.bethel_data;
CREATE POLICY "select_own" ON public.bethel_data
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own" ON public.bethel_data;
CREATE POLICY "insert_own" ON public.bethel_data
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own" ON public.bethel_data;
CREATE POLICY "update_own" ON public.bethel_data
  FOR UPDATE USING  (user_id = auth.uid())
             WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own" ON public.bethel_data;
CREATE POLICY "delete_own" ON public.bethel_data
  FOR DELETE USING (user_id = auth.uid());
