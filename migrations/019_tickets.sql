-- =============================================================================
-- Migration: 019_tickets.sql
-- Date:      2026-10-06
-- Tickets (plans/tickets.md). Every report gets a per-account number; maintenance,
-- incident and inventory reports are tickets with an Open/Resolved status and a
-- log of updates. The number is assigned here, never by a client, and can't change.
-- IDEMPOTENT.
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS reports_ticket ON public.reports;
--   DROP FUNCTION IF EXISTS public.reports_ticket();
--   ALTER TABLE public.reports DROP COLUMN ticket_no, DROP COLUMN status,
--     DROP COLUMN resolved_at, DROP COLUMN resolved_by, DROP COLUMN updates;
-- =============================================================================
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS ticket_no   int,
  ADD COLUMN IF NOT EXISTS status      text CHECK (status IN ('open', 'resolved')),
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by text,
  ADD COLUMN IF NOT EXISTS updates     jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Number existing reports oldest first, per account; open the existing tickets.
WITH n AS (
  SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at, id) AS no
    FROM public.reports WHERE ticket_no IS NULL
)
UPDATE public.reports r SET ticket_no = n.no + COALESCE(
  (SELECT max(ticket_no) FROM public.reports x WHERE x.user_id = r.user_id), 0)
  FROM n WHERE r.id = n.id;
UPDATE public.reports SET status = 'open'
 WHERE status IS NULL AND bucket IN ('maintenance', 'incidents', 'inventory');

CREATE UNIQUE INDEX IF NOT EXISTS reports_user_ticket_idx ON public.reports (user_id, ticket_no);

CREATE OR REPLACE FUNCTION public.reports_ticket() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- One numbering at a time per account, so two reports never share a number.
    PERFORM pg_advisory_xact_lock(hashtext('reports_ticket:' || NEW.user_id::text));
    SELECT COALESCE(max(ticket_no), 0) + 1 INTO NEW.ticket_no FROM public.reports WHERE user_id = NEW.user_id;
  ELSE
    NEW.ticket_no := OLD.ticket_no;
  END IF;
  -- Becoming a ticket (filed as one, or moved into a ticket bucket) starts it Open.
  IF NEW.status IS NULL AND NEW.bucket IN ('maintenance', 'incidents', 'inventory') THEN
    NEW.status := 'open';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS reports_ticket ON public.reports;
CREATE TRIGGER reports_ticket BEFORE INSERT OR UPDATE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.reports_ticket();
