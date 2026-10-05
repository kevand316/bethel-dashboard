// supabase/functions/_shared/roster.ts
// Move-ins/outs that change the bed roster (plans/sms-reports.md, step 5).
//
// The roster lives in bethel_data (id 'homes'), one JSON blob the dashboard
// autosaves with a conditional UPDATE on updated_at. We write the same way: read,
// change, write only if updated_at is unchanged, retry on a race. Bumping
// updated_at is what makes an open dashboard tab show "changed elsewhere" instead
// of overwriting this change on its next save.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendSms } from "./twilio.ts";

export type RosterChange = {
  action: "move_in" | "move_out";
  home_id: number | null;
  resident_name: string;
  rate: number | null;
  date: string | null;     // YYYY-MM-DD
  bed_number: number | null;
};

type Bed = { id: number; status: string; name: string; rate: number; moveIn: string };
type Home = { id: number; name: string; beds: Bed[] };

const same = (a: string, b: string) => {
  const x = a.trim().toLowerCase(), y = b.trim().toLowerCase();
  return x === y || x.split(/\s+/)[0] === y.split(/\s+/)[0];
};

export async function applyRosterChange(admin: SupabaseClient, userId: string, c: RosterChange):
  Promise<{ ok: boolean; message: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error } = await admin.from("bethel_data").select("data, updated_at")
      .eq("user_id", userId).eq("id", "homes").maybeSingle();
    if (error || !row) return { ok: false, message: "Couldn't read the roster." };
    const homes = structuredClone(row.data) as Home[];
    const home = homes.find((h) => Number(h.id) === Number(c.home_id));
    if (!home) return { ok: false, message: "That home isn't on the roster." };
    let message: string;

    if (c.action === "move_in") {
      const bed = c.bed_number != null
        ? home.beds.find((b) => Number(b.id) === Number(c.bed_number) && b.status === "vacant")
        : home.beds.find((b) => b.status === "vacant");
      if (!bed) {
        return { ok: false, message: c.bed_number != null
          ? `Bed ${c.bed_number} at ${home.name} isn't vacant.` : `No vacant bed at ${home.name}.` };
      }
      const rate = c.rate != null && c.rate > 0 ? c.rate : Number(bed.rate) || 0;
      bed.status = rate >= 3000 ? "recup" : "occupied"; // same rule as the dashboard
      bed.name = c.resident_name.trim();
      bed.rate = rate;
      bed.moveIn = c.date || new Date().toISOString().slice(0, 10);
      message = `${bed.name} moved into Bed ${bed.id} at ${home.name} ($${rate}).`;
    } else {
      const matches = home.beds.filter((b) => (b.status === "occupied" || b.status === "recup") && b.name && same(b.name, c.resident_name));
      if (matches.length === 0) return { ok: false, message: `No one named ${c.resident_name} is in a bed at ${home.name}.` };
      if (matches.length > 1) return { ok: false, message: `More than one ${c.resident_name} at ${home.name}; update the roster on the dashboard.` };
      const bed = matches[0];
      const who = bed.name;
      bed.status = "vacant";
      bed.name = "";
      bed.moveIn = "";
      message = `${who} moved out of Bed ${bed.id} at ${home.name}; the bed is now vacant.`;
    }

    const { data: written } = await admin.from("bethel_data")
      .update({ data: homes, updated_at: new Date().toISOString(), writer: "server:roster" })
      .eq("user_id", userId).eq("id", "homes").eq("updated_at", row.updated_at)
      .select("updated_at");
    if (written?.length) return { ok: true, message };
    // Someone saved in between: read again and re-apply to the newer roster.
  }
  return { ok: false, message: "The roster was busy; please try again." };
}

// Approve (apply) or reject a pending roster change on a report, once.
export async function decideRoster(admin: SupabaseClient, userId: string, reportId: string,
  decision: "approve" | "reject", byName: string): Promise<{ ok: boolean; message: string }> {
  const { data: report } = await admin.from("reports").select("*").eq("user_id", userId).eq("id", reportId).maybeSingle();
  const roster = report?.details?.roster;
  if (!report || !roster) return { ok: false, message: "No roster change on that report." };
  if (roster.status !== "pending") return { ok: false, message: `Already ${roster.status}.` };

  // Claim it first, so two approvers replying at once can't both apply it.
  const now = () => new Date().toISOString();
  const { data: claimed } = await admin.from("reports")
    .update({ details: { ...report.details, roster: { ...roster, status: "processing" } }, updated_at: now() })
    .eq("user_id", userId).eq("id", reportId).eq("details->roster->>status", "pending").select("id");
  if (!claimed?.length) return { ok: false, message: "Someone else already decided this one." };

  let result = { ok: true, message: "Rejected; the roster was not changed." };
  if (decision === "approve") result = await applyRosterChange(admin, userId, roster.change);
  const status = decision === "reject" ? "rejected" : result.ok ? "applied" : "failed";
  await admin.from("reports").update({
    details: { ...report.details, roster: { ...roster, status, result: result.message, decided_by: byName, decided_at: now() } },
    updated_at: now(),
  }).eq("user_id", userId).eq("id", reportId);

  if (report.sender_phone) {
    const { data: org } = await admin.from("org_profiles").select("org_name").eq("user_id", userId).maybeSingle();
    const text = decision === "reject"
      ? `[${org?.org_name || "HouseBoss"}] ${byName} rejected the roster change for ${roster.change.resident_name}.`
      : result.ok ? `[${org?.org_name || "HouseBoss"}] Approved by ${byName}. ${result.message}`
      : `[${org?.org_name || "HouseBoss"}] Approved by ${byName}, but the roster wasn't changed: ${result.message}`;
    await sendSms(admin, userId, report.sender_phone, text);
  }
  return result;
}
