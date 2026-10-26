// supabase/functions/call-intake/index.ts
// Server side of the phone-intake automation (plans/phone-intake.md).
// Called only by the Google Apps Script "HouseBoss Call Automation", which
// authenticates with the shared secret CALL_INTAKE_SECRET (deploy --no-verify-jwt).
//
//   {action:"open"}    -> {access_token, expires_in, homes}
//        A short-lived drive.file token minted from the owner's "Allow texted
//        intakes" consent, exactly like intake-link. The script saves the intake
//        straight into the HouseBoss Intake Forms folder with it, so the Intake
//        tab lists it. No intake answers ever reach this function.
//   {action:"move_in", client_label, home_name, move_in_date, drive_file_id, ops_manager_name?}
//        Files a Move-ins/outs report (no roster change; the bed is assigned in
//        person) and texts whoever gets move-in reports. daily-reminders texts
//        them again the day before. Receives only first name + last initial.
//   {action:"alert"}   -> texts Owner-role members that a call needs a look.

import { admin, json } from "../_shared/http.ts";
import { accessFromRefresh } from "../_shared/google.ts";
import { notifyReport } from "../_shared/notify.ts";
import { sendSms } from "../_shared/twilio.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function homeList(userId: string): Promise<{ id: number; name: string }[]> {
  const { data } = await admin
    .from("bethel_data")
    .select("data")
    .eq("user_id", userId)
    .eq("id", "homes")
    .maybeSingle();
  return (Array.isArray(data?.data) ? data!.data : [])
    .filter((h: { name?: string }) => h?.name)
    .map((h: { id: number; name: string }) => ({ id: Number(h.id), name: h.name }));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (
    !sameSecret(
      req.headers.get("x-call-intake-secret") || "",
      Deno.env.get("CALL_INTAKE_SECRET") || ""
    )
  ) {
    return json({ error: "Forbidden" }, 403);
  }
  const body = await req.json().catch(() => ({}));
  const userId = String(body.user_id || "");
  const { data: org } = await admin
    .from("org_profiles")
    .select("user_id, org_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (!org) return json({ error: "unknown account" }, 404);

  if (body.action === "open") {
    const { data: conn } = await admin
      .from("google_connections")
      .select("refresh_token")
      .eq("user_id", userId)
      .maybeSingle();
    if (!conn) return json({ error: "not_connected" }, 409);
    let google;
    try {
      google = await accessFromRefresh(conn.refresh_token);
    } catch (e) {
      // Revoked consent: the owner has to click "Allow texted intakes" again.
      if ((e as { code?: string }).code === "invalid_grant") {
        await admin.from("google_connections").delete().eq("user_id", userId);
      }
      return json({ error: "not_connected" }, 409);
    }
    const homes = (await homeList(userId)).map((h) => h.name);
    return json({ access_token: google.access_token, expires_in: google.expires_in, homes });
  }

  if (body.action === "move_in") {
    const label = String(body.client_label || "").trim();
    const date = String(body.move_in_date || "");
    const fileId = String(body.drive_file_id || "");
    if (!label || label.length > 40 || !DATE.test(date) || !fileId || fileId.length > 200) {
      return json({ error: "bad request" }, 400);
    }
    // A retried run sending the same intake again files nothing new.
    const { data: dup } = await admin
      .from("reports")
      .select("id")
      .eq("user_id", userId)
      .eq("bucket", "move_ins_outs")
      .eq("details->call_intake->>drive_file_id", fileId)
      .maybeSingle();
    if (dup) return json({ ok: true, report_id: dup.id, already: true });

    const wanted = norm(String(body.home_name || ""));
    const home = (await homeList(userId)).find((h) => norm(h.name) === wanted);
    const when = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    });
    const ops = String(body.ops_manager_name || "")
      .trim()
      .slice(0, 40);
    const title = `${label} moves in ${when}.${ops ? ` Call ${ops} for details.` : ""}`;

    const { data: report, error } = await admin
      .from("reports")
      .insert({
        user_id: userId,
        bucket: "move_ins_outs",
        subtype: "upcoming_move_in",
        home_id: home?.id ?? null,
        home_name: home?.name ?? null,
        title,
        summary: "From a recorded intake call. The full intake is in the Intake tab.",
        details: {
          call_intake: {
            move_in_date: date,
            drive_file_id: fileId,
            client_label: label,
            reminded_at: null,
          },
        },
        source: "call",
      })
      .select("*")
      .single();
    if (error) return json({ error: error.message }, 500);

    const notified = await notifyReport(admin, userId, report);
    return json({ ok: true, report_id: report.id, notified, home_matched: !!home });
  }

  if (body.action === "alert") {
    const [{ data: roles }, { data: members }] = await Promise.all([
      admin.from("team_roles").select("id").eq("user_id", userId).eq("name", "Owner"),
      admin.from("team_members").select("phone, status, role_id").eq("user_id", userId),
    ]);
    const ownerRoles = new Set((roles || []).map((r: { id: string }) => r.id));
    const text = `[${org.org_name}] A recorded call couldn't be processed automatically. Check the Calls Log sheet.`;
    let sent = 0;
    for (const m of members || []) {
      if (m.status === "active" && ownerRoles.has(m.role_id)) {
        await sendSms(admin, userId, m.phone, text);
        sent++;
      }
    }
    return json({ ok: true, sent });
  }

  return json({ error: "unknown action" }, 400);
});
