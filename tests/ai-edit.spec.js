// tests/ai-edit.spec.js
// Edit with AI box, top of the Operations tab (plans/edit-with-ai.md). The ai-edit function's answer is mocked
// in most tests, so they pin down exactly what the dashboard does with a proposal;
// assertions are on the row stored in Supabase, not on what the page says. One live
// test sends a real request through the deployed function.

const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let A, original;

const HOMES = () => [{
  id: 1, name: "12 Maple Ave.", address: "", startupCost: 5000, catOrder: ["Housing"],
  expenses: [{ cat: "Housing", name: "Rent", amount: 3000 }],
  beds: [
    { id: 1, status: "occupied", name: "Grant Smith", rate: 700, moveIn: "" },
    { id: 2, status: "vacant", name: "", rate: 650, moveIn: "" },
  ],
}];

const C = (o) => ({ type: null, home_id: null, home_name: null, expense_name: null, new_name: null, category: null,
  amount: null, bed_id: null, status: null, resident_name: null, move_in: null, count: null, ...o });

async function stored() {
  const { data } = await admin.from("bethel_data").select("data").eq("user_id", A).eq("id", "homes").single();
  return data.data;
}
async function setRoster(homes) {
  await admin.from("bethel_data").update({ data: homes, updated_at: new Date().toISOString(), writer: "test" })
    .eq("user_id", A).eq("id", "homes");
}
async function mockAi(page, answer) {
  await page.route(/functions\/v1\/ai-edit/, (r) => r.request().method() === "OPTIONS"
    ? r.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } })
    : r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(answer) }));
}
async function openAi(page) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
  await expect(page).toHaveURL("/", { timeout: 10000 });
  await page.waitForFunction(() => window.homes?.[0]?.name === "12 Maple Ave.", null, { timeout: 15000 });
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(page.locator("#aiInput")).toBeVisible();
}
async function ask(page, text) {
  await page.fill("#aiInput", text);
  await page.click("#aiSend");
}
// push() marks the indicator SAVING synchronously and queues the write, so if a step
// pushed nothing, there is no write request and no SAVING to wait for.
function watchWrites(page) {
  const writes = [];
  page.on("request", (r) => { if (/rest\/v1\/bethel_data/.test(r.url()) && r.method() !== "GET") writes.push(r.url()); });
  return writes;
}
async function nothingSaved(page, writes) {
  await expect(page.locator("#save-status")).not.toContainText(/saving/i);
  expect(writes).toHaveLength(0);
  expect(await stored()).toEqual(HOMES());
}
const savedOk = (page) => expect(page.locator("#save-status")).toContainText(/saved/i, { timeout: 15000 });

