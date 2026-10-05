// tests/rent.spec.js
//
// Step 6 of plans/sms-reports.md: Rent tab (monthly checklist from the roster,
// paid in full / partial / remove, editable due, past due, month history) and
// rent by text ("Grant paid his rent", "who owes rent?"). The test account's
// roster is saved first and restored afterwards. Text tests call the real AI.

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const FN_URL = `${URL_}/functions/v1/sms-inbound`;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const P = { manager: "+17025550141", worker: "+17025550142" };
let A, B, original;

const now = new Date();
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const THIS = `${ym(now)}-01`;
const PREV = `${ym(new Date(now.getFullYear(), now.getMonth() - 1, 1))}-01`;
const OLD = `${ym(new Date(now.getFullYear(), now.getMonth() - 6, 1))}-01`;
const MONTH_NAME = now.toLocaleString("en-US", { month: "long" });

const HOMES = (extraBeds = []) => [{
  id: 1, name: "Test House", address: "", startupCost: 0, catOrder: [], expenses: [],
  beds: [
    { id: 1, status: "manager", name: "House Lead", rate: 0, moveIn: "" },
    { id: 2, status: "occupied", name: "Grant Smith", rate: 700, moveIn: "" },
    { id: 3, status: "recup", name: "Marcus Lee", rate: 3200, moveIn: "" },
    { id: 4, status: "vacant", name: "", rate: 650, moveIn: "" },
    ...extraBeds,
  ],
}];

async function uidOf(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}
async function setRoster(homes) {
  await admin.from("bethel_data").update({ data: homes, updated_at: new Date().toISOString(), writer: "test" })
    .eq("user_id", A).eq("id", "homes");
}
async function charges(month = THIS) {
  const { data } = await admin.from("rent_charges").select("*, rent_payments(amount)").eq("user_id", A).eq("month", month).order("resident_name");
  return data || [];
}
async function openRent(page) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
  await expect(page).toHaveURL("/", { timeout: 10000 });
  await page.waitForFunction(() => window.homes?.[0]?.name === "Test House", null, { timeout: 15000 });
  await page.getByRole("button", { name: "Rent", exact: true }).click();
  await expect(page.locator("#view-rent")).toBeVisible();
}
const row = (page, name) => page.locator(".rt-row", { hasText: name });

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

