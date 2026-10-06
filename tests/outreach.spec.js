// tests/outreach.spec.js
//
// plans/outreach.md: Outreach tab. Searches are saved lists of organizations with a
// call status and notes per organization. Most tests seed lists with the service
// role, as the outreach-search function would; one runs a real web search.

// @ts-check
const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let A, B;

async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}

async function wipe() {
  await admin.from("outreach_lists").delete().in("user_id", [A, B]);
}

const ORGS = [
  { name: "Harbor Hospital Social Services", category: "Hospital", address: "1 Harbor Way, Long Beach, CA 90802",
    phone: "(562) 555-0100", phone_label: "Discharge planning", contact_name: "Ana Ruiz", contact_title: "Discharge Planner",
    email: "socialwork@harbor.example", website: "https://harbor.example", source_url: "https://harbor.example/social-work",
    why: "Discharges patients who need housing" },
  { name: "County Probation Adult Services", category: "Probation", address: "200 Main St, Long Beach, CA",
    phone: "(562) 555-0111", phone_label: "Main office", contact_name: null, contact_title: null,
    email: null, website: "https://probation.example", source_url: "https://probation.example/contact", why: "Refers people on release" },
];

async function seedList(uid, query = "hospital discharge planners", orgs = ORGS, extra = {}) {
  const { data: list, error } = await admin.from("outreach_lists")
    .insert({ user_id: uid, query, area: "Long Beach, CA", status: "done", summary: "Two places to start.", ...extra })
    .select("*").single();
  if (error) throw error;
  if (orgs.length) {
    const { error: e2 } = await admin.from("outreach_orgs")
      .insert(orgs.map((o, i) => ({ user_id: uid, list_id: list.id, sort: i, ...o })));
    if (e2) throw e2;
  }
  return list;
}

async function openOutreach(page, email, password) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, email, password);
  await expect(page).toHaveURL("/", { timeout: 10000 });
  await page.getByRole("button", { name: "Outreach", exact: true }).click();
  await expect(page.locator("#view-outreach")).toBeVisible();
}
const asA = (page) => openOutreach(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);

