// supabase/functions/_shared/rent.ts
// Rent by text (plans/sms-reports.md, step 6). The AI only extracts who / how much /
// which month; matching, amounts and recording happen here.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type RentAsk = {
  kind: "payment" | "question";
  resident_name: string | null;
  amount: number | null;
  month: string | null;   // YYYY-MM
  home_id: number | null;
};

export const money = (n: number) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const round = (n: number) => Math.round(Number(n || 0) * 100) / 100;

export function localYmd(tz: string, at = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const g = (t: string) => Number(f.find((x) => x.type === t)!.value);
  return { y: g("year"), m: g("month"), d: g("day") };
}
export const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;
export const shiftMonth = (key: string, n: number) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
};
export const monthName = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
};

// Current month's checklist picks up anyone in a named bed (never deletes rows).
export async function syncCurrentMonth(admin: SupabaseClient, userId: string, month: string) {
  const { data } = await admin.from("bethel_data").select("data").eq("user_id", userId).eq("id", "homes").maybeSingle();
  const rows: Record<string, unknown>[] = [];
  for (const h of (Array.isArray(data?.data) ? data!.data : []) as { id: number; name: string; beds: { id: number; status: string; name: string; rate: number }[] }[]) {
    for (const b of h.beds || []) {
      if ((b.status === "occupied" || b.status === "recup") && String(b.name || "").trim()) {
        rows.push({ user_id: userId, month, home_id: Number(h.id), home_name: h.name || "", bed_id: Number(b.id),
          resident_name: String(b.name).trim(), due: Number(b.rate) || 0 });
      }
    }
  }
  if (rows.length) {
    await admin.from("rent_charges").upsert(rows, { onConflict: "user_id,month,home_id,resident_name", ignoreDuplicates: true });
  }
}

type Charge = { id: string; home_id: number; home_name: string; resident_name: string; due: number; rent_payments: { amount: number }[] };
export const balance = (c: Charge) => round(Math.max(0, Number(c.due) - (c.rent_payments || []).reduce((s, p) => s + Number(p.amount), 0)));

export async function chargesFor(admin: SupabaseClient, userId: string, month: string, homeId: number | null) {
  let q = admin.from("rent_charges").select("id, home_id, home_name, resident_name, due, rent_payments(amount)")
    .eq("user_id", userId).eq("month", month).is("removed_at", null).order("resident_name");
  if (homeId != null) q = q.eq("home_id", homeId);
  const { data } = await q;
  return (data || []) as Charge[];
}

export function matchResident(charges: Charge[], name: string) {
  const n = name.trim().toLowerCase();
  const exact = charges.filter((c) => c.resident_name.toLowerCase() === n);
  if (exact.length) return exact;
  const first = n.split(/\s+/)[0];
  return charges.filter((c) => c.resident_name.toLowerCase().split(/\s+/)[0] === first ||
    c.resident_name.toLowerCase().includes(n));
}

export async function recordPayment(admin: SupabaseClient, userId: string, chargeId: string, amount: number, loggedBy: string) {
  const { error } = await admin.from("rent_payments").insert({
    user_id: userId, charge_id: chargeId, amount: round(amount), logged_by: loggedBy, source: "text",
  });
  if (error) throw new Error(`payment not recorded: ${error.message}`);
  await admin.from("rent_events").insert({ user_id: userId, charge_id: chargeId, action: "payment_added",
    detail: `${money(amount)} by text`, actor: loggedBy });
}
