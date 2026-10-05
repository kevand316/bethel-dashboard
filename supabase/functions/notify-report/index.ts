// supabase/functions/notify-report/index.ts
// Dashboard-filed reports: the dashboard calls this after saving a report so the
// same people are texted as for a texted report. Scoped to the caller's account.

import { admin, callerId, CORS, json } from "../_shared/http.ts";
import { notifyReport } from "../_shared/notify.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);

  const { report_id } = await req.json().catch(() => ({}));
  if (!report_id) return json({ error: "report_id required" }, 400);
  const { data: report } = await admin.from("reports").select("*").eq("id", report_id).eq("user_id", userId).maybeSingle();
  if (!report) return json({ error: "Report not found" }, 404);

  // Never notify twice for the same report.
  const { count } = await admin.from("notifications").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("report_id", report_id);
  if ((count ?? 0) > 0) return json({ ok: true, notified: [], already: true });

  const notified = await notifyReport(admin, userId, report);
  return json({ ok: true, notified });
});
