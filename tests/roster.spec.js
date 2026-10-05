// tests/roster.spec.js
//
// Step 5 of plans/sms-reports.md: move-ins/outs change the bed roster, with
// approval, and never fight an open dashboard tab. The test account's real
// roster is saved first and put back afterwards.

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const FN_URL = `${URL_}/functions/v1/sms-inbound`;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const P = { worker: "+16195550131", approver: "+16195550132" };
let A, original;
const ids = {};

const HOME = (beds) => [{
  id: 1, name: "Test House", address: "1 Test St", startupCost: 0, catOrder: [], expenses: [], beds,
}];
const BEDS = () => [
  { id: 1, status: "occupied", name: "Grant Smith", rate: 700, moveIn: "2026-01-01" },
  { id: 2, status: "vacant", name: "", rate: 650, moveIn: "" },
  { id: 3, status: "vacant", name: "", rate: 650, moveIn: "" },
];

async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}
async function roster() {
  const { data } = await admin.from("bethel_data").select("data").eq("user_id", A).eq("id", "homes").single();
  return data.data[0].beds;
}
async function setRoster(beds) {
  await admin.from("bethel_data").upsert({ id: "homes", user_id: A, data: HOME(beds), updated_at: new Date().toISOString() },
    { onConflict: "id,user_id" });
}
async function pendingReport(change, code = "1234") {
  const { data } = await admin.from("reports").insert({
    user_id: A, bucket: "move_ins_outs", subtype: change.action, title: `${change.action} ${change.resident_name}`,
    source: "text", home_id: 1, home_name: "Test House", sender_member_id: ids.worker, sender_name: "James Worker",
    sender_phone: P.worker, details: { roster: { change: { home_id: 1, rate: null, date: "2026-10-05", bed_number: null, ...change }, status: "pending", code } },
  }).select("*").single();
  return data;
}
async function ownerClient() {
  const c = createClient(URL_, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email: process.env.TEST_USER_A_EMAIL, password: process.env.TEST_USER_A_PASSWORD });
  return c;
}
function sign(params) {
  return crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN)
    .update(FN_URL + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
}
async function text(request, from, body) {
  const sid = "SM" + crypto.randomBytes(16).toString("hex");
  const params = { From: from, To: "+18882677502", Body: body, MessageSid: sid, NumMedia: "0" };
  const started = new Date().toISOString();
  expect((await request.post(FN_URL, { form: params, headers: { "X-Twilio-Signature": sign(params) } })).status()).toBe(200);
  await expect.poll(async () => (await admin.from("sms_messages").select("status").eq("twilio_sid", sid).maybeSingle()).data?.status,
    { timeout: 90000, intervals: [500, 1000, 2000] }).not.toMatch(/^(received)?$/);
  const { data } = await admin.from("sms_messages").select("body").eq("phone", from).eq("direction", "out").gte("created_at", started).order("created_at");
  return (data || []).at(-1)?.body || "";
}

