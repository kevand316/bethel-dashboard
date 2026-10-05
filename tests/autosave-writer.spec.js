// tests/autosave-writer.spec.js
//
// Closes progress.md "Known limitations: overwrite window after a page-hide
// flush" (migration 009, bethel_data.writer). Another writer (a second device, or
// a texted move-in applied by the server) must never be silently overwritten by:
//   - a page-hide keepalive,
//   - a write made after a reload,
//   - the conflict banner's RELOAD.
// And this tab's own keepalive must not be mistaken for someone else's.

// @ts-check
const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
let A, original;

const HOMES = (name) => [{
  id: 1, name, address: "", startupCost: 0, catOrder: [], expenses: [],
  beds: [{ id: 1, status: "vacant", name: "", rate: 650, moveIn: "" }],
}];

async function serverName() {
  const { data } = await admin.from("bethel_data").select("data").eq("user_id", A).eq("id", "homes").single();
  return data.data[0].name;
}
async function otherDeviceWrites(name) {
  await admin.from("bethel_data").update({ data: HOMES(name), updated_at: new Date().toISOString(), writer: "other-device" })
    .eq("user_id", A).eq("id", "homes");
}
async function openDashboard(page) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
  await expect(page).toHaveURL("/", { timeout: 10000 });
  await page.waitForFunction(() => window.homes?.[0]?.name === "Start", null, { timeout: 15000 });
}
// Edit in the tab without waiting for the debounced save.
const editInTab = (page, name) => page.evaluate((n) => { window.homes[0].name = n; window.persistData(); }, name);

test.describe("@autosave writer-aware conflict detection", () => {
  test.beforeAll(async () => {
    const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 200 });
    A = users.find((u) => u.email === process.env.TEST_USER_A_EMAIL).id;
    original = (await admin.from("bethel_data").select("data").eq("user_id", A).eq("id", "homes").maybeSingle()).data?.data ?? null;
  });
  test.beforeEach(async () => {
    await admin.from("bethel_data").update({ data: HOMES("Start"), updated_at: new Date().toISOString(), writer: "setup" })
      .eq("user_id", A).eq("id", "homes");
  });
  test.afterAll(async () => {
    if (original) await admin.from("bethel_data").update({ data: original, updated_at: new Date().toISOString() }).eq("user_id", A).eq("id", "homes");
  });

  test("a page-hide keepalive does not overwrite another device's newer save", async ({ page }) => {
    await openDashboard(page);
    await otherDeviceWrites("Other device");
    await editInTab(page, "Stale tab");
    await page.evaluate(() => window.autosave.flush()); // fires before the debounce
    await expect.poll(serverName, { timeout: 5000 }).toBe("Other device");
    await page.waitForTimeout(1500); // let a keepalive land if it was going to
    expect(await serverName()).toBe("Other device");
  });

  test("this tab's own keepalive is recognised, not reported as a conflict", async ({ page }) => {
    await openDashboard(page);
    await editInTab(page, "First");
    await page.evaluate(() => window.autosave.flush());
    await expect.poll(serverName, { timeout: 10000 }).toBe("First");
    await editInTab(page, "Second");
    await expect(page.locator("#save-status")).toHaveText(/SAVED ✓/, { timeout: 20000 });
    await expect(page.locator("#conflict-banner")).toBeHidden();
    expect(await serverName()).toBe("Second");
  });

  test("RELOAD on the conflict banner keeps the other device's version", async ({ page }) => {
    await openDashboard(page);
    await otherDeviceWrites("Other device");
    await editInTab(page, "Stale tab");
    await expect(page.locator("#conflict-banner")).toBeVisible({ timeout: 15000 });
    await page.locator("#conflict-banner .conflict-banner-btn.primary").click();
    await page.waitForFunction(() => window.homes?.[0]?.name === "Other device", null, { timeout: 15000 });
    await page.waitForTimeout(1500);
    expect(await serverName()).toBe("Other device");
  });

  test("an edit queued before a reload is still saved when no one else wrote", async ({ page }) => {
    await openDashboard(page);
    await page.route("**/rest/v1/bethel_data**", (r) => r.request().method() === "GET" ? r.continue() : r.abort());
    await editInTab(page, "Offline edit");
    await page.unroute("**/rest/v1/bethel_data**");
    await page.reload();
    await expect.poll(serverName, { timeout: 20000 }).toBe("Offline edit");
  });
});
