// supabase/functions/_shared/google.ts
// Google OAuth for texted intakes (plans/sms-reports.md, step 6b). Same OAuth
// client and drive.file scope as the dashboard's Intake tab, plus offline access
// so a texted link can save to the owner's Drive without them being signed in.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const id = () => Deno.env.get("GOOGLE_CLIENT_ID")!;
const secret = () => Deno.env.get("GOOGLE_CLIENT_SECRET")!;

async function tokenCall(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id(), client_secret: secret(), ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error_description || body.error || `Google ${res.status}`), { code: body.error });
  return body as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
}

// Code from the dashboard's Google popup (GIS code client, redirect "postmessage").
export const exchangeCode = (code: string) =>
  tokenCall({ code, grant_type: "authorization_code", redirect_uri: "postmessage" });

export const accessFromRefresh = (refreshToken: string) =>
  tokenCall({ refresh_token: refreshToken, grant_type: "refresh_token" });

export async function revoke(token: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

export async function driveEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  return body?.user?.emailAddress || "";
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