test.describe("@roster move-ins and move-outs", () => {
  test.describe.configure({ timeout: 240000 });
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    original = (await admin.from("bethel_data").select("data").eq("user_id", A).eq("id", "homes").maybeSingle()).data?.data ?? null;
  });
  test.beforeEach(async () => {
    await admin.from("reports").delete().eq("user_id", A);
    await admin.from("sms_conversations").delete().eq("user_id", A);
    await admin.from("team_members").delete().eq("user_id", A);
    await admin.from("team_roles").delete().eq("user_id", A);
    await admin.from("org_profiles").delete().eq("user_id", A);
    await admin.from("sms_messages").delete().like("phone", "+1619555%");
    await admin.from("org_profiles").insert({ user_id: A, org_name: "Alpha Homes" });
    const hm = (await admin.from("team_roles").insert({ user_id: A, name: "House Manager" }).select("id").single()).data.id;
    const om = (await admin.from("team_roles").insert({ user_id: A, name: "Operations Manager", can_approve_roster: true }).select("id").single()).data.id;
    for (const [key, name, phone, role] of [["worker", "James Worker", P.worker, hm], ["approver", "Dana Ops", P.approver, om]]) {
      const { data } = await admin.from("team_members").insert({ user_id: A, name, phone, role_id: role, all_homes: true }).select("id").single();
      await admin.from("team_members").update({ status: "active" }).eq("id", data.id);
      ids[key] = data.id;
    }
    await setRoster(BEDS());
  });
  test.afterAll(async () => {
    await admin.from("reports").delete().eq("user_id", A);
    await admin.from("team_members").delete().eq("user_id", A);
    await admin.from("team_roles").delete().eq("user_id", A);
    await admin.from("org_profiles").delete().eq("user_id", A);
    if (original) await admin.from("bethel_data").update({ data: original, updated_at: new Date().toISOString() }).eq("user_id", A).eq("id", "homes");
  });

  test("approving a move-in fills the first vacant bed, once", async () => {
    const r = await pendingReport({ action: "move_in", resident_name: "Marcus Lee", rate: 650 });
    const c = await ownerClient();
    const res = await c.functions.invoke("roster-apply", { body: { report_id: r.id, decision: "approve" } });
    expect(res.data).toMatchObject({ ok: true });
    const beds = await roster();
    expect(beds[1]).toMatchObject({ status: "occupied", name: "Marcus Lee", rate: 650, moveIn: "2026-10-05" });
    expect(beds[2].status).toBe("vacant");
    const again = await c.functions.invoke("roster-apply", { body: { report_id: r.id, decision: "approve" } });
    expect(again.error).not.toBeNull();
    expect((await roster()).filter((b) => b.name === "Marcus Lee")).toHaveLength(1);
    const { data } = await admin.from("reports").select("details").eq("id", r.id).single();
    expect(data.details.roster.status).toBe("applied");
  });

  test("a move-out frees the resident's bed and keeps its price", async () => {
    const r = await pendingReport({ action: "move_out", resident_name: "Grant" });
    const c = await ownerClient();
    await c.functions.invoke("roster-apply", { body: { report_id: r.id, decision: "approve" } });
    expect((await roster())[0]).toMatchObject({ status: "vacant", name: "", rate: 700, moveIn: "" });
  });

  test("a rejected or impossible change leaves the roster alone", async () => {
    const c = await ownerClient();
    const rej = await pendingReport({ action: "move_in", resident_name: "Nope Person" }, "1111");
    await c.functions.invoke("roster-apply", { body: { report_id: rej.id, decision: "reject" } });
    const bad = await pendingReport({ action: "move_out", resident_name: "Nobody Here" }, "2222");
    await c.functions.invoke("roster-apply", { body: { report_id: bad.id, decision: "approve" } });
    expect(await roster()).toEqual(BEDS());
    const { data } = await admin.from("reports").select("details").in("id", [rej.id, bad.id]);
    expect(data.map((d) => d.details.roster.status).sort()).toEqual(["failed", "rejected"]);
  });

  test("a manager approves by text; a house manager can't", async ({ request }) => {
    await pendingReport({ action: "move_in", resident_name: "Marcus Lee", rate: 650 }, "4821");
    expect(await text(request, P.worker, "APPROVE 4821")).toMatch(/can't approve/);
    expect((await roster())[1].status).toBe("vacant");
    expect(await text(request, P.approver, "approve 4821")).toMatch(/^Done ✓ Marcus Lee moved into Bed 2/);
    const { data } = await admin.from("sms_messages").select("body").eq("phone", P.worker).eq("direction", "out");
    expect(data.map((m) => m.body).join("\n")).toMatch(/Approved by Dana Ops/);
  });

  test("an open dashboard tab can't overwrite a texted move-in", async ({ page }) => {
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.waitForFunction(() => Array.isArray(window.homes) && window.homes[0]?.name === "Test House", null, { timeout: 15000 });

    const r = await pendingReport({ action: "move_in", resident_name: "Marcus Lee", rate: 650 });
    const c = await ownerClient();
    await c.functions.invoke("roster-apply", { body: { report_id: r.id, decision: "approve" } });

    // The stale tab now edits something and tries to save its (old) roster.
    await page.evaluate(() => { window.homes[0].beds[2].name = "Stale edit"; window.persistData(); });
    await expect(page.locator("#conflict-banner")).toBeVisible({ timeout: 15000 });
    expect((await roster())[1].name).toBe("Marcus Lee");
    await page.reload();
    await page.waitForFunction(() => window.homes?.[0]?.beds?.[1]?.name === "Marcus Lee", null, { timeout: 15000 });
  });

  test("Reports tab: a pending move-in shows Apply to roster", async ({ page }) => {
    await pendingReport({ action: "move_in", resident_name: "Marcus Lee", rate: 650 });
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await page.locator(".rp-card", { hasText: "Marcus Lee" }).click();
    await expect(page.locator("#rpDetail")).toContainText(/Pending approval/i);
    await page.locator("#rpDetail .rp-roster-apply").click();
    await expect(page.locator("#rpDetail")).toContainText(/Applied/i, { timeout: 15000 });
    expect((await roster())[1].name).toBe("Marcus Lee");
  });

  test("an approver texting a move-in end to end updates the roster on YES", async ({ request }) => {
    let r = await text(request, P.approver, "New move-in today at Test House: Marcus Lee, $650 a month bed");
    for (const a of ["That's all, it's Marcus Lee, $650, today, any open bed."]) {
      if (/Reply YES/i.test(r)) break;
      r = await text(request, P.approver, a);
    }
    expect(r).toMatch(/Reply YES/i);
    r = await text(request, P.approver, "YES");
    expect(r).toMatch(/Roster updated: Marcus Lee moved into Bed 2 at Test House/);
    expect((await roster())[1]).toMatchObject({ status: "occupied", name: "Marcus Lee", rate: 650 });
  });
});
