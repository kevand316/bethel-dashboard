-- =============================================================================
-- Migration: 008_reminders_cron.sql
-- Date:      2026-10-05
-- Plan:      plans/sms-reports.md, step 4 (daily report reminders)
--
-- Enables pg_cron + pg_net and schedules the daily-reminders Edge Function every
-- 15 minutes. The shared secret is NOT in this file: replace __CRON_SECRET__ with
-- the CRON_SECRET Edge Function secret when applying (it was applied 2026-10-05
-- with the value kept in ~/.houseboss_cron_secret on Kev's laptop).
--
-- ROLLBACK: SELECT cron.unschedule('houseboss-daily-reminders');
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('houseboss-daily-reminders')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'houseboss-daily-reminders');

SELECT cron.schedule(
  'houseboss-daily-reminders',
  '*/15 * * * *',
  $$ SELECT net.http_post(
       url     := 'https://yqgccykbdihsjqlapghr.supabase.co/functions/v1/daily-reminders',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '__CRON_SECRET__'),
       body    := '{}'::jsonb
     ) $$
);
