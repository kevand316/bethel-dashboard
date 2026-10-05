-- =============================================================================
-- Migration: 010_rent_tracker.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 6 (Rent tracker)
--
--   rent_charges  — one row per resident per month (amount due)
--   rent_payments — payments against a charge
--   rent_events   — change log (due edited, payment added/removed)
-- All per account with RLS.
--
-- IDEMPOTENT.
-- ROLLBACK: DROP TABLE IF EXISTS public.rent_events, public.rent_payments, public.rent_charges;
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.rent_charges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  month         date NOT NULL CHECK (extract(day FROM month) = 1), -- first of the month
  home_id       int  NOT NULL,
  home_name     text NOT NULL DEFAULT '',
  bed_id        int,
  resident_name text NOT NULL CHECK (char_length(btrim(resident_name)) BETWEEN 1 AND 120),
  due           numeric(10,2) NOT NULL DEFAULT 0 CHECK (due >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, month, home_id, resident_name)
);
CREATE INDEX IF NOT EXISTS rent_charges_month_idx ON public.rent_charges (user_id, month);

CREATE TABLE IF NOT EXISTS public.rent_payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  charge_id  uuid NOT NULL,
  amount     numeric(10,2) NOT NULL CHECK (amount > 0),
  paid_on    date NOT NULL DEFAULT current_date,
  logged_by  text,
  source     text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'text')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, charge_id) REFERENCES public.rent_charges (user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS rent_payments_charge_idx ON public.rent_payments (user_id, charge_id);

CREATE TABLE IF NOT EXISTS public.rent_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  charge_id  uuid,
  action     text NOT NULL,
  detail     text,
  actor      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rent_charges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rent_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rent_events   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rent_charges', 'rent_payments', 'rent_events'] LOOP
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
-- The change log is append-only from the dashboard: no update/delete.
DROP POLICY IF EXISTS "update_own" ON public.rent_events;
DROP POLICY IF EXISTS "delete_own" ON public.rent_events;