test.describe("@ai edit with AI", () => {
  test.beforeAll(async () => {
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    A = data.users.find((u) => u.email === process.env.TEST_USER_A_EMAIL).id;
    original = await stored();
  });
  test.afterAll(async () => { await setRoster(original); });
  test.beforeEach(async () => { await setRoster(HOMES()); });

  test("a proposal is previewed and saves nothing until Apply", async ({ page }) => {
    await mockAi(page, { reply: "I'll add water and trash.", changes: [
      C({ type: "add_expense", home_id: 1, expense_name: "Water", category: "Utilities", amount: 90 }),
      C({ type: "add_expense", home_id: 1, expense_name: "Trash", category: "Utilities", amount: 40 }),
    ] });
    await openAi(page);
    const writes = watchWrites(page);
    await ask(page, "add water 90 and trash 40 to maple");
    await expect(page.locator("#aiPreview")).toContainText("add expense Water (Utilities), $90/mo");
    await expect(page.locator("#aiPreview")).toContainText("add expense Trash (Utilities), $40/mo");
    await nothingSaved(page, writes);

    await page.click("#aiApply");
    await savedOk(page);
    const h = (await stored())[0];
    expect(h.expenses.map((e) => [e.name, e.amount])).toEqual([["Rent", 3000], ["Water", 90], ["Trash", 40]]);
    expect(h.catOrder).toEqual(["Housing", "Utilities"]);
  });

  test("Cancel leaves everything as it was", async ({ page }) => {
    await mockAi(page, { reply: "Raise rent.", changes: [C({ type: "update_expense", home_id: 1, expense_name: "Rent", amount: 3500 })] });
    await openAi(page);
    const writes = watchWrites(page);
    await ask(page, "raise rent to 3500");
    await expect(page.locator("#aiPreview")).toContainText("Rent $3,000 → Rent $3,500/mo");
    await page.click("#aiCancel");
    await expect(page.locator("#aiPreview")).toBeHidden();
    await nothingSaved(page, writes);
  });

  test("Undo puts the stored roster back", async ({ page }) => {
    await mockAi(page, { reply: "Moving Joe in.", changes: [
      C({ type: "update_bed", home_id: 1, bed_id: 2, resident_name: "Joe Park", amount: 800 }),
      C({ type: "set_startup_cost", home_id: 1, amount: 6000 }),
    ] });
    await openAi(page);
    await ask(page, "put joe park in bed 2 at 800");
    await expect(page.locator("#aiPreview")).toContainText("bed 2: Occupied, resident Joe Park, $800/mo");
    await page.click("#aiApply");
    await savedOk(page);
    let h = (await stored())[0];
    expect(h.beds[1]).toMatchObject({ status: "occupied", name: "Joe Park", rate: 800 });
    expect(h.startupCost).toBe(6000);

    await page.click("#aiUndo");
    await expect(page.locator("#aiLog")).toContainText("Undone");
    await expect.poll(async () => (await stored())[0].beds[1].status, { timeout: 15000 }).toBe("vacant");
    h = (await stored())[0];
    expect(h).toEqual(HOMES()[0]);
  });

  test("a change naming something that doesn't exist blocks the whole set", async ({ page }) => {
    await mockAi(page, { reply: "Updating.", changes: [
      C({ type: "add_expense", home_id: 1, expense_name: "Water", category: "Utilities", amount: 90 }),
      C({ type: "update_expense", home_id: 1, expense_name: "Gas", amount: 50 }),
    ] });
    await openAi(page);
    const writes = watchWrites(page);
    await ask(page, "add water, gas to 50");
    await expect(page.locator("#aiLog")).toContainText('has no expense called "Gas"');
    await expect(page.locator("#aiApply")).toHaveCount(0);
    await nothingSaved(page, writes);
  });

  test("an occupied bed can't be removed", async ({ page }) => {
    await mockAi(page, { reply: "Removing bed 1.", changes: [C({ type: "remove_bed", home_id: 1, bed_id: 1 })] });
    await openAi(page);
    await ask(page, "remove bed 1");
    await expect(page.locator("#aiLog")).toContainText("has Grant Smith in it");
    await expect(page.locator("#aiApply")).toHaveCount(0);
  });

  test("Apply uses the roster as it is now, not as it was at preview", async ({ page }) => {
    await mockAi(page, { reply: "Adding water.", changes: [
      C({ type: "add_expense", home_id: 1, expense_name: "Water", category: "Utilities", amount: 90 }),
    ] });
    await openAi(page);
    await ask(page, "add water 90");
    await expect(page.locator("#aiApply")).toBeVisible();
    // A typed edit lands between preview and Apply.
    await page.evaluate(() => { window.homes[0].beds[1].name = "Typed Meanwhile"; });
    await page.click("#aiApply");
    await savedOk(page);
    const h = (await stored())[0];
    expect(h.beds[1].name).toBe("Typed Meanwhile");
    expect(h.expenses.map((e) => e.name)).toEqual(["Rent", "Water"]);
  });

  test("the box is only on Operations, Apply shows there at once, and Clear folds it", async ({ page }) => {
    await mockAi(page, { reply: "Adding water.", changes: [C({ type: "add_expense", home_id: 1, expense_name: "Water", category: "Utilities", amount: 90 })] });
    await openAi(page);
    await expect(page.locator("#aiThread")).toBeHidden(); // one line until used
    for (const tab of ["Overview", "Rent", "Profit Calculator", "Intake", "Reports", "Team"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await expect(page.locator("#aiInput")).toBeHidden();
    }
    await expect(page.getByRole("button", { name: "Edit with AI", exact: true })).toHaveCount(0); // not a tab
    await page.getByRole("button", { name: "Operations", exact: true }).click();
    await ask(page, "add water 90");
    await page.click("#aiApply");
    await expect(page.locator("#view-ops input[value='Water']")).toBeVisible(); // the Operations list updated
    await savedOk(page);
    await page.click("#aiClear");
    await expect(page.locator("#aiThread")).toBeHidden();
    expect((await stored())[0].expenses.map((e) => e.name)).toEqual(["Rent", "Water"]); // Clear doesn't undo
  });

  test("the ai-edit function refuses a caller who isn't signed in", async ({ request }) => {
    const r = await request.post(`${URL_}/functions/v1/ai-edit`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY || "", "Content-Type": "application/json" },
      data: { message: "add water", homes: [] },
    });
    expect([401, 403]).toContain(r.status());
  });

  test("Edit with AI fits a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await mockAi(page, { reply: "Adding.", changes: [C({ type: "add_expense", home_id: 1, expense_name: "A really long expense name for a narrow screen", category: "Utilities", amount: 90 })] });
    await openAi(page);
    await ask(page, "add a long one");
    await expect(page.locator("#aiApply")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("@live a real request comes back as a correct preview", async ({ page }) => {
    test.setTimeout(90000);
    await openAi(page);
    await ask(page, "Add a WiFi expense of $85 a month to Maple, and raise the rent there to $3,250.");
    await expect(page.locator("#aiPreview")).toBeVisible({ timeout: 60000 });
    await expect(page.locator("#aiPreview")).toContainText("WiFi");
    await expect(page.locator("#aiPreview")).toContainText("$85");
    await expect(page.locator("#aiPreview")).toContainText("$3,250");
    await page.click("#aiApply");
    await savedOk(page);
    const h = (await stored())[0];
    expect(h.expenses.find((e) => e.name === "Rent").amount).toBe(3250);
    expect(h.expenses.find((e) => /wi-?fi/i.test(e.name)).amount).toBe(85);
  });
});
