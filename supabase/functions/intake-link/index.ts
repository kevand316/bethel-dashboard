// supabase/functions/intake-link/index.ts
// The texted intake link page (intake-link.html) trades its one-time token for a
// short-lived Google Drive token here, then saves the intake straight to the
// owner's Drive. No intake answers ever reach this function.
//   {token, action:"open"}     -> {access_token, expires_in, org_name, homes, prefill}
//   {token, action:"complete"} -> marks the link used

import { admin, CORS, json } from "../_shared/http.ts";
import { accessFromRefresh, sha256 } from "../_shared/google.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { token, action } = await req.json().catch(() => ({}));
  if (!token || typeof token !== "string" || token.length < 20) return json({ error: "expired" }, 404);

  const { data: link } = await admin.from("intake_links").select("*").eq("token_hash", await sha256(token)).maybeSingle();
  if (!link || link.used_at || new Date(link.expires_at).getTime() < Date.now()) return json({ error: "expired" }, 404);

  if (action === "complete") {
    await admin.from("intake_links").update({ used_at: new Date().toISOString() }).eq("id", link.id).is("used_at", null);
    return json({ ok: true });
  }
  if (action !== "open") return json({ error: "unknown action" }, 400);

  const { data: conn } = await admin.from("google_connections").select("refresh_token").eq("user_id", link.user_id).maybeSingle();
  if (!conn) return json({ error: "not_connected" }, 409);
  let google;
  try {
    google = await accessFromRefresh(conn.refresh_token);
  } catch (e) {
    // Revoked or expired consent: the owner has to allow texted intakes again.
    if ((e as { code?: string }).code === "invalid_grant") await admin.from("google_connections").delete().eq("user_id", link.user_id);
    return json({ error: "not_connected" }, 409);
  }
  const [{ data: org }, { data: homesRow }] = await Promise.all([
    admin.from("org_profiles").select("org_name").eq("user_id", link.user_id).maybeSingle(),
    admin.from("bethel_data").select("data").eq("user_id", link.user_id).eq("id", "homes").maybeSingle(),
  ]);
  const homes = (Array.isArray(homesRow?.data) ? homesRow!.data : []).map((h: { name: string }) => h.name).filter(Boolean);
  return json({
    access_token: google.access_token,
    expires_in: google.expires_in,
    org_name: org?.org_name || "",
    homes,
    prefill: link.prefill || {},
    expires_at: link.expires_at,
  });
});
