// supabase/functions/sms-status/index.ts
// Twilio delivery-status callback: queued → sent → delivered / undelivered / failed.
// Updates the text log and any notification row for that message.

import { createClient } from "npm:@supabase/supabase-js@2";
import { validSignature } from "../_shared/twilio.ts";

const URL_ = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-status`;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = await req.formData();
  const p: Record<string, string> = {};
  for (const [k, v] of form.entries()) p[k] = String(v);
  if (!(await validSignature(URL_, p, req.headers.get("X-Twilio-Signature")))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const sid = p.MessageSid;
  const status = p.MessageStatus || p.SmsStatus;
  if (sid && status) {
    const error = p.ErrorCode ? `Twilio error ${p.ErrorCode}` : null;
    await admin.from("sms_messages").update({ status, ...(error ? { error } : {}) }).eq("twilio_sid", sid);
    await admin.from("notifications").update({ status, ...(error ? { error } : {}) }).eq("twilio_sid", sid);
  }
  return new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });
});