test.describe("@rent rent tracker", () => {
  test.describe.configure({ timeout: 240000 });
  test.beforeAll(async () => {
    A = await uidOf(process.env.TEST_USER_A_EMAIL);
    B = await uidOf(process.env.TEST_USER_B_EMAIL);
    original = (await admin.from("bethel_data").select("data").eq("user_id", A).eq("id", "homes").maybeSingle()).data?.data ?? null;
  });
  test.beforeEach(async () => {
    await admin.from("rent_charges").delete().in("user_id", [A, B]);
    await admin.from("rent_events").delete().in("user_id", [A, B]);
    await admin.from("sms_conversations").delete().eq("user_id", A);
    await admin.from("team_members").delete().eq("user_id", A);
    await admin.from("team_roles").delete().eq("user_id", A);
    await admin.from("org_profiles").delete().eq("user_id", A);
    await admin.from("sms_messages").delete().like("phone", "+1702555%");
    await setRoster(HOMES());
  });
  test.afterAll(async () => {
    await admin.from("rent_charges").delete().in("user_id", [A, B]);
    await admin.from("team_members").delete().eq("user_id", A);
    await admin.from("team_roles").delete().eq("user_id", A);
    await admin.from("org_profiles").delete().eq("user_id", A);
    if (original) await admin.from("bethel_data").update({ data: original, updated_at: new Date().toISOString() }).eq("user_id", A).eq("id", "homes");
  });

  test("the current month's checklist builds itself from the roster", async ({ page }) => {
    await openRent(page);
    await expect(page.locator(".rt-row")).toHaveCount(2, { timeout: 10000 });
    await expect(row(page, "Grant Smith")).toContainText("$700");
    await expect(row(page, "Marcus Lee")).toContainText("$3,200");
    await expect(row(page, "Grant Smith")).toContainText(/unpaid/i);
    const c = await charges();
    expect(c.map((x) => [x.resident_name, Number(x.due)])).toEqual([["Grant Smith", 700], ["Marcus Lee", 3200]]);
  });

  test("paid in full, partial, and removing a payment", async ({ page }) => {
    await openRent(page);
    await row(page, "Grant Smith").locator(".rt-paid-full").click();
    await expect(row(page, "Grant Smith").locator(".rt-status")).toHaveText(/^paid$/i, { timeout: 10000 });

    await row(page, "Marcus Lee").locator(".rt-partial-input").fill("1000");
    await row(page, "Marcus Lee").locator(".rt-partial-add").click();
    await expect(row(page, "Marcus Lee").locator(".rt-status")).toHaveText(/partial/i, { timeout: 10000 });
    await expect(row(page, "Marcus Lee").locator(".rt-balance")).toHaveText("$2,200");
    await expect(page.locator("#rtTotals")).toContainText("$1,700"); // collected

    await row(page, "Marcus Lee").locator(".rt-pay-remove").first().click();
    await expect(row(page, "Marcus Lee").locator(".rt-status")).toHaveText(/unpaid/i, { timeout: 10000 });
    const c = await charges();
    expect(c.find((x) => x.resident_name === "Grant Smith").rent_payments.map((p) => Number(p.amount))).toEqual([700]);
    expect(c.find((x) => x.resident_name === "Marcus Lee").rent_payments).toHaveLength(0);
    const { data: ev } = await admin.from("rent_events").select("action").eq("user_id", A);
    expect(ev.map((e) => e.action).sort()).toEqual(["payment_added", "payment_added", "payment_removed"]);
  });

  test("editing the amount due persists", async ({ page }) => {
    await openRent(page);
    const due = row(page, "Grant Smith").locator(".rt-due-input");
    await due.fill("750");
    await due.press("Enter");
    await expect(row(page, "Grant Smith").locator(".rt-balance")).toHaveText("$750", { timeout: 10000 });
    await page.reload();
    await page.getByRole("button", { name: "Rent", exact: true }).click();
    await expect(row(page, "Grant Smith").locator(".rt-due-input")).toHaveValue("750", { timeout: 10000 });
  });

  test("unpaid balance from last month shows as past due", async ({ page }) => {
    const { data: prev } = await admin.from("rent_charges").insert({
      user_id: A, month: PREV, home_id: 1, home_name: "Test House", bed_id: 2, resident_name: "Grant Smith", due: 700,
    }).select("id").single();
    await admin.from("rent_payments").insert({ user_id: A, charge_id: prev.id, amount: 200 });
    await openRent(page);
    await expect(row(page, "Grant Smith").locator(".rt-pastdue")).toHaveText("$500", { timeout: 10000 });
  });

  test("past months are browsable and frozen; history lists months", async ({ page }) => {
    await admin.from("rent_charges").insert({
      user_id: A, month: PREV, home_id: 1, home_name: "Test House", bed_id: 2, resident_name: "Old Resident", due: 600,
    });
    await openRent(page);
    await expect(page.locator(".rt-row")).toHaveCount(2, { timeout: 10000 });
    await page.click("#rtPrev");
    await expect(page.locator(".rt-row")).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator(".rt-row")).toContainText("Old Resident");
    expect((await charges(PREV)).map((c) => c.resident_name)).toEqual(["Old Resident"]); // not re-synced

    await page.fill("#rtMonth", OLD.slice(0, 7));
    await page.locator("#rtMonth").dispatchEvent("change");
    await expect(page.locator("#rtCreate")).toBeVisible({ timeout: 10000 });

    await page.click("#rtHistoryBtn");
    await expect(page.locator(".rt-hist-row")).toHaveCount(2, { timeout: 10000 });
  });

  test("re-opening the month adds a new move-in and keeps a moved-out resident", async ({ page }) => {
    await openRent(page);
    await expect(page.locator(".rt-row")).toHaveCount(2, { timeout: 10000 });
    const homes = HOMES();
    homes[0].beds[1] = { id: 2, status: "vacant", name: "", rate: 700, moveIn: "" }; // Grant moved out
    homes[0].beds[3] = { id: 4, status: "occupied", name: "New Person", rate: 650, moveIn: "" };
    await setRoster(homes);
    await page.reload();
    await page.getByRole("button", { name: "Rent", exact: true }).click();
    await expect(page.locator(".rt-row")).toHaveCount(3, { timeout: 10000 });
  });

  test("@isolation another account sees none of this", async ({ page }) => {
    await admin.from("rent_charges").insert({ user_id: A, month: THIS, home_id: 1, resident_name: "Secret Tenant", due: 1 });
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Rent", exact: true }).click();
    await expect(page.locator("#view-rent")).not.toContainText("Secret Tenant");
    const n = await page.evaluate(async () => ((await window._supabase.from("rent_charges").select("id").eq("resident_name", "Secret Tenant")).data || []).length);
    expect(n).toBe(0);
  });

  test("rent tab fits a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openRent(page);
    await expect(page.locator(".rt-row")).toHaveCount(2, { timeout: 10000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test.describe("by text", () => {
    test.beforeEach(async () => {
      await admin.from("org_profiles").insert({ user_id: A, org_name: "Alpha Homes" });
      const mgr = (await admin.from("team_roles").insert({ user_id: A, name: "House Manager", can_log_rent: true }).select("id").single()).data.id;
      const cln = (await admin.from("team_roles").insert({ user_id: A, name: "Cleaner", can_log_rent: false }).select("id").single()).data.id;
      for (const [name, phone, role] of [["Dana Manager", P.manager, mgr], ["Cleo Cleaner", P.worker, cln]]) {
        const { data } = await admin.from("team_members").insert({ user_id: A, name, phone, role_id: role, all_homes: true }).select("id").single();
        await admin.from("team_members").update({ status: "active" }).eq("id", data.id);
      }
    });

    test("'Grant paid his rent' records a full payment after YES", async ({ request }) => {
      let r = await text(request, P.manager, `Grant paid his ${MONTH_NAME} rent`);
      expect(r).toMatch(/Grant Smith/);
      expect(r).toMatch(/\$700 paid in full/);
      expect(r).toMatch(/Reply YES/);
      r = await text(request, P.manager, "YES");
      expect(r).toMatch(/Recorded ✓/);
      const c = (await charges()).find((x) => x.resident_name === "Grant Smith");
      expect(c.rent_payments.map((p) => Number(p.amount))).toEqual([700]);
    });

    test("a partial payment reports the remaining balance", async ({ request }) => {
      let r = await text(request, P.manager, `Marcus paid 1000 toward ${MONTH_NAME} rent`);
      expect(r).toMatch(/\$1,000/);
      expect(r).toMatch(/\$2,200 still owed/);
      r = await text(request, P.manager, "yes");
      expect(r).toMatch(/Recorded ✓/);
    });

    test("two residents with the same first name: it asks which", async ({ request }) => {
      await setRoster(HOMES([{ id: 5, status: "occupied", name: "Grant Jones", rate: 650, moveIn: "" }]));
      const r = await text(request, P.manager, `Grant paid his ${MONTH_NAME} rent`);
      expect(r).toMatch(/Grant Smith/);
      expect(r).toMatch(/Grant Jones/);
      expect(r).not.toMatch(/Reply YES/);
    });

    test("'who owes rent' lists unpaid residents", async ({ request }) => {
      const r = await text(request, P.manager, `Who still owes rent for ${MONTH_NAME}?`);
      expect(r).toMatch(/Grant Smith/);
      expect(r).toMatch(/Marcus Lee/);
      expect(r).toMatch(/\$3,900/); // total outstanding
    });

    test("a role without Log rent can't record payments", async ({ request }) => {
      const r = await text(request, P.worker, `Grant paid his ${MONTH_NAME} rent`);
      expect(r).toMatch(/can't log rent/);
    });
  });
});
