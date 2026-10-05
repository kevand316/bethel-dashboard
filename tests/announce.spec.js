// tests/announce.spec.js
//
// Step 4b of plans/sms-reports.md: announcements by text and from the dashboard,
// and replies relayed back to the announcer. Fictional 555-01xx phones only.
// The text-path tests call the real Claude API (a few cents a run).

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const FN_URL = `${URL_}/functions/v1/sms-inbound`;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const P = {
  owner: "+14155550121",
  ops: "+14155550122",
  hm1: "+14155550123",
  hm2: "+14155550124",
  pending: "+14155550125",
  bOnly: "+14155550126",
};
let A, B;
const ids = {};

async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}

async function wipe() {
  for (const uid of [A, B]) {
    await admin.from("reports").delete().eq("user_id", uid);
    await admin.from("sms_conversations").delete().eq("user_id", uid);
    await admin.from("team_members").update({ reports_to: null }).eq("user_id", uid);
    await admin.from("team_members").delete().eq("user_id", uid);
    await admin.from("team_roles").delete().eq("user_id", uid);
    await admin.from("org_profiles").delete().eq("user_id", uid);
  }
  await admin.from("sms_messages").delete().like("phone", "+1415555%");
  await admin.from("sms_phone_prefs").delete().like("phone", "+1415555%");
}

async function seed() {
  await admin.from("org_profiles").insert({ user_id: A, org_name: "Alpha Homes" });
  const role = async (name, extra = {}) => (await admin.from("team_roles").insert({ user_id: A, name, ...extra }).select("id").single()).data.id;
  const owner = await role("Owner", { can_announce: true });
  const ops = await role("Operations Manager", { can_announce: true });
  const hm = await role("House Manager");
  const add = async (key, name, phone, roleId, status = "active", uid = A) => {
    const { data } = await admin.from("team_members").insert({ user_id: uid, name, phone, role_id: roleId, all_homes: true }).select("id").single();
    if (status !== "pending") await admin.from("team_members").update({ status }).eq("id", data.id);
    ids[key] = data.id;
  };
  await add("owner", "Kev Owner", P.owner, owner);
  await add("ops", "Dana Ops", P.ops, ops);
  await add("hm1", "James Manager", P.hm1, hm);
  await add("hm2", "Maria Manager", P.hm2, hm);
  await add("pending", "Pat Pending", P.pending, hm, "pending");
  await admin.from("org_profiles").insert({ user_id: B, org_name: "Bravo Living" });
  const bRole = (await admin.from("team_roles").insert({ user_id: B, name: "House Manager" }).select("id").single()).data.id;
  await add("bOnly", "Bob Bravo", P.bOnly, bRole, "active", B);
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
  await expect.poll(async () => {
    const { data } = await admin.from("sms_messages").select("status").eq("twilio_sid", sid).maybeSingle();
    return data?.status;
  }, { timeout: 90000, intervals: [500, 1000, 2000] }).not.toMatch(/^(received)?$/);
  const { data: out } = await admin.from("sms_messages").select("*").eq("phone", from).eq("direction", "out")
    .gte("created_at", started).order("created_at");
  return (out || []).at(-1)?.body || "";
}
const inbox = async (phone) => ((await admin.from("sms_messages").select("body").eq("phone", phone).eq("direction", "out")).data || []).map((m) => m.body);

async function ownerClient() {
  const c = createClient(URL_, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email: process.env.TEST_USER_A_EMAIL, password: process.env.TEST_USER_A_PASSWORD });
  return c;
}

test.describe("@announce announcements", () => {
  test.describe.configure({ timeout: 240000 });
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(async () => { await wipe(); await seed(); });
  test.afterAll(async () => { await wipe(); });

  test("dashboard: preview counts, then sends to the chosen role only and logs it", async () => {
    const c = await ownerClient();
    const pre = await c.functions.invoke("announce", { body: { preview: true, audience: { roles: ["House Manager"] } } });
    expect(pre.data).toMatchObject({ count: 2 });
    const res = await c.functions.invoke("announce", { body: { message: "Inspection Friday 10am", audience: { roles: ["House Manager"] } } });
    expect(res.data).toMatchObject({ ok: true, count: 2 });
    expect(await inbox(P.hm1)).toEqual(["[Alpha Homes] From Kev Owner: Inspection Friday 10am"]);
    expect(await inbox(P.hm2)).toHaveLength(1);
    expect(await inbox(P.ops)).toHaveLength(0);
    expect(await inbox(P.pending)).toHaveLength(0);
    const { data: r } = await admin.from("reports").select("bucket, summary, details").eq("user_id", A).single();
    expect(r.bucket).toBe("announcements");
    expect(r.details.recipients.map((x) => x.name).sort()).toEqual(["James Manager", "Maria Manager"]);
  });

  test("@isolation an account can only announce to its own people", async () => {
    const c = await ownerClient();
    const res = await c.functions.invoke("announce", { body: { message: "hi", audience: { member_ids: [ids.bOnly] } } });
    expect(res.error).not.toBeNull();
    expect(await inbox(P.bOnly)).toHaveLength(0);
  });

  test("text: an ops manager announces, confirms with YES, and the house managers get it", async ({ request }) => {
    let r = await text(request, P.ops, "Announce to all house managers: Inspection Friday at 10am, please have rooms ready");
    expect(r).toMatch(/Send to 2 people/);
    expect(r).toMatch(/Reply YES/);
    expect(await inbox(P.hm1)).toHaveLength(0); // nothing before YES
    r = await text(request, P.ops, "YES");
    expect(r).toBe("Sent to 2 ✓");
    const got = await inbox(P.hm1);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^\[Alpha Homes\] From Dana Ops: Inspection Friday at 10am/);
  });

  test("text: a role without permission can't announce", async ({ request }) => {
    const r = await text(request, P.hm1, "Announce to everyone: free pizza");
    expect(r).toMatch(/can't send announcements/);
    expect(await inbox(P.hm2)).toHaveLength(0);
  });

  test("a reply to an announcement is relayed to the announcer and logged", async ({ request }) => {
    const c = await ownerClient();
    await c.functions.invoke("announce", { body: { message: "Staff meeting Monday 9am", audience: { everyone: true } } });
    const r = await text(request, P.hm1, "Got it, I'll be there");
    expect(r).toMatch(/Passed along to Kev Owner/);
    expect(await inbox(P.owner)).toContain("[Alpha Homes] James Manager replied: Got it, I'll be there");
    const { data } = await admin.from("reports").select("details").eq("user_id", A).eq("bucket", "announcements").single();
    expect(data.details.replies.map((x) => x.text)).toEqual(["Got it, I'll be there"]);
  });

  test("Reports tab: send an announcement from the dashboard", async ({ page }) => {
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await page.click("#anBtn");
    await page.fill("#anMessage", "Water shut off 2-4pm today");
    await page.check('#anRoles input[value="House Manager"]');
    await expect(page.locator("#anPreview")).toContainText("2 people", { timeout: 10000 });
    await page.click("#anSend");
    await expect(page.locator("#anConfirm")).toContainText(/Send to 2 people/);
    await page.click("#anConfirmYes");
    await expect(page.locator("#anStatus")).toContainText("Sent to 2 ✓", { timeout: 15000 });
    await page.click('.rp-chip[data-bucket="announcements"]');
    await expect(page.locator(".rp-card", { hasText: "Water shut off" })).toBeVisible({ timeout: 10000 });
    expect(await inbox(P.hm2)).toEqual(["[Alpha Homes] From Kev Owner: Water shut off 2-4pm today"]);
  });
});