test.describe("@outreach outreach tab", () => {
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(wipe);
  test.afterAll(wipe);

  test("a saved list starts closed and opens to every field", async ({ page }) => {
    await seedList(A);
    await asA(page);
    const list = page.locator(".or-list", { hasText: "hospital discharge planners" });
    await expect(list).toContainText("2 organizations", { timeout: 10000 });
    await expect(list.locator(".or-org")).toHaveCount(2);
    await expect(list.locator(".or-org").first()).toBeHidden();
    await list.locator(".or-list-head").click();
    const org = list.locator(".or-org", { hasText: "Harbor Hospital" });
    await expect(org).toBeVisible();
    for (const t of ["1 Harbor Way, Long Beach, CA 90802", "(562) 555-0100", "Discharge planning", "Ana Ruiz",
      "Discharge Planner", "socialwork@harbor.example"]) await expect(org).toContainText(t);
    await expect(org.locator('a[href="tel:5625550100"]')).toHaveCount(1);
    await expect(org.locator('a[href="mailto:socialwork@harbor.example"]')).toHaveCount(1);
    await expect(org.locator('a[href="https://harbor.example/social-work"]')).toHaveCount(1);
    // Missing details say so instead of being blank.
    await expect(list.locator(".or-org", { hasText: "County Probation" })).toContainText("No email found");
  });

  test("notes and call status save and survive a reload", async ({ page }) => {
    const list = await seedList(A);
    await asA(page);
    await page.locator(".or-list-head").click();
    const org = page.locator(".or-org", { hasText: "Harbor Hospital" });
    await org.locator(".or-notes").fill("Spoke to Ana, send flyer Friday");
    await expect(org.locator(".or-save")).toHaveText(/saved ✓/i, { timeout: 10000 });
    await org.locator(".or-status").selectOption("interested");
    await expect(org.locator(".or-save")).toHaveText(/saved ✓/i, { timeout: 10000 });

    const { data } = await admin.from("outreach_orgs").select("notes, call_status").eq("list_id", list.id).eq("sort", 0).single();
    expect(data).toEqual({ notes: "Spoke to Ana, send flyer Friday", call_status: "interested" });

    await page.reload();
    await page.getByRole("button", { name: "Outreach", exact: true }).click();
    await page.locator(".or-list-head").click();
    await expect(page.locator(".or-org", { hasText: "Harbor Hospital" }).locator(".or-notes"))
      .toHaveValue("Spoke to Ana, send flyer Friday", { timeout: 10000 });
    await expect(page.locator(".or-list-head")).toContainText("1 interested");
  });

  test("a note that fails to save says so, then saves when the connection is back", async ({ page }) => {
    const list = await seedList(A);
    await asA(page);
    await page.locator(".or-list-head").click();
    let fail = true;
    await page.route(/rest\/v1\/outreach_orgs/, (r) => (fail && r.request().method() === "PATCH" ? r.abort() : r.continue()));
    const org = page.locator(".or-org", { hasText: "Harbor Hospital" });
    await org.locator(".or-notes").fill("left voicemail");
    await expect(org.locator(".or-save")).toHaveText(/not saved/i, { timeout: 10000 });
    fail = false;
    await expect(org.locator(".or-save")).toHaveText(/saved ✓/i, { timeout: 20000 });
    const { data } = await admin.from("outreach_orgs").select("notes").eq("list_id", list.id).eq("sort", 0).single();
    expect(data.notes).toBe("left voicemail");
  });

  test("deleting a list asks first", async ({ page }) => {
    const list = await seedList(A);
    await asA(page);
    await page.locator(".or-list-head").click();
    await page.locator(".or-delete").click();
    await expect(page.locator(".or-list")).toContainText(/delete this list/i);
    await page.locator(".or-delete-yes").click();
    await expect(page.locator(".or-list")).toHaveCount(0, { timeout: 10000 });
    const { data } = await admin.from("outreach_lists").select("id").eq("id", list.id);
    expect(data).toHaveLength(0);
  });

  test("a guide category fills the search box", async ({ page }) => {
    await asA(page);
    await page.locator(".or-chip", { hasText: "Probation" }).click();
    await expect(page.locator("#orQuery")).toHaveValue(/probation/i);
  });

  test("a list still searching says so; a failed one says what happened", async ({ page }) => {
    await seedList(A, "reentry programs", [], { status: "searching" });
    await seedList(A, "churches", [], { status: "failed", error: "The search didn't finish. Try again." });
    await asA(page);
    await expect(page.locator(".or-list", { hasText: "reentry programs" })).toContainText(/searching/i, { timeout: 10000 });
    await expect(page.locator(".or-list", { hasText: "churches" })).toContainText("The search didn't finish");
  });

  test("the daily limit is explained", async ({ page }) => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ user_id: A, query: `q${i}`, status: "done" }));
    await admin.from("outreach_lists").insert(rows);
    await asA(page);
    await page.fill("#orQuery", "food banks");
    await page.click("#orSend");
    await expect(page.locator("#orMsg")).toContainText(/25 searches a day/i, { timeout: 15000 });
  });

  test("not signed in is refused", async ({ request }) => {
    const res = await request.post(`${URL_}/functions/v1/outreach-search`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY }, data: { query: "x" },
    });
    expect(res.status()).toBe(401);
  });

  test("@isolation user B can't see or change user A's lists", async ({ page }) => {
    const list = await seedList(A, "A private search");
    await openOutreach(page, process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);
    await expect(page.locator("#orLists")).not.toContainText("A private search");
    const r = await page.evaluate(async (id) => {
      const sb = window._supabase;
      const seen = (await sb.from("outreach_orgs").select("id").eq("list_id", id)).data || [];
      await sb.from("outreach_orgs").update({ notes: "B was here" }).eq("list_id", id);
      const ins = await sb.from("outreach_lists").insert({ user_id: (await sb.auth.getUser()).data.user.id, query: "x" });
      return { seen: seen.length, insertError: !!ins.error };
    }, list.id);
    expect(r.seen).toBe(0);
    expect(r.insertError).toBe(true); // only the server creates lists
    const { data } = await admin.from("outreach_orgs").select("notes").eq("list_id", list.id);
    expect(data.every((o) => o.notes === "")).toBe(true);
  });

  test("outreach tab fits a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await seedList(A);
    await asA(page);
    await page.locator(".or-list-head").click();
    await expect(page.locator(".or-org").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("a real search fills a list with organizations and their sources", async ({ page }) => {
    test.setTimeout(400000);
    await asA(page);
    await page.fill("#orArea", "Long Beach, CA");
    await page.fill("#orQuery", "hospital discharge planning or social work departments");
    await page.click("#orSend");
    const list = page.locator(".or-list").first();
    await expect(list).toContainText(/searching/i, { timeout: 15000 });
    await expect(list).toContainText(/\d+ organizations/, { timeout: 360000 });
    const { data: lists } = await admin.from("outreach_lists").select("id, status").eq("user_id", A);
    expect(lists[0].status).toBe("done");
    const { data: orgs } = await admin.from("outreach_orgs").select("*").eq("list_id", lists[0].id);
    expect(orgs.length).toBeGreaterThanOrEqual(3);
    for (const o of orgs) {
      expect(o.name.trim().length).toBeGreaterThan(2);
      expect(o.source_url).toMatch(/^https?:\/\//);
      if (o.phone) expect(o.phone.replace(/\D/g, "").length).toBeGreaterThanOrEqual(10);
      if (o.email) expect(o.email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    }
  });
});
