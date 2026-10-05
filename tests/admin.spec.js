// tests/admin.spec.js
//
// Step 8 of plans/sms-reports.md: the platform Admin view. Only platform admins
// see the tab and get data; the server refuses everyone else. Test user A is made
// an admin only for the duration of the admin test.

// @ts-check
const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let A, B;

async function uidOf(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}
async function dashboard(page, email, password) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, email, password);
  await expect(page).toHaveURL("/", { timeout: 10000 });
}

test.describe("@admin platform admin view", () => {
  test.beforeAll(async () => {
    A = await uidOf(process.env.TEST_USER_A_EMAIL);
    B = await uidOf(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(async () => {
    await admin.from("platform_admins").delete().in("user_id", [A, B]);
    await admin.from("sms_messages").delete().like("phone", "+1206555%");
  });
  test.afterAll(async () => {
    await admin.from("platform_admins").delete().in("user_id", [A, B]);
    await admin.from("sms_messages").delete().like("phone", "+1206555%");
  });

  test("a normal account sees no Admin tab and the server refuses it", async ({ page }) => {
    await dashboard(page, process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);
    await page.waitForTimeout(3000); // give the admin check time to (not) reveal the tab
    await expect(page.locator("#adminTab")).toBeHidden();
    const status = await page.evaluate(async () => {
      const { error } = await window._supabase.functions.invoke("platform-admin", { body: {} });
      return error?.context?.status ?? 200;
    });
    expect(status).toBe(403);
  });

  test("an admin sees every account with this month's texting", async ({ page }) => {
    await admin.from("platform_admins").insert({ user_id: A });
    await admin.from("sms_messages").insert([
      // Every row lists every column: a bulk insert sends null for a column only some rows have.
      { user_id: B, direction: "in", phone: "+12065550161", body: "x", status: "processed", media_count: 0 },
      { user_id: B, direction: "in", phone: "+12065550161", body: "y", status: "processed", media_count: 1 },
      { user_id: B, direction: "out", phone: "+12065550161", body: "z", status: "test", media_count: 0 },
    ]);
    await dashboard(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page.locator("#adminTab")).toBeVisible({ timeout: 15000 });
    await page.click("#adminTab");
    const row = page.locator(".ad-row", { hasText: process.env.TEST_USER_B_EMAIL });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator(".ad-texts")).toHaveText("2 / 1");
    await expect(row.locator(".ad-cost")).toHaveText("$0.10"); // 3×0.011 + 1×0.025 + 2×0.02 = 0.098
  });
});
