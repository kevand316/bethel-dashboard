-- =============================================================================
-- Migration: 015_snapshots_to_reports.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, "Revisions requested by Kev" item 2
--
-- The Snapshots tab is gone; saved portfolio snapshots live in Reports →
-- Projections (subtype 'snapshot'). Copies every existing snapshot from the
-- bethel_data 'snapshots' row into reports, once. The old row is left untouched.
-- IDEMPOTENT: skips any snapshot already copied (details->>'snapshot_id').
-- ROLLBACK: DELETE FROM public.reports WHERE subtype = 'snapshot' AND details ? 'snapshot_id';
-- =============================================================================
INSERT INTO public.reports (user_id, bucket, subtype, title, summary, details, source, created_at, updated_at)
SELECT
  b.user_id,
  'projections',
  'snapshot',
  left(coalesce(nullif(btrim(s->>'label'), ''), 'Portfolio snapshot'), 200),
  format('Revenue $%s · Expenses $%s · Cashflow $%s/mo · Occupancy %s%%',
    to_char(coalesce((s->'data'->>'revenue')::numeric, 0), 'FM999,999,990'),
    to_char(coalesce((s->'data'->>'expenses')::numeric, 0), 'FM999,999,990'),
    to_char(coalesce((s->'data'->>'cashflow')::numeric, 0), 'FM999,999,990'),
    coalesce(s->'data'->>'occPct', '0')),
  jsonb_build_object('snapshot', s->'data', 'snapshot_id', s->>'id'),
  'dashboard',
  coalesce((s->>'date')::timestamptz, now()),
  now()
FROM public.bethel_data b
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b.data) = 'array' THEN b.data ELSE '[]'::jsonb END) s
WHERE b.id = 'snapshots'
  AND NOT EXISTS (
    SELECT 1 FROM public.reports r
     WHERE r.user_id = b.user_id AND r.details->>'snapshot_id' = s->>'id'
  );
