// tests/intake-link.spec.js
//
// Step 6b (full) of plans/sms-reports.md: text "intake" -> one-time link -> the
// intake form on a phone, saving straight to the owner's Google Drive.
// Google is faked in the browser (fixtures/fake-drive.js) and the token swap is
// intercepted, so no real Drive is touched; server rules are tested directly.

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { installFakeDrive } = require("./fixtures/fake-drive.js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const SMS_URL = `${URL_}/functions/v1/sms-inbound`;
const LINK_URL = `${URL_}/functions/v1/intake-link`;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PHONE = "+19095550171";
let A;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
async function makeLink(fields = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  await admin.from("intake_links").insert({
    token_hash: sha(token), user_id: A, expires_at: new Date(Date.now() + 3600e3).toISOString(), ...fields,
  });
  return token;
}
function sign(params) {
  return crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN)
    .update(SMS_URL + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
}
async function text(request, body) {
  const sid = "SM" + crypto.randomBytes(16).toString("hex");
  const params = { From: PHONE, To: "+18882677502", Body: body, MessageSid: sid, NumMedia: "0" };
  const started = new Date().toISOString();
  expect((await request.post(SMS_URL, { form: params, headers: { "X-Twilio-Signature": sign(params) } })).status()).toBe(200);
  await expect.poll(async () => (await admin.from("sms_messages").select("status").eq("twilio_sid", sid).maybeSingle()).data?.status,
    { timeout: 60000, intervals: [500, 1000] }).not.toMatch(/^(received)?$/);
  const { data } = await admin.from("sms_messages").select("body").eq("phone", PHONE).eq("direction", "out").gte("created_at", started).order("created_at");
  return (data || []).at(-1)?.body || "";
}

test.describe("@intakelink texted intake links", () => {
  test.describe.configure({ timeout: 120000 });
  test.beforeAll(async () => {
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    A = data.users.find((u) => u.email === process.env.TEST_USER_A_EMAIL).id;
  });
  test.beforeEach(async () => {
    await admin.from("intake_links").delete().eq("user_id", A);
    await admin.from("google_connections").delete().eq("user_id", A);
    await admin.from("team_members").delete().eq("user_id", A);
    await admin.from("team_roles").delete().eq("user_id", A);
    await admin.from("org_profiles").delete().eq("user_id", A);
    await admin.from("sms_messages").delete().eq("phone", PHONE);
  });
  test.afterAll(async () => {
    await admin.from("intake_links").delete().eq("user_id", A);
    await admin.from("google_connections").delete().eq("user_id", A);
    await admin.from("team_members").delete().eq("user_id", A);
    await admin.from("team_roles").delete().eq("user_id", A);
    await admin.from("org_profiles").delete().eq("user_id", A);
  });

  test("bad, expired and used links are refused", async ({ request }) => {
    const post = (token) => request.post(LINK_URL, { data: { token, action: "open" } });
    expect((await post("nope-not-a-real-token-at-all")).status()).toBe(404);
    const old = await makeLink({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await post(old)).status()).toBe(404);
    const used = await makeLink({ used_at: new Date().toISOString() });
    expect((await post(used)).status()).toBe(404);
  });

  test("a link whose Google consent is gone says so and clears it", async ({ request }) => {
    await admin.from("google_connections").insert({ user_id: A, refresh_token: "1//bogus-refresh-token", email: "x@example.org" });
    const token = await makeLink();
    const res = await request.post(LINK_URL, { data: { token, action: "open" } });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe("not_connected");
    const { data } = await admin.from("google_connections").select("user_id").eq("user_id", A);
    expect(data).toHaveLength(0);
  });

  test("texting 'intake for Marcus Lee' sends a one-time link and stores only its hash", async ({ request }) => {
    await admin.from("org_profiles").insert({ user_id: A, org_name: "Alpha Homes" });
    const role = (await admin.from("team_roles").insert({ user_id: A, name: "Intake Staff", can_request_intake: true }).select("id").single()).data.id;
    const { data: m } = await admin.from("team_members").insert({ user_id: A, name: "Ina Intake", phone: PHONE, role_id: role, all_homes: true }).select("id").single();
    await admin.from("team_members").update({ status: "active" }).eq("id", m.id);
    await admin.from("google_connections").insert({ user_id: A, refresh_token: "1//bogus", email: "owner@example.org" });

    const reply = await text(request, "intake for Marcus Lee at Oak St");
    const match = reply.match(/^\[Alpha Homes\] Intake form \(works for 24 hours, one intake\): https:\/\/\S+\/intake-link\.html#([A-Za-z0-9_-]{30,})$/);
    expect(match).not.toBeNull();
    const { data: links } = await admin.from("intake_links").select("*").eq("user_id", A);
    expect(links).toHaveLength(1);
    expect(links[0].token_hash).toBe(sha(match[1]));
    expect(links[0].token_hash).not.toContain(match[1]);
    expect(links[0].prefill).toEqual({ firstName: "Marcus", lastName: "Lee" });
    const hours = (new Date(links[0].expires_at).getTime() - Date.now()) / 3600e3;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  test("the link opens the form on a phone, saves to Drive, and submits once", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const token = await makeLink();
    await page.addInitScript(installFakeDrive);
    let completed = 0;
    await page.route("**/functions/v1/intake-link", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "complete") { completed++; return route.fulfill({ json: { ok: true } }); }
      return route.fulfill({ json: { access_token: "fake-drive-token", expires_in: 3600, org_name: "Alpha Homes",
        homes: ["Oak St House"], prefill: { firstName: "Marcus", lastName: "Lee" } } });
    });
    await page.goto(`/intake-link.html#${token}`);
    await expect(page.locator("#ilOrg")).toHaveText("Alpha Homes · Intake form", { timeout: 15000 });
    await expect(page.locator('[data-intake-field][name="firstName"]')).toHaveValue("Marcus");

    // Exactly one Drive file, even after a reload mid-intake.
    await page.reload();
    await expect(page.locator('[data-intake-field][name="lastName"]')).toHaveValue("Lee", { timeout: 15000 });
    const files = await page.evaluate(() => [...window.__drive.files.values()].filter((f) => f.mimeType === "application/json").length);
    expect(files).toBe(1);

    await page.locator('[data-intake-field][name="lastName"]').fill("Lee-Smith");
    await page.click("#ilSubmit");
    if (await page.locator("#ilSubmitAnyway").isVisible()) await page.click("#ilSubmitAnyway");
    await expect(page.locator("#ilNotice")).toContainText("Submitted ✓", { timeout: 15000 });
    const saved = await page.evaluate(() => {
      const f = [...window.__drive.files.values()].find((x) => x.mimeType === "application/json");
      return JSON.parse(f.content);
    });
    expect(saved.lastName).toBe("Lee-Smith");
    expect(completed).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("an expired link shows how to get a new one", async ({ page }) => {
    await page.goto(`/intake-link.html#expired-token-xxxxxxxxxxxxxxxxxx`);
    await expect(page.locator("#ilNotice")).toContainText("This link has expired", { timeout: 15000 });
  });

  test("Intake tab shows texted intakes as off until Google is allowed", async ({ page }) => {
    await page.addInitScript(installFakeDrive);
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Intake", exact: true }).click();
    await page.locator("#intake-connect-btn").click();
    await expect(page.locator("#tiState")).toContainText("Off", { timeout: 15000 });
    await expect(page.locator("#tiOn")).toBeVisible();
    await admin.from("google_connections").insert({ user_id: A, refresh_token: "1//bogus", email: "owner@example.org" });
    await page.getByRole("button", { name: "Team", exact: true }).click();
    await page.getByRole("button", { name: "Intake", exact: true }).click();
    await expect(page.locator("#tiState")).toContainText("owner@example.org", { timeout: 15000 });
    await expect(page.locator("#tiOff")).toBeVisible();
  });
});
