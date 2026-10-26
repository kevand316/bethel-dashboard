-- =============================================================================
-- Migration: 023_call_intake.sql
-- Date:      2026-10-26
-- Plan:      plans/phone-intake.md
--
-- Reports filed by the phone-intake automation (Edge Function call-intake) carry
-- source 'call'. They are ordinary Move-ins/outs reports with no roster change;
-- details.call_intake holds {move_in_date, drive_file_id, client_label, reminded_at}.
-- Only a first name + last initial is stored. No intake answers.
--
-- IDEMPOTENT.
-- ROLLBACK: UPDATE public.reports SET source = 'dashboard' WHERE source = 'call';
--           then re-add the check without 'call'; DROP INDEX IF EXISTS reports_call_intake_date_idx;
-- =============================================================================
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_source_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_source_check
  CHECK (source IN ('text', 'dashboard', 'calculator', 'call'));

CREATE INDEX IF NOT EXISTS reports_call_intake_date_idx
  ON public.reports (user_id, ((details -> 'call_intake' ->> 'move_in_date')))
  WHERE bucket = 'move_ins_outs';
