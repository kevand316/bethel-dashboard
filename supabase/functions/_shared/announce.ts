// supabase/functions/_shared/announce.ts
// Announcements (plans/sms-reports.md, step 4b): resolve an audience to real
// people inside ONE account, send, and log the announcement as a report.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendSms } from "./twilio.ts";

export type Audience = {
  everyone: boolean;
  roles: string[];      // role names
  homes: number[];      // home ids
  people: string[];     // member names (text path) ...
  member_ids?: string[]; // ... or ids (dashboard path)
};

type Member = {
  id: string; name: string; phone: string; status: string; role_id: string;
  all_homes: boolean; home_ids: number[];
};
export type Recipient = { id: string; name: string; phone: string; role: string };

const norm = (s: string) => s.trim().toLowerCase().replace(/s$/, "");

// Everyone matching ANY of the audience parts; active members of this account only.
export async function resolveAudience(
  admin: SupabaseClient, userId: string, a: Audience, excludeMemberId: string | null,
): Promise<Recipient[]> {
  const [{ data: memberRows }, { data: roleRows }] = await Promise.all([
    admin.from("team_members").select("id, name, phone, status, role_id, all_homes, home_ids").eq("user_id", userId),
    admin.from("team_roles").select("id, name").eq("user_id", userId),
  ]);
  const roleName = new Map((roleRows || []).map((r) => [r.id, r.name as string]));
  const wantedRoles = new Set((a.roles || []).map(norm));
  const wantedPeople = (a.people || []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const wantedIds = new Set(a.member_ids || []);

  return ((memberRows || []) as Member[])
    .filter((m) => m.status === "active" && m.id !== excludeMemberId)
    .filter((m) => a.everyone ||
      wantedIds.has(m.id) ||
      wantedRoles.has(norm(roleName.get(m.role_id) || "")) ||
      (a.homes || []).some((h) => m.all_homes || m.home_ids.includes(h)) ||
      wantedPeople.some((p) => m.name.toLowerCase() === p || m.name.toLowerCase().split(" ")[0] === p))
    .map((m) => ({ id: m.id, name: m.name, phone: m.phone, role: roleName.get(m.role_id) || "" }));
}

export function describeRecipients(rs: Recipient[]): string {
  const counts = new Map<string, number>();
  for (const r of rs) counts.set(r.role || "other", (counts.get(r.role || "other") || 0) + 1);
  const parts = [...counts].map(([role, n]) => `${n} ${role}${n === 1 || role.endsWith("s") ? "" : "s"}`);
  return `${rs.length} ${rs.length === 1 ? "person" : "people"} (${parts.join(", ")})`;
}

export async function sendAnnouncement(admin: SupabaseClient, userId: string, opts: {
  message: string; fromName: string; senderMemberId: string | null; senderPhone: string | null;
  recipients: Recipient[]; source: "text" | "dashboard";
}) {
  const { data: org } = await admin.from("org_profiles").select("org_name").eq("user_id", userId).maybeSingle();
  const orgName = org?.org_name || "HouseBoss";
  const { data: report, error } = await admin.from("reports").insert({
    user_id: userId, bucket: "announcements", title: opts.message.slice(0, 80),
    summary: opts.message, source: opts.source,
    sender_member_id: opts.senderMemberId, sender_name: opts.fromName, sender_phone: opts.senderPhone,
    details: { message: opts.message, recipients: opts.recipients.map(({ id, name, role }) => ({ id, name, role })), replies: [] },
  }).select("*").single();
  if (error) throw new Error(`announcement not logged: ${error.message}`);

  const body = `[${orgName}] From ${opts.fromName}: ${opts.message}`;
  for (const r of opts.recipients) {
    const res = await sendSms(admin, userId, r.phone, body);
    await admin.from("notifications").insert({
      user_id: userId, report_id: report.id, member_id: r.id, member_name: r.name, phone: r.phone,
      reason: "announcement", twilio_sid: res.sid, status: res.status, error: res.error ?? null,
    });
  }
  return report;
}

// The most recent announcement this person received in the last 24 hours, if any.
export async function recentAnnouncementFor(admin: SupabaseClient, userId: string, memberId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: n } = await admin.from("notifications").select("report_id, created_at")
    .eq("user_id", userId).eq("member_id", memberId).eq("reason", "announcement").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!n) return null;
  const { data: report } = await admin.from("reports").select("*").eq("user_id", userId).eq("id", n.report_id).maybeSingle();
  return report;
}

export async function relayReply(admin: SupabaseClient, userId: string, announcement: {
  id: string; details: { replies?: unknown[] }; sender_phone: string | null; sender_name: string | null;
}, from: { name: string }, text: string) {
  const { data: org } = await admin.from("org_profiles").select("org_name").eq("user_id", userId).maybeSingle();
  const replies = [...(announcement.details?.replies || []), { from: from.name, text, at: new Date().toISOString() }];
  await admin.from("reports").update({ details: { ...announcement.details, replies }, updated_at: new Date().toISOString() })
    .eq("user_id", userId).eq("id", announcement.id);
  if (announcement.sender_phone) {
    await sendSms(admin, userId, announcement.sender_phone, `[${org?.org_name || "HouseBoss"}] ${from.name} replied: ${text}`);
  }
}
