// supabase/functions/ticket-update/index.ts
// Dashboard Resolve / Reopen / Add note on a ticket (plans/tickets.md). Scoped to
// the caller's own account; the shared code texts the reporter when resolved.

import { admin, callerId, CORS, json } from "../_shared/http.ts";
import { type TicketAction, updateTicket } from "../_shared/tickets.ts";

const ACTIONS: TicketAction[] = ["resolved", "pending", "reopened"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);

  const { report_id, action, note } = await req.json().catch(() => ({}));
  if (!report_id || !ACTIONS.includes(action)) return json({ error: "report_id and action required" }, 400);
  const res = await updateTicket(admin, userId, { id: report_id }, action, String(note || "").trim().slice(0, 500),
    { name: null, memberId: null, phone: null, viaText: false });
  return res.ok ? json({ ok: true, report: res.report }) : json({ error: res.message }, 404);
});
