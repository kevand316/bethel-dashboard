// supabase/functions/_shared/http.ts
// CORS + JSON helpers and the signed-in caller lookup for dashboard-called functions.

import { createClient } from "npm:@supabase/supabase-js@2";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// The account a dashboard request acts for comes only from the caller's own token.
export async function callerId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data: { user } } = await admin.auth.getUser(jwt);
  return user?.id ?? null;
}
