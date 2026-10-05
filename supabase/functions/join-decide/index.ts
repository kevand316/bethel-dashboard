// supabase/functions/join-decide/index.ts
// Owner approves or declines a texted join request (plans/sms-reports.md, step 7).
// Approve: they asked and the owner agreed, so they become active at once and are
// texted. Decline: the request is removed quietly. Caller's own account only.

import { admin, callerId, CORS, json } from "../_shared/http.ts";
import { sendSms } from "../_shared/twilio.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);
  const { member_id, decision, role_id } = await req.json().catch(() => ({}));
  if (!member_id || !["approve", "decline"].includes(decision)) return json({ error: "member_id and decision required" }, 400);

  const { data: m } = await admin.from("team_members").select("*").eq("user_id", userId).eq("id", member_id).maybeSingle();
  if (!m || m.status !== "requested") return json({ error: "No such join request" }, 404);

  if (decision === "decline") {
    await admin.from("team_members").delete().eq("user_id", userId).eq("id", member_id);
    return json({ ok: true });
  }
  const update: Record<string, unknown> = { status: "active" };
  if (role_id) {
    const { data: role } = await admin.from("team_roles").select("id").eq("user_id", userId).eq("id", role_id).maybeSingle();
    if (!role) return json({ error: "Unknown role" }, 400);
    update.role_id = role_id;
  }
  await admin.from("team_members").update(update).eq("user_id", userId).eq("id", member_id);
  const { data: org } = await admin.from("org_profiles").select("org_name").eq("user_id", userId).maybeSingle();
  await sendSms(admin, userId, m.phone,
    `You're on ${org?.org_name || "the"}'s HouseBoss team. Text this number anytime to send reports. Text HELP for examples.`);
  return json({ ok: true });
});
