// supabase/functions/_shared/twilio.ts
// Twilio helpers for the HouseBoss texting server: webhook signature check,
// sending (with a no-send path for fictional test numbers), media fetch/delete.
// Every outbound text is logged to sms_messages.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const SID = () => Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TOKEN = () => Deno.env.get("TWILIO_AUTH_TOKEN")!;
export const FROM = () => Deno.env.get("TWILIO_FROM")!;
const basicAuth = () => "Basic " + btoa(`${SID()}:${TOKEN()}`);

// 555-0100 through 555-0199 are reserved as fictional in North America. Texts to
// them are logged but never sent, so tests can drive the whole flow for free.
export function isTestPhone(phone: string): boolean {
  return /^\+1[2-9]\d{2}55501\d{2}$/.test(phone);
}

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export async function validSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TOKEN()),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export type SendResult = { ok: boolean; sid: string | null; status: string; error?: string };

// Twilio posts delivery updates (queued → sent → delivered / failed) here.
const STATUS_URL = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-status`;

export async function sendSms(
  admin: SupabaseClient,
  userId: string | null,
  to: string,
  body: string,
): Promise<SendResult> {
  if (isTestPhone(to)) {
    await admin.from("sms_messages").insert({ user_id: userId, direction: "out", phone: to, body, status: "test" });
    return { ok: true, sid: null, status: "test" };
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID()}/Messages.json`, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: FROM(), Body: body, StatusCallback: STATUS_URL() }),
  });
  const json = await res.json().catch(() => ({}));
  const error = res.ok ? null : (json.message || `HTTP ${res.status}`);
  await admin.from("sms_messages").insert({
    user_id: userId,
    direction: "out",
    phone: to,
    body,
    twilio_sid: json.sid ?? null,
    status: json.status ?? (res.ok ? "sent" : "failed"),
    error,
  });
  const status = json.status ?? (res.ok ? "sent" : "failed");
  return error ? { ok: false, sid: json.sid ?? null, status, error } : { ok: true, sid: json.sid ?? null, status };
}

export async function fetchMedia(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  const res = await fetch(url, { headers: { Authorization: basicAuth() } });
  if (!res.ok) throw new Error(`media fetch failed: HTTP ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") || "application/octet-stream" };
}

// Twilio keeps MMS media until deleted; once it's in our private bucket, remove it.
export async function deleteMedia(url: string): Promise<void> {
  if (!url.startsWith("https://api.twilio.com/")) return;
  await fetch(url.replace(/\.json$/, "") + ".json", { method: "DELETE", headers: { Authorization: basicAuth() } })
    .catch(() => {});
}
