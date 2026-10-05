// tests/reports.spec.js
//
// Step 3 of plans/sms-reports.md: Reports tab (buckets, filters, detail, edit,
// delete, new, live updates) and Profit Calculator "Save to Reports".
// Reports are seeded with a server-side fixture client, as a texted report would be.

// @ts-check
const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let A, B;
async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}

async function seed(uid, rows) {
  const { data, error } = await admin.from("reports").insert(rows.map((r) => ({ user_id: uid, source: "text", ...r }))).select("*");
  if (error) throw error;
  return data;
}

async function openReports(page) {
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.locator("#view-rlog")).toBeVisible();
}

async function signedIn(page, email, password) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, email, password);
  await expect(page).toHaveURL("/", { timeout: 10000 });
}

test.describe("@reports reports tab", () => {
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(async () => {
    await admin.from("reports").delete().in("user_id", [A, B]);
  });
  test.afterAll(async () => {
    await admin.from("reports").delete().in("user_id", [A, B]);
  });

  test("Reports and Snapshots are separate tabs", async ({ page }) => {
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openReports(page);
    await page.getByRole("button", { name: "Snapshots", exact: true }).click();
    await expect(page.locator("#view-reports")).toBeVisible();
    await expect(page.locator("#view-rlog")).toBeHidden();
  });

  test("bucket chips count and filter reports", async ({ page }) => {
    await seed(A, [
      { bucket: "maintenance", title: "Toilet leaking", summary: "Upstairs.", sender_name: "Alice" },
      { bucket: "incidents", subtype: "emergency", urgent: true, title: "Ambulance called", summary: "Fall.", sender_name: "Alice" },
      { bucket: "cleanings", title: "Daily report", summary: "Kitchen 8am.", sender_name: "Bob" },
    ]);
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openReports(page);
    await expect(page.locator(".rp-card")).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator('.rp-chip[data-bucket="maintenance"]')).toContainText("1");
    await expect(page.locator(".rp-card", { hasText: "Ambulance called" })).toContainText(/urgent/i);

    await page.click('.rp-chip[data-bucket="maintenance"]');
    await expect(page.locator(".rp-card")).toHaveCount(1);
    await expect(page.locator(".rp-card")).toContainText("Toilet leaking");

    await page.click('.rp-chip[data-bucket="all"]');
    await page.selectOption("#rpPerson", "Bob");
    await expect(page.locator(".rp-card")).toHaveCount(1);
    await expect(page.locator(".rp-card")).toContainText("Daily report");
  });

  test("opening a report shows its details and conversation; edits persist", async ({ page }) => {
    await seed(A, [{
      bucket: "maintenance", title: "Fridge not cooling", summary: "Kitchen fridge warm.",
      details: { facts: [{ label: "Location", value: "Kitchen" }],
        conversation: [{ from: "staff", text: "fridge is warm" }, { from: "assistant", text: "Which home?" }] },
    }]);
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openReports(page);
    await page.locator(".rp-card", { hasText: "Fridge not cooling" }).click();
    const detail = page.locator("#rpDetail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Kitchen");
    await expect(detail).toContainText("fridge is warm");

    await detail.locator(".rp-edit").click();
    await page.fill("#rpEditTitle", "Fridge replaced");
    await page.click("#rpEditSave");
    await expect(page.locator("#rpEditStatus")).toHaveText(/saved/i, { timeout: 10000 });
    await page.reload();
    await openReports(page);
    await expect(page.locator(".rp-card", { hasText: "Fridge replaced" })).toBeVisible({ timeout: 10000 });
  });

  test("deleting asks first, then removes the report", async ({ page }) => {
    const [r] = await seed(A, [{ bucket: "inventory", title: "Paper towels low", summary: "" }]);
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openReports(page);
    await page.locator(".rp-card", { hasText: "Paper towels low" }).click();
    await page.locator("#rpDetail .rp-delete").click();
    await page.locator("#rpDetail .rp-delete-confirm").click();
    await expect(page.locator(".rp-card", { hasText: "Paper towels low" })).toHaveCount(0, { timeout: 10000 });
    const { data } = await admin.from("reports").select("id").eq("id", r.id);
    expect(data).toHaveLength(0);
  });

  test("a report typed on the dashboard is saved", async ({ page }) => {
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openReports(page);
    await page.click("#rpNewBtn");
    await page.selectOption("#rpNewBucket", "maintenance");
    await page.fill("#rpNewTitle", "Porch light out");
    await page.fill("#rpNewSummary", "Front porch bulb.");
    await page.click("#rpNewSave");
    await expect(page.locator(".rp-card", { hasText: "Porch light out" })).toBeVisible({ timeout: 10000 });
    const { data } = await admin.from("reports").select("source, bucket").eq("user_id", A).eq("title", "Porch light out");
    expect(data).toEqual([{ source: "dashboard", bucket: "maintenance" }]);
  });

  test("a texted report appears without refreshing", async ({ page }) => {
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openReports(page);
    await expect(page.locator("#rpList")).toBeVisible();
    await page.waitForFunction(() => window.reportsLive === true, null, { timeout: 15000 });
    await seed(A, [{ bucket: "incidents", subtype: "conflict", title: "Argument in kitchen", summary: "Resolved." }]);
    await expect(page.locator(".rp-card", { hasText: "Argument in kitchen" })).toBeVisible({ timeout: 15000 });
  });

  test("@isolation user B cannot see user A's reports", async ({ page }) => {
    const [r] = await seed(A, [{ bucket: "incidents", title: "A private incident", summary: "" }]);
    await signedIn(page, process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);
    await openReports(page);
    await expect(page.locator("#rpList")).not.toContainText("A private incident");
    const seen = await page.evaluate(async (id) => {
      const { data } = await window._supabase.from("reports").select("id").eq("id", id);
      return (data || []).length;
    }, r.id);
    expect(seen).toBe(0);
  });

  test("Profit Calculator saves a projection by address, replaces on request, and loads back", async ({ page }) => {
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await page.getByRole("button", { name: "Profit Calculator", exact: true }).click();
    await page.fill("#qc-beds", "10");
    await page.click("#qcSaveReportBtn");
    await page.fill("#qcSaveAddress", "1420 Elm St");
    await page.click("#qcSaveConfirm");
    await expect(page.locator("#qcSaveStatus")).toHaveText(/saved/i, { timeout: 10000 });

    // Same address again: offered Replace / Keep both. Replace leaves one.
    await page.fill("#qc-beds", "12");
    await page.click("#qcSaveReportBtn");
    await page.fill("#qcSaveAddress", "1420 Elm St");
    await page.click("#qcSaveConfirm");
    await page.click("#qcSaveReplace");
    await expect(page.locator("#qcSaveStatus")).toHaveText(/saved/i, { timeout: 10000 });
    const { data } = await admin.from("reports").select("bucket, source, title, details").eq("user_id", A).eq("bucket", "projections");
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ source: "calculator", title: "1420 Elm St" });
    expect(data[0].details.inputs.beds).toBe(12);

    await page.fill("#qc-beds", "3");
    await openReports(page);
    await page.click('.rp-chip[data-bucket="projections"]');
    await page.locator(".rp-card", { hasText: "1420 Elm St" }).click();
    await page.locator("#rpDetail .rp-load-calc").click();
    await expect(page.locator("#view-quickcalc")).toBeVisible();
    await expect(page.locator("#qc-beds")).toHaveValue("12");
  });

  test("reports tab fits a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await seed(A, [{ bucket: "maintenance", title: "A fairly long report title to test wrapping on small screens", summary: "x" }]);
    await signedIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await openReports(page);
    await expect(page.locator(".rp-card")).toHaveCount(1, { timeout: 10000 });
    await page.locator(".rp-card").click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
