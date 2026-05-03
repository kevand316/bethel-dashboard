-- migration: 002_add_updated_at.sql
-- Adds updated_at timestamptz to bethel_data with an auto-update trigger.
-- Used by lib/autosave.js for optimistic concurrency (cross-device conflict detection).
-- Safe to re-run (idempotent).
--
-- Rollback (run manually if you need to undo):
--   DROP TRIGGER IF EXISTS set_updated_at ON bethel_data;
--   DROP FUNCTION IF EXISTS bethel_data_set_updated_at();
--   ALTER TABLE bethel_data DROP COLUMN IF EXISTS updated_at;

-- 1. Add column — IF NOT EXISTS makes this idempotent.
--    DEFAULT now() backfills existing rows at column-add time.
ALTER TABLE bethel_data
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 2. Trigger function — CREATE OR REPLACE is idempotent.
CREATE OR REPLACE FUNCTION bethel_data_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 3. Trigger — DROP + CREATE is the idempotent pattern for triggers.
DROP TRIGGER IF EXISTS set_updated_at ON bethel_data;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON bethel_data
  FOR EACH ROW
  EXECUTE FUNCTION bethel_data_set_updated_at();
