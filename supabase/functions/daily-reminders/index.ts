// supabase/functions/daily-reminders/index.ts
// Run by pg_cron every 15 minutes (plans/sms-reports.md, step 4).
//   - At an org's reminder hour (local): anyone whose role requires a daily report
//     and who has filed no Cleanings report today gets a nudge.
//   - At the escalation hour the next morning: if still nothing for yesterday,
//     their supervisor is told.
// reminder_log makes each one go out at most once per person per day.
// Body may carry {"now": ISO} so tests can pick the moment; it still needs the secret.

import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSms } from "../_shared/twilio.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// Local calendar parts of an instant in a timezone.
function localParts(at: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => f.find((x) => x.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

// The UTC instant of local midnight starting `date` (YYYY-MM-DD) in `tz`.
function localMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const asLocal = new Date(guess.toLocaleString("en-US", { timeZone: tz }));
  const asUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (asLocal.getTime() - asUtc.getTime()));
}
const addDays = (date: string, n: number) => {
  const t = new Date(date + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

async function filedDaily(userId: string, memberId: string, from: Date, to: Date) {
  const { count } = await admin.from("reports").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("sender_member_id", memberId).eq("bucket", "cleanings")
    .gte("created_at", from.toISOString()).lt("created_at", to.toISOString());
  return (count ?? 0) > 0;
}

// Claim a reminder slot; false if it was already sent.
async function claim(userId: string, memberId: string, kind: string, forDate: string) {
  const { error } = await admin.from("reminder_log").insert({ user_id: userId, member_id: memberId, kind, for_date: forDate });
  return !error;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return new Response("Forbidden", { status: 403 });
  const body = await req.json().catch(() => ({}));
  const now = body.now ? new Date(body.now) : new Date();
  const only: string | undefined = body.user_id; // tests limit the run to one account

  let q = admin.from("org_profiles").select("user_id, org_name, timezone, reminder_hour, escalation_hour");
  if (only) q = q.eq("user_id", only);
  const { data: orgs } = await q;
  const sent: string[] = [];

  for (const org of orgs || []) {
    const tz = org.timezone || "America/Los_Angeles";
    const { date: today, hour } = localParts(now, tz);
    if (hour !== org.reminder_hour && hour !== org.escalation_hour) continue;

    const [{ data: roles }, { data: members }] = await Promise.all([
      admin.from("team_roles").select("id, daily_report_required").eq("user_id", org.user_id),
      admin.from("team_members").select("id, name, phone, status, role_id, reports_to, all_homes, home_ids").eq("user_id", org.user_id),
    ]);
    const required = new Set((roles || []).filter((r) => r.daily_report_required).map((r) => r.id));
    const byId = new Map((members || []).map((m) => [m.id, m]));

    for (const m of members || []) {
      if (m.status !== "active" || !required.has(m.role_id)) continue;

      if (hour === org.reminder_hour) {
        const filed = await filedDaily(org.user_id, m.id, localMidnight(today, tz), localMidnight(addDays(today, 1), tz));
        if (!filed && await claim(org.user_id, m.id, "nudge", today)) {
          await sendSms(admin, org.user_id, m.phone,
            `[${org.org_name}] Reminder: today's daily report hasn't come in yet. Text it here (what was cleaned and when).`);
          sent.push(`nudge:${m.name}`);
        }
      }
      if (hour === org.escalation_hour) {
        const yesterday = addDays(today, -1);
        const filed = await filedDaily(org.user_id, m.id, localMidnight(yesterday, tz), localMidnight(today, tz));
        const boss = m.reports_to ? byId.get(m.reports_to) : undefined;
        if (!filed && boss?.status === "active" && await claim(org.user_id, m.id, "escalate", yesterday)) {
          await sendSms(admin, org.user_id, boss.phone,
            `[${org.org_name}] ${m.name} didn't send yesterday's daily report.`);
          sent.push(`escalate:${m.name}->${boss.name}`);
        }
      }
    }
  }
  return new Response(JSON.stringify({ ok: true, sent }), { headers: { "Content-Type": "application/json" } });
});
