// supabase/functions/platform-admin/index.ts
// Cross-account overview for the platform owner (plans/sms-reports.md, step 8).
// Read-only. Refuses anyone not in platform_admins.

import { admin, callerId, CORS, json } from "../_shared/http.ts";

// Rough per-unit costs for the estimate column. Real bills live in Twilio/Anthropic.
const COST = { sms: 0.011, mms: 0.025, ai: 0.02 };

// deno-lint-ignore no-explicit-any
async function all<T = any>(q: () => any, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await q().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < page) return out;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);
  const { data: isAdmin } = await admin.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (!isAdmin) return json({ error: "Not allowed" }, 403);

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const users: { id: string; email?: string; created_at: string; last_sign_in_at?: string }[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return json({ error: error.message }, 500);
    users.push(...data.users);
    if (data.users.length < 200) break;
  }

  const [orgs, members, reports, texts] = await Promise.all([
    all(() => admin.from("org_profiles").select("user_id, org_name")),
    all(() => admin.from("team_members").select("user_id, status")),
    all(() => admin.from("reports").select("user_id").gte("created_at", monthStart)),
    all(() => admin.from("sms_messages").select("user_id, direction, media_count, status, created_at").gte("created_at", monthStart)),
  ]);

  const acct = new Map<string, {
    active: number; pending: number; reports: number; textsIn: number; textsOut: number; photos: number; aiTurns: number; last: string | null;
  }>();
  const get = (id: string) => {
    if (!acct.has(id)) acct.set(id, { active: 0, pending: 0, reports: 0, textsIn: 0, textsOut: 0, photos: 0, aiTurns: 0, last: null });
    return acct.get(id)!;
  };
  for (const m of members) { const a = get(m.user_id); if (m.status === "active") a.active++; else if (m.status === "pending" || m.status === "requested") a.pending++; }
  for (const r of reports) get(r.user_id).reports++;
  for (const t of texts) {
    if (!t.user_id) continue;
    const a = get(t.user_id);
    if (t.direction === "in") { a.textsIn++; if (t.status === "processed") a.aiTurns++; } else a.textsOut++;
    a.photos += t.media_count || 0;
    if (!a.last || t.created_at > a.last) a.last = t.created_at;
  }
  const orgName = new Map(orgs.map((o) => [o.user_id, o.org_name]));

  const rows = users.map((u) => {
    const a = acct.get(u.id) || { active: 0, pending: 0, reports: 0, textsIn: 0, textsOut: 0, photos: 0, aiTurns: 0, last: null };
    const cost = (a.textsIn + a.textsOut) * COST.sms + a.photos * COST.mms + a.aiTurns * COST.ai;
    return {
      email: u.email || "", org_name: orgName.get(u.id) || "", created_at: u.created_at, last_sign_in_at: u.last_sign_in_at || null,
      ...a, est_cost: Math.round(cost * 100) / 100,
    };
  }).sort((x, y) => y.est_cost - x.est_cost || (y.last || "").localeCompare(x.last || "") || x.email.localeCompare(y.email));

  return json({
    month_start: monthStart,
    rates: COST,
    totals: {
      accounts: rows.length,
      texting_accounts: rows.filter((r) => r.textsIn + r.textsOut > 0).length,
      texts: rows.reduce((s, r) => s + r.textsIn + r.textsOut, 0),
      est_cost: Math.round(rows.reduce((s, r) => s + r.est_cost, 0) * 100) / 100,
    },
    accounts: rows,
  });
});
