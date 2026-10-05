// supabase/functions/google-connect/index.ts
// Intake tab "Allow texted intakes": store (or remove) the owner's Google refresh
// token. The token never goes back to any browser; only the email is shown.

import { admin, callerId, CORS, json } from "../_shared/http.ts";
import { driveEmail, exchangeCode, revoke } from "../_shared/google.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);
  const { action, code } = await req.json().catch(() => ({}));

  if (action === "status") {
    const { data } = await admin.from("google_connections").select("email, created_at").eq("user_id", userId).maybeSingle();
    return json({ connected: !!data, email: data?.email || null, since: data?.created_at || null });
  }

  if (action === "disconnect") {
    const { data } = await admin.from("google_connections").select("refresh_token").eq("user_id", userId).maybeSingle();
    if (data) await revoke(data.refresh_token);
    await admin.from("google_connections").delete().eq("user_id", userId);
    return json({ connected: false });
  }

  if (action === "connect") {
    if (!code) return json({ error: "code required" }, 400);
    let tokens;
    try { tokens = await exchangeCode(code); } catch (e) { return json({ error: `Google refused: ${(e as Error).message}` }, 400); }
    if (!tokens.refresh_token) {
      return json({ error: "Google didn't grant offline access. Remove HouseBoss from your Google account's third-party access, then try again." }, 400);
    }
    const email = await driveEmail(tokens.access_token);
    await admin.from("google_connections").upsert({ user_id: userId, refresh_token: tokens.refresh_token, email, created_at: new Date().toISOString() });
    return json({ connected: true, email });
  }

  return json({ error: "unknown action" }, 400);
});
