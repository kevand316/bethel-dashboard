// tests/paid.spec.js
//
// plans/paid-features.md: texting, Outreach and Edit with AI are only for paid
// accounts (rows in paid_accounts).
// The server is the real gate; the hidden buttons are only cosmetic.
// Robot C (TEST_USER_C_*) is the free account.

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const FREE_EMAIL = process.env.TEST_USER_C_EMAIL;
const freePassword = process.env.TEST_USER_C_PASSWORD;
const FREE_PHONE = "+12135550150";
let C;

async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email)?.id;
}

// Robot C is pre-created with no paid_accounts row (credentials in .env.test).
// This keeps it free even if a past run was interrupted.
async function freeUser() {
  const id = await userId(FREE_EMAIL);
  if (!id) throw new Error("Robot C missing: see plans/paid-features.md");
  await admin.from("paid_accounts").delete().eq("user_id", id);
  return id;
}

async function freeToken() {
  const c = createClient(URL_, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: FREE_EMAIL, password: freePassword });
  if (error) throw error;
  return data.session.access_token;
}

async function wipe() {
  await admin.from("reports").delete().eq("user_id", C);
  await admin.from("sms_conversations").delete().eq("user_id", C);
  await admin.from("team_members").delete().eq("user_id", C);
  await admin.from("team_roles").delete().eq("user_id", C);
  await admin.from("org_profiles").delete().eq("user_id", C);
  await admin.from("sms_messages").delete().eq("phone", FREE_PHONE);
  await admin.from("sms_phone_prefs").delete().eq("phone", FREE_PHONE);
}

async function seedTeam() {
  await admin.from("org_profiles").insert({ user_id: C, org_name: "Charlie Free Homes", timezone: "America/Los_Angeles" });
  const { data: role } = await admin.from("team_roles")
    .insert({ user_id: C, name: "House Manager", can_file_reports: true, can_announce: true }).select("id").single();
  const { data: m } = await admin.from("team_members")
    .insert({ user_id: C, name: "Carl Free", phone: FREE_PHONE, role_id: role.id, all_homes: true }).select("id").single();
  return { roleId: role.id, memberId: m.id };
}

const PAID_UI = ["#aiBar", ".header-right .text-number", "#tlBtn", "#anBtn"];
const PAID_TABS = ["Outreach", "Team"];

test.describe("@paid paid-only features", () => {
  test.describe.configure({ mode: "serial", timeout: 120000 });

  test.beforeAll(async () => {
    C = await freeUser();
  });
  test.beforeEach(wipe);
  test.afterAll(wipe);

  test("a free account doesn't see texting, Outreach or Edit with AI", async ({ page }) => {
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, FREE_EMAIL, freePassword);
    await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
    for (const name of PAID_TABS) await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Operations", exact: true }).click();
    for (const sel of PAID_UI) await expect(page.locator(sel)).toBeHidden();
    // Free features are still there.
    for (const name of ["Rent", "Profit Calculator", "Intake", "Reports"])
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  });

  test("a paid account still sees them", async ({ page }) => {
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    for (const name of PAID_TABS) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Operations", exact: true }).click();
    await expect(page.locator("#aiBar")).toBeVisible();
    await expect(page.locator(".header-right .text-number")).toBeVisible();
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await expect(page.locator("#tlBtn")).toBeVisible();
    await expect(page.locator("#anBtn")).toBeVisible();
  });

  test("the server refuses paid features for a free account", async ({ request }) => {
    const { memberId } = await seedTeam();
    const headers = { Authorization: `Bearer ${await freeToken()}`, apikey: process.env.SUPABASE_ANON_KEY };
    const calls = [
      ["ai-edit", { message: "Add water $90 to every home", homes: [] }],
      ["outreach-search", { query: "hospital discharge planners", area: "Long Beach, CA" }],
      ["team-invite", { member_id: memberId }],
      ["announce", { message: "Hello team", audience: { everyone: true } }],
    ];
    for (const [fn, data] of calls) {
      const res = await request.post(`${URL_}/functions/v1/${fn}`, { headers, data });
      expect(res.status(), fn).toBe(403);
      expect((await res.json()).error, fn).toMatch(/plan/i);
    }
    const { count: lists } = await admin.from("outreach_lists").select("id", { count: "exact", head: true }).eq("user_id", C);
    expect(lists).toBe(0);
    const { count: sent } = await admin.from("sms_messages").select("id", { count: "exact", head: true }).eq("phone", FREE_PHONE);
    expect(sent).toBe(0);
  });

  test("texts to a free account's team are ignored: no AI, no report, no reply", async ({ request }) => {
    const { memberId } = await seedTeam();
    await admin.from("team_members").update({ status: "active" }).eq("id", memberId);
    const FN = `${URL_}/functions/v1/sms-inbound`;
    const params = { From: FREE_PHONE, To: "+18882677502", Body: "Toilet is broken at 12 Maple",
      MessageSid: "SM" + crypto.randomBytes(16).toString("hex"), NumMedia: "0" };
    const sig = crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN)
      .update(FN + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
    expect((await request.post(FN, { form: params, headers: { "X-Twilio-Signature": sig } })).status()).toBe(200);
    await expect.poll(async () => (await admin.from("sms_messages").select("status")
      .eq("twilio_sid", params.MessageSid).maybeSingle()).data?.status, { timeout: 30000 }).toBe("ignored");
    const { count: reports } = await admin.from("reports").select("id", { count: "exact", head: true }).eq("user_id", C);
    expect(reports).toBe(0);
    const { count: replies } = await admin.from("sms_messages").select("id", { count: "exact", head: true })
      .eq("phone", FREE_PHONE).eq("direction", "out");
    expect(replies).toBe(0);
  });
});
