// supabase/functions/team-invite/index.ts
// Sends the "Reply YES to join" text for a person on the caller's Team page.
// Called by the dashboard with the signed-in user's token. The person must belong
// to the caller's account, still be pending, not have blocked this account, and
// not have been invited 3+ times in the last day.

import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSms } from "../_shared/twilio.ts";
import { isPaid, NOT_ON_PLAN } from "../_shared/paid.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Not signed in" }, 401);
  if (!(await isPaid(admin, user.id))) return json({ error: NOT_ON_PLAN }, 403);

  const { member_id } = await req.json().catch(() => ({}));
  if (!member_id) return json({ error: "member_id required" }, 400);

  // Scoped to the caller: another account's person simply isn't found.
  const { data: m } = await admin.from("team_members").select("*").eq("id", member_id).eq("user_id", user.id).maybeSingle();
  if (!m) return json({ error: "Person not found" }, 404);
  if (m.status !== "pending") return json({ error: `They're already ${m.status}.` }, 409);

  const { data: block } = await admin.from("sms_blocks").select("phone").eq("phone", m.phone).eq("user_id", user.id).maybeSingle();
  if (block) return json({ error: "This number has blocked invites from your organization." }, 403);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await admin.from("sms_messages").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).eq("phone", m.phone).eq("direction", "out").like("body", "%Reply YES to join%").gte("created_at", since);
  if ((count ?? 0) >= 3) return json({ error: "Invite already sent 3 times today. Try again tomorrow." }, 429);

  const { data: org } = await admin.from("org_profiles").select("org_name").eq("user_id", user.id).maybeSingle();
  if (!org?.org_name) return json({ error: "Set your organization name first (top of the Team tab)." }, 400);

  // Name the person who invited them, since org names aren't unique.
  const { data: roles } = await admin.from("team_roles").select("id, name").eq("user_id", user.id);
  const ownerRole = (roles || []).find((r) => r.name === "Owner");
  const { data: owner } = ownerRole
    ? await admin.from("team_members").select("name").eq("user_id", user.id).eq("role_id", ownerRole.id).limit(1).maybeSingle()
    : { data: null };
  const role = (roles || []).find((r) => r.id === m.role_id)?.name;
  const inviter = owner?.name ? `${owner.name} at ${org.org_name}` : org.org_name;

  const body = `${inviter} added you to their HouseBoss team${role ? ` as ${role}` : ""}. ` +
    `Reply YES to join or NO to decline. Reply BLOCK to stop invites from ${org.org_name}.`;
  const sent = await sendSms(admin, user.id, m.phone, body);
  if (!sent.ok) return json({ error: `Text not sent: ${sent.error}` }, 502);
  return json({ ok: true });
});
