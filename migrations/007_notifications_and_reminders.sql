-- =============================================================================
-- Migration: 007_notifications_and_reminders.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 4
--
--   1. notification_rules: per account, (bucket or any) x (home or any) -> person
--   2. notifications: who was texted about which report, with delivery status
--   3. team_roles.daily_report_required; org reminder/escalation times
--   4. reminder_log: one reminder per person per kind per day
--
-- IDEMPOTENT.
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.notifications, public.notification_rules, public.reminder_log;
--   ALTER TABLE public.team_roles DROP COLUMN IF EXISTS daily_report_required;
--   ALTER TABLE public.org_profiles DROP COLUMN IF EXISTS reminder_hour, DROP COLUMN IF EXISTS escalation_hour;
-- =============================================================================

-- 1. Rules ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  bucket     text CHECK (bucket IS NULL OR bucket IN ('inventory', 'incidents', 'projections',
               'maintenance', 'cleanings', 'move_ins_outs', 'announcements')), -- null = any
  home_id    int,  -- null = any home
  member_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, member_id) REFERENCES public.team_members (user_id, id) ON DELETE CASCADE
);

-- 2. Notifications sent -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  report_id   uuid NOT NULL,
  member_id   uuid,
  member_name text,
  phone       text NOT NULL,
  reason      text, -- 'supervisor' | 'chain' | 'rule'
  twilio_sid  text,
  status      text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, report_id) REFERENCES public.reports (user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS notifications_report_idx ON public.notifications (user_id, report_id);
CREATE INDEX IF NOT EXISTS notifications_sid_idx ON public.notifications (twilio_sid);
CREATE INDEX IF NOT EXISTS sms_messages_sid_idx ON public.sms_messages (twilio_sid);

-- 3. Settings -------------------------------------------------------------------------
ALTER TABLE public.team_roles ADD COLUMN IF NOT EXISTS daily_report_required boolean NOT NULL DEFAULT false;
UPDATE public.team_roles SET daily_report_required = true
 WHERE name = 'House Manager' AND daily_report_required = false
   AND created_at > now() - interval '1 day'; -- only roles seeded since step 1 shipped today
ALTER TABLE public.org_profiles ADD COLUMN IF NOT EXISTS reminder_hour int NOT NULL DEFAULT 21
  CHECK (reminder_hour BETWEEN 0 AND 23);
ALTER TABLE public.org_profiles ADD COLUMN IF NOT EXISTS escalation_hour int NOT NULL DEFAULT 8
  CHECK (escalation_hour BETWEEN 0 AND 23);

-- 4. Reminder log (server only) ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reminder_log (
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  member_id  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('nudge', 'escalate')),
  for_date   date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, member_id, kind, for_date)
);

-- RLS ---------------------------------------------------------------------------------------
ALTER TABLE public.notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_log       ENABLE ROW LEVEL SECURITY; -- no policies: server only

DROP POLICY IF EXISTS "select_own" ON public.notification_rules;
DROP POLICY IF EXISTS "insert_own" ON public.notification_rules;
DROP POLICY IF EXISTS "update_own" ON public.notification_rules;
DROP POLICY IF EXISTS "delete_own" ON public.notification_rules;
CREATE POLICY "select_own" ON public.notification_rules FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "insert_own" ON public.notification_rules FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "update_own" ON public.notification_rules FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "delete_own" ON public.notification_rules FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Owners read who was notified; only the server writes it.
DROP POLICY IF EXISTS "select_own" ON public.notifications;
CREATE POLICY "select_own" ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
