// tests/join.spec.js
//
// Step 7 of plans/sms-reports.md: join codes. Staff text "JOIN <code> <name>",
// the owner approves on the Team tab, and only then can they text in.

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const FN_URL = `${URL_}/functions/v1/sms-inbound`;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const P = { maria: "+15035550151", guesser: "+15035550152" };
let A, B;

async function uidOf(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
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
    { timeout: 60000, intervals: [500, 1000] }).not.toMatch(/^(received)?$/);
  const { data } = await admin.from("sms_messages").select("body").eq("phone", from).eq("direction", "out").gte("created_at", started).order("created_at");
  return (data || []).at(-1)?.body || "";
}
const member = async (uid, phone) => (await admin.from("team_members").select("*").eq("user_id", uid).eq("phone", phone).maybeSingle()).data;

test.describe("@join join codes", () => {
  test.describe.configure({ timeout: 120000 });
  test.beforeAll(async () => {
    A = await uidOf(process.env.TEST_USER_A_EMAIL);
    B = await uidOf(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(async () => {
    for (const uid of [A, B]) {
      await admin.from("team_members").delete().eq("user_id", uid);
      await admin.from("team_roles").delete().eq("user_id", uid);
      await admin.from("org_profiles").delete().eq("user_id", uid);
    }
    await admin.from("sms_messages").delete().like("phone", "+1503555%");
    await admin.from("sms_blocks").delete().like("phone", "+1503555%");
    await admin.from("org_profiles").insert({ user_id: A, org_name: "Alpha Homes", join_code: "ALPHA-1234", join_enabled: true });
    await admin.from("team_roles").insert([
      { user_id: A, name: "Owner", sort_order: 0 }, { user_id: A, name: "House Manager", sort_order: 2 },
    ]);
    await admin.from("org_profiles").insert({ user_id: B, org_name: "Bravo Living", join_code: "BRAVO-9999", join_enabled: false });
  });

  test("JOIN with a valid code creates a request, not access", async ({ request }) => {
    const r = await text(request, P.maria, "join alpha-1234 Maria Lopez");
    expect(r).toMatch(/Thanks Maria, your request to join Alpha Homes was sent/);
    const m = await member(A, P.maria);
    expect(m).toMatchObject({ name: "Maria Lopez", status: "requested" });
    // A requested person still can't text in.
    await text(request, P.maria, "the sink is broken");
    const { count } = await admin.from("sms_conversations").select("id", { count: "exact", head: true }).eq("phone", P.maria);
    expect(count).toBe(0);
  });

  test("JOIN without a name asks for it; bad and disabled codes are refused", async ({ request }) => {
    expect(await text(request, P.maria, "JOIN ALPHA-1234")).toMatch(/followed by your name/);
    expect(await text(request, P.maria, "JOIN ALPHA-0000 Maria")).toMatch(/isn't valid/);
    expect(await text(request, P.maria, "JOIN BRAVO-9999 Maria")).toMatch(/isn't valid/);
    expect(await member(B, P.maria)).toBeNull();
  });

  test("more than 5 JOIN attempts a day are ignored", async ({ request }) => {
    for (let i = 0; i < 6; i++) await text(request, P.guesser, `JOIN ZZZZ-${1000 + i} X`);
    const last = await text(request, P.guesser, "JOIN ALPHA-1234 Guesser");
    expect(last).toBe("");
    expect(await member(A, P.guesser)).toBeNull();
  });

  test("Team tab: turn on a join code, approve a request with a role", async ({ page, request }) => {
    await admin.from("org_profiles").update({ join_code: null, join_enabled: false }).eq("user_id", A);
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Team", exact: true }).click();
    await page.click("#jcOn");
    await expect(page.locator("#jcState")).toContainText(/JOIN ALPHA-\d{4}/, { timeout: 10000 });
    const code = (await page.locator("#jcState b").textContent()).match(/ALPHA-\d{4}/)[0];

    await text(request, P.maria, `JOIN ${code} Maria Lopez`);
    await page.reload();
    await page.getByRole("button", { name: "Team", exact: true }).click();
    const card = page.locator(".jr-card", { hasText: "Maria Lopez" });
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.locator(".jr-role").selectOption({ label: "House Manager" });
    await card.locator(".jr-approve").click();
    await expect(page.locator(".tm-card:not(.jr-card)", { hasText: "Maria Lopez" })).toContainText(/active/i, { timeout: 10000 });
    const m = await member(A, P.maria);
    expect(m.status).toBe("active");
    const { data: roles } = await admin.from("team_roles").select("id, name").eq("user_id", A);
    expect(roles.find((r) => r.id === m.role_id).name).toBe("House Manager");
    const { data: msgs } = await admin.from("sms_messages").select("body").eq("phone", P.maria).eq("direction", "out");
    expect(msgs.map((x) => x.body).join("\n")).toMatch(/You're on Alpha Homes's HouseBoss team/);
  });

  test("@isolation another account can't approve your join request", async ({ request }) => {
    await text(request, P.maria, "JOIN ALPHA-1234 Maria Lopez");
    const m = await member(A, P.maria);
    const c = createClient(URL_, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await c.auth.signInWithPassword({ email: process.env.TEST_USER_B_EMAIL, password: process.env.TEST_USER_B_PASSWORD });
    const res = await c.functions.invoke("join-decide", { body: { member_id: m.id, decision: "approve" } });
    expect(res.error).not.toBeNull();
    expect((await member(A, P.maria)).status).toBe("requested");
  });
});
