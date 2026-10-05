-- =============================================================================
-- Migration: 016_rent_realtime.sql
-- Date:      2026-10-05
-- A rent payment texted in ("Joe at 134 Manfield paid rent") shows up on an open
-- Rent tab without a refresh. Realtime honours RLS: each browser only hears about
-- its own account's rows.
-- IDEMPOTENT. ROLLBACK: ALTER PUBLICATION supabase_realtime DROP TABLE public.rent_payments, public.rent_charges;
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rent_payments', 'rent_charges'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
