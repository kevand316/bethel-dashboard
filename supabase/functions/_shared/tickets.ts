// supabase/functions/_shared/tickets.ts
// Ticket updates (plans/tickets.md), shared by texts ("#14 resolved new hinge")
// and the dashboard's Resolve / Reopen / Add note buttons (function ticket-update).
//
// Resolving texts the original reporter; resolved by text it also texts every
// "every report" role. Never the person who did it. "Still pending" texts nobody.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendSms } from "./twilio.ts";

export type TicketAction = "resolved" | "pending" | "reopened";

const WHAT: Record<string, string> = {
  cleanings: "a cleaning report", move_ins_outs: "a move-in/out", projections: "a projection",
  announcements: "an announcement",
};

// "#14 resolved ...", "ticket 14 still pending ...", "resolved #14 ...", "14 fixed".
export function parseTicketText(body: string): { no: number; action: TicketAction; note: string } | null {
  const words = "(resolved|resolve|fixed|done|closed|complete|completed|still pending|pending|reopen|reopened)";
  const num = "(?:ticket\\s*)?#?\\s*(\\d{1,6})";
  const a = body.trim().match(new RegExp(`^${num}\\s*[:,.-]?\\s*${words}\\b[\\s:,.-]*([\\s\\S]*)$`, "i"));
  const b = a ? null : body.trim().match(new RegExp(`^${words}\\s*[:,.-]?\\s*${num}\\b[\\s:,.-]*([\\s\\S]*)$`, "i"));
  // Bare "14 done" is too easily something else; a bare number needs # or "ticket".
  if (a && !/^\s*(ticket|#)/i.test(body)) return null;
  const [no, word, note] = a ? [a[1], a[2], a[3]] : b ? [b[2], b[1], b[3]] : [];
  if (!no) return null;
  const w = word.toLowerCase();
  const action: TicketAction = /pending/.test(w) ? "pending" : /reopen/.test(w) ? "reopened" : "resolved";
  return { no: Number(no), action, note: note.trim().slice(0, 500) };
}

type By = { name: string | null; memberId: string | null; phone: string | null; viaText: boolean };

export async function updateTicket(
  admin: SupabaseClient, userId: string, find: { no?: number; id?: string }, action: TicketAction, note: string, by: By,
): Promise<{ ok: boolean; message: string; report?: Record<string, unknown> }> {
  let q = admin.from("reports").select("*").eq("user_id", userId);
  q = find.id ? q.eq("id", find.id) : q.eq("ticket_no", find.no!);
  const { data: r } = await q.maybeSingle();
  if (!r) return { ok: false, message: `No ticket #${find.no ?? ""}.` };
  if (!r.status) return { ok: false, message: `#${r.ticket_no} is ${WHAT[r.bucket] || "a report"}, not a ticket.` };

  const now = new Date().toISOString();
  const entry = { at: now, by: by.name || "Dashboard", action, note };
  const fields: Record<string, unknown> = { updates: [...(r.updates || []), entry], updated_at: now };
  if (action === "resolved") Object.assign(fields, { status: "resolved", resolved_at: now, resolved_by: by.name || "Dashboard" });
  if (action === "reopened") Object.assign(fields, { status: "open", resolved_at: null, resolved_by: null });
  const { data: saved, error } = await admin.from("reports").update(fields)
    .eq("id", r.id).eq("user_id", userId).select("*").single();
  if (error) throw new Error(`ticket update failed: ${error.message}`);

  if (action === "resolved") await tellResolved(admin, userId, saved, note, by);
  const message = action === "resolved" ? `Ticket #${r.ticket_no} marked resolved ✓`
    : action === "reopened" ? `Ticket #${r.ticket_no} reopened ✓`
    : `Noted on ticket #${r.ticket_no}: still pending ✓`;
  return { ok: true, message, report: saved };
}

async function tellResolved(admin: SupabaseClient, userId: string, r: Record<string, any>, note: string, by: By) {
  const [{ data: members }, { data: everyRoles }, { data: org }] = await Promise.all([
    admin.from("team_members").select("id, phone, status, role_id").eq("user_id", userId),
    admin.from("team_roles").select("id").eq("user_id", userId).eq("notify_all_reports", true),
    admin.from("org_profiles").select("org_name").eq("user_id", userId).maybeSingle(),
  ]);
  const active = (members || []).filter((m: any) => m.status === "active");
  const to = new Set<string>();
  const reporter = active.find((m: any) => m.id === r.sender_member_id);
  if (reporter) to.add(reporter.phone);
  if (by.viaText) {
    const every = new Set((everyRoles || []).map((x: any) => x.id));
    for (const m of active) if (every.has(m.role_id)) to.add(m.phone);
  }
  if (by.phone) to.delete(by.phone);
  if (!to.size) return;

  const who = by.viaText && by.name ? ` by ${by.name}` : "";
  const where = r.home_name ? ` (${r.home_name})` : "";
  const body = `[${org?.org_name || "HouseBoss"}] Ticket #${r.ticket_no} resolved${who}${where}: ${r.title}` +
    (note ? `. Note: ${note}` : "");
  for (const phone of to) await sendSms(admin, userId, phone, body);
}
