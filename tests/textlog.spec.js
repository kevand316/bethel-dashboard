// tests/textlog.spec.js
//
// Text Log on the Reports tab: every text in and out of the account's number,
// grouped by person, including replies the carrier never delivered. Rows are
// seeded with a server-side client, as sms-inbound would write them.

// @ts-check
const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Fictional 555-01xx numbers, not used by sms.spec.js.
const MARIA = "+12135550150";
const STRANGER = "+12135550151";
const PHONES = [MARIA, STRANGER];

let A, B;
async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}

async function wipe() {
  await admin.from("sms_messages").delete().in("phone", PHONES);
  await admin.from("team_members").delete().in("phone", PHONES);
  await admin.from("team_roles").delete().eq("name", "Textlog Role");
}

async function log(uid, rows) {
  // Spaced a second apart so the order is unambiguous.
  const base = Date.now() - rows.length * 1000;
  const { error } = await admin.from("sms_messages").insert(rows.map((r, i) => ({
    user_id: uid, phone: MARIA, created_at: new Date(base + i * 1000).toISOString(), ...r,
  })));
  if (error) throw error;
}

async function signedIn(page, email, password) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, email, password);
  await expect(page).toHaveURL("/", { timeout: 10000 });
}

async function openTextLog(page) {
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.locator("#view-rlog")).toBeVisible();
  await page.click("#tlBtn");
  await expect(page.locator("#tlPanel")).toBeVisible();
}

test.describe("@textlog text log", () => {
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(wipe);
  test.afterAll(wipe);

  test("shows each conversation under the person's name, in order, with blocked replies marked", async ({ page }) => {
    const { data: role } = await admin.from("team_roles").insert({ user_id: A, name: "Textlog Role" }).select("id").single();
    await admin.from("team_members").insert({ user_id: A, name: "Maria Lopez", phone: MARIA, role_id: role.id, all_homes: true });
    await log(A, [
      { direction: "in", body: "toilet leaking upstairs at Oak St", status: "processed" },
      { direction: "out", body: "Is water spreading? Reply YES to submit.", status: "undelivered", error: "30032" },
      { direction: "in", body: "YES", status: "processed" },
      { direction: "out", body: "Filed. Thanks Maria.", status: "delivered" },
    ]);
    await admin.from("sms_messages").insert({ user_id: A, phone: STRANGER, direction: "in", body: "hello?", status: "ignored" });

    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openTextLog(page);

    // Test account A also holds texts from sms.spec.js, so find threads by who they're with.
    const maria = page.locator(".tl-thread").filter({ has: page.locator(".tl-who", { hasText: "Maria Lopez" }) });
    await expect(maria).toBeVisible({ timeout: 10000 });
    await expect(maria.locator(".rp-msg")).toHaveText([
      /toilet leaking/, /Is water spreading/, /YES/, /Filed/,
    ]);
    await expect(maria.locator(".rp-msg-out").first()).toContainText("Not delivered");
    await expect(maria.locator(".rp-msg-out").last()).toContainText("Delivered");
    // A number with no name still shows, as a phone number.
    await expect(page.locator(".tl-who", { hasText: "(213) 555-0151" })).toBeVisible();
  });

  test("a new text shows up without refreshing", async ({ page }) => {
    await log(A, [{ direction: "in", body: "first text", status: "processed" }]);
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openTextLog(page);
    await expect(page.locator("#tlPanel")).toContainText("first text", { timeout: 10000 });
    await admin.from("sms_messages").insert({ user_id: A, phone: MARIA, direction: "out", body: "a fresh reply", status: "queued" });
    await expect(page.locator("#tlPanel")).toContainText("a fresh reply", { timeout: 15000 });
  });

  test("@isolation user B never sees user A's texts", async ({ page }) => {
    await log(A, [{ direction: "in", body: "A private text", status: "processed" }]);
    await signedIn(page, process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);
    await openTextLog(page);
    await expect(page.locator("#tlList")).toContainText("No texts yet", { timeout: 10000 });
    await expect(page.locator("#tlPanel")).not.toContainText("A private text");
  });

  test("fits a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await log(A, [{ direction: "in", body: "x".repeat(300), status: "processed" }]);
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openTextLog(page);
    await expect(page.locator(".rp-msg", { hasText: "xxxxxxxx" })).toBeVisible({ timeout: 10000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
