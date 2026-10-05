// supabase/functions/roster-apply/index.ts
// Dashboard "Apply to roster" / "Reject" on a pending move-in/out report.
// Only the account owner (the signed-in dashboard user) can call it, for their
// own reports.

import { admin, callerId, CORS, json } from "../_shared/http.ts";
import { decideRoster } from "../_shared/roster.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);
  const { report_id, decision } = await req.json().catch(() => ({}));
  if (!report_id || !["approve", "reject"].includes(decision)) return json({ error: "report_id and decision required" }, 400);
  const { data: owned } = await admin.from("reports").select("id").eq("user_id", userId).eq("id", report_id).maybeSingle();
  if (!owned) return json({ error: "Report not found" }, 404);
  const { data: org } = await admin.from("org_profiles").select("org_name").eq("user_id", userId).maybeSingle();
  const res = await decideRoster(admin, userId, report_id, decision, `${org?.org_name || "the office"} (dashboard)`);
  return json(res, res.ok ? 200 : 409);
});
