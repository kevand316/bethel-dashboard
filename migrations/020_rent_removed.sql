-- =============================================================================
-- Migration: 020_rent_removed.sql
-- Date:      2026-10-06
-- Rent tab Remove: a resident can be taken off one month's checklist without
-- losing the row or its payments. A removed row stays in the table (so the
-- roster sync, which only adds missing names, never puts them back) and is left
-- out of that month's list, totals, past due and texted "who owes".
-- IDEMPOTENT. ROLLBACK: ALTER TABLE public.rent_charges DROP COLUMN removed_at, DROP COLUMN removed_by;
-- =============================================================================
ALTER TABLE public.rent_charges
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by text;
