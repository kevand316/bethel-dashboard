// supabase/functions/_shared/notify.ts
// Who hears about a filed report (plans/sms-reports.md, step 4):
//   - normal report: the sender's supervisor + matching notification rules
//   - urgent report: the sender's whole chain of command + matching rules
//   - either way: everyone whose role has "texted about every report" on
// Active members of the same account only; never the sender; each person once.
// Every text sent is recorded in `notifications` against the report.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendSms } from "./twilio.ts";

const BUCKET_LABEL: Record<string, string> = {
  incidents: "incident", maintenance: "maintenance report", cleanings: "cleaning report",
  move_ins_outs: "move-in/out", inventory: "inventory report", projections: "projection",
  announcements: "announcement",
};

type Member = { id: string; name: string; phone: string; status: string; reports_to: string | null; role_id: string };
type Report = {
  id: string; ticket_no: number; bucket: string; urgent: boolean; home_id: number | null; home_name: string | null;
  title: string; sender_member_id: string | null; sender_name: string | null; sender_phone: string | null;
};

export async function notifyReport(admin: SupabaseClient, userId: string, report: Report) {
  const [{ data: memberRows }, { data: rules }, { data: org }, { data: allRoles }] = await Promise.all([
    admin.from("team_members").select("id, name, phone, status, reports_to, role_id").eq("user_id", userId),
    admin.from("notification_rules").select("bucket, home_id, member_id").eq("user_id", userId),
    admin.from("org_profiles").select("org_name").eq("user_id", userId).maybeSingle(),
    admin.from("team_roles").select("id").eq("user_id", userId).eq("notify_all_reports", true),
  ]);
  const members = new Map((memberRows || []).map((m: Member) => [m.id, m]));
  const picked = new Map<string, string>(); // member id -> reason
  const add = (id: string | null | undefined, reason: string) => {
    if (id && !picked.has(id)) picked.set(id, reason);
  };

  const sender = report.sender_member_id ? members.get(report.sender_member_id) : undefined;
  if (sender) {
    if (report.urgent) {
      const seen = new Set<string>([sender.id]);
      let cur = sender.reports_to;
      while (cur && !seen.has(cur)) { seen.add(cur); add(cur, "chain"); cur = members.get(cur)?.reports_to ?? null; }
    } else add(sender.reports_to, "supervisor");
  }
  for (const r of rules || []) {
    if ((r.bucket === null || r.bucket === report.bucket) && (r.home_id === null || r.home_id === report.home_id)) {
      add(r.member_id, "rule");
    }
  }
  const everyReport = new Set((allRoles || []).map((r: { id: string }) => r.id));
  for (const m of members.values()) if (everyReport.has(m.role_id)) add(m.id, "role");

  const orgName = org?.org_name || "HouseBoss";
  const from = report.sender_name ? ` from ${report.sender_name}` : "";
  const where = report.home_name ? ` (${report.home_name})` : "";
  const what = (BUCKET_LABEL[report.bucket] || "report") + (report.ticket_no ? ` #${report.ticket_no}` : "");
  const body = report.urgent
    ? `[${orgName}] URGENT ${what}${from}${where}: ${report.title}`
    : `[${orgName}] New ${what}${from}${where}: ${report.title}`;

  const sent: { name: string; status: string }[] = [];
  for (const [id, reason] of picked) {
    const m = members.get(id);
    if (!m || m.status !== "active") continue;
    if (m.id === sender?.id || (report.sender_phone && m.phone === report.sender_phone)) continue;
    const res = await sendSms(admin, userId, m.phone, body);
    await admin.from("notifications").insert({
      user_id: userId, report_id: report.id, member_id: m.id, member_name: m.name, phone: m.phone,
      reason, twilio_sid: res.sid, status: res.status, error: res.error ?? null,
    });
    sent.push({ name: m.name, status: res.status });
  }
  return sent;
}
