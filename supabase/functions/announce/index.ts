// supabase/functions/announce/index.ts
// Dashboard "Send announcement" (plans/sms-reports.md, step 4b). Two calls:
//   {preview: true, audience}           -> who it would go to (no texts sent)
//   {message, audience}                 -> send, log as an Announcements report
// The audience is resolved inside the caller's own account only.

import { admin, callerId, CORS, json } from "../_shared/http.ts";
import { describeRecipients, resolveAudience, sendAnnouncement } from "../_shared/announce.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);

  const { message, audience, preview } = await req.json().catch(() => ({}));
  const a = {
    everyone: !!audience?.everyone,
    roles: Array.isArray(audience?.roles) ? audience.roles.map(String) : [],
    homes: Array.isArray(audience?.homes) ? audience.homes.map(Number) : [],
    people: [],
    member_ids: Array.isArray(audience?.member_ids) ? audience.member_ids.map(String) : [],
  };
  const recipients = await resolveAudience(admin, userId, a, null);
  if (preview) return json({ ok: true, count: recipients.length, description: describeRecipients(recipients) });

  const text = String(message || "").trim();
  if (!text) return json({ error: "Type a message first." }, 400);
  if (text.length > 1000) return json({ error: "Keep it under 1,000 characters." }, 400);
  if (!recipients.length) return json({ error: "No one to send to. Only people who replied YES can get texts." }, 400);

  // Sign as the owner if they're on the team, so replies come back to their phone.
  const { data: roles } = await admin.from("team_roles").select("id").eq("user_id", userId).eq("name", "Owner");
  const { data: owner } = roles?.length
    ? await admin.from("team_members").select("id, name, phone, status").eq("user_id", userId)
      .in("role_id", roles.map((r) => r.id)).eq("status", "active").limit(1).maybeSingle()
    : { data: null };
  const { data: org } = await admin.from("org_profiles").select("org_name").eq("user_id", userId).maybeSingle();

  const report = await sendAnnouncement(admin, userId, {
    message: text, fromName: owner?.name || org?.org_name || "the office",
    senderMemberId: owner?.id ?? null, senderPhone: owner?.phone ?? null,
    recipients: recipients.filter((r) => r.id !== owner?.id), source: "dashboard",
  });
  return json({ ok: true, report_id: report.id, count: recipients.filter((r) => r.id !== owner?.id).length });
});
