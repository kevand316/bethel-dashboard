// tests/team.spec.js
//
// Step 1 of plans/sms-reports.md: Organization profile + Team page.
// Written before the feature. Covers:
//   - organization name saves, and shows under HOUSEBOSS in the header after reload
//   - default roles exist for a new account
//   - adding a person stores the phone as +1XXXXXXXXXX and shows them as Pending
//   - a bad phone number is refused and nothing is stored
//   - the dashboard can never mark someone Active (only their YES by text can)
//   - user B can neither see user A's team nor point at A's people/roles
//   - removing a person deletes the row
//   - the Team tab fits a 375px phone with no sideways scroll

// @ts-check
const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures/users.js");

const A = () => [process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD];
const B = () => [process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD];

// Wipe the signed-in test account's team data so every test starts clean.
async function wipeTeam(page) {
  await page.evaluate(async () => {
    const sb = window._supabase;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session.user.id;
    await sb.from("team_members").delete().eq("user_id", uid);
    await sb.from("team_roles").delete().eq("user_id", uid);
    await sb.from("org_profiles").delete().eq("user_id", uid);
  });
}

async function openTeam(page) {
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await expect(page.locator("#view-team")).toBeVisible();
  // Default roles are created on first open; wait for them.
  await expect(page.locator("#tmRole option")).toHaveCount(3, { timeout: 10000 });
}

async function signedInClean(page, creds) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, ...creds);
  await expect(page).toHaveURL("/", { timeout: 10000 });
  await wipeTeam(page);
  await page.reload();
  await expect(page).toHaveURL("/", { timeout: 10000 });
}

async function dbMembers(page) {
  return page.evaluate(async () => {
    const sb = window._supabase;
    const { data: { session } } = await sb.auth.getSession();
    const { data } = await sb.from("team_members").select("*").eq("user_id", session.user.id);
    return data || [];
  });
}

async function addPerson(page, name, phone, role = "House Manager") {
  await page.fill("#tmName", name);
  await page.fill("#tmPhone", phone);
  await page.selectOption("#tmRole", { label: role });
  await page.click("#tmAdd");
}

test.describe("@team team page", () => {
  // Leave the throwaway account clean even when a test passes.
  test.afterEach(async ({ page }) => {
    if (new URL(page.url() || "about:blank", "http://x").pathname === "/") await wipeTeam(page).catch(() => {});
  });

  test("organization name saves and shows under HOUSEBOSS after reload", async ({ page }) => {
    await signedInClean(page, A());
    await expect(page.locator(".brand-text h1")).toHaveText("HOUSEBOSS");
    await openTeam(page);

    const org = `Playwright Org ${Date.now() % 100000}`;
    await page.fill("#orgNameInput", org);
    await page.click("#orgNameSave");
    await expect(page.locator("#orgNameStatus")).toHaveText(/saved/i, { timeout: 10000 });
    await expect(page.locator("#brandSub")).toHaveText(org);

    await page.reload();
    await expect(page.locator("#brandSub")).toHaveText(org, { timeout: 10000 });
  });

  test("a new account gets Owner, Operations Manager and House Manager roles", async ({ page }) => {
    await signedInClean(page, A());
    await openTeam(page);
    await expect(page.locator("#tmRole option")).toHaveText([
      "Owner",
      "Operations Manager",
      "House Manager",
    ]);
  });

  test("adding a person stores +1 format and shows them as pending", async ({ page }) => {
    await signedInClean(page, A());
    await openTeam(page);
    await addPerson(page, "Test Person", "(555) 201-3344");

    const card = page.locator(".tm-card", { hasText: "Test Person" });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText("(555) 201-3344");
    await expect(card).toContainText(/pending/i);

    const rows = await dbMembers(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe("+15552013344");
    expect(rows[0].status).toBe("pending");
  });

  test("a bad phone number is refused and nothing is stored", async ({ page }) => {
    await signedInClean(page, A());
    await openTeam(page);
    await addPerson(page, "Bad Phone", "12345");
    await expect(page.locator("#tmError")).toContainText(/phone/i);
    expect(await dbMembers(page)).toHaveLength(0);
  });

  test("the dashboard can never mark someone active", async ({ page }) => {
    await signedInClean(page, A());
    await openTeam(page);
    const result = await page.evaluate(async () => {
      const sb = window._supabase;
      const { data: { session } } = await sb.auth.getSession();
      const uid = session.user.id;
      const { data: roles } = await sb.from("team_roles").select("id").eq("user_id", uid).limit(1);
      const { data: ins } = await sb
        .from("team_members")
        .insert({ user_id: uid, name: "Sneaky", phone: "+15552019999", role_id: roles[0].id, status: "active" })
        .select()
        .single();
      await sb.from("team_members").update({ status: "active" }).eq("user_id", uid).eq("id", ins.id);
      const { data: after } = await sb.from("team_members").select("status").eq("user_id", uid).eq("id", ins.id).single();
      return { inserted: ins.status, updated: after.status };
    });
    expect(result).toEqual({ inserted: "pending", updated: "pending" });
  });

  test("@isolation user B cannot see or reference user A's team", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await signedInClean(pageA, A());
    await openTeam(pageA);
    await addPerson(pageA, "A Secret Person", "(555) 201-7777");
    await expect(pageA.locator(".tm-card", { hasText: "A Secret Person" })).toBeVisible({ timeout: 10000 });
    const [aMember] = await dbMembers(pageA);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signedInClean(pageB, B());
    await openTeam(pageB);
    await expect(pageB.locator("#teamList")).not.toContainText("A Secret Person");

    const probe = await pageB.evaluate(async ({ id, roleId }) => {
      const sb = window._supabase;
      const { data: { session } } = await sb.auth.getSession();
      const uid = session.user.id;
      // Direct read of A's row by id: RLS must return nothing.
      const { data: seen } = await sb.from("team_members").select("id").eq("id", id);
      // Pointing at A's role and A's person from B's account must fail.
      const { error } = await sb.from("team_members").insert({
        user_id: uid, name: "Hijack", phone: "+15552018888", role_id: roleId, reports_to: id,
      });
      return { seen: (seen || []).length, insertFailed: !!error };
    }, { id: aMember.id, roleId: aMember.role_id });

    expect(probe).toEqual({ seen: 0, insertFailed: true });
    await ctxA.close();
    await ctxB.close();
  });

  test("removing a person deletes them", async ({ page }) => {
    await signedInClean(page, A());
    await openTeam(page);
    await addPerson(page, "Leaving Soon", "(555) 201-4455");
    const card = page.locator(".tm-card", { hasText: "Leaving Soon" });
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.locator(".tm-remove").click();
    await card.locator(".tm-remove-confirm").click();
    await expect(card).toHaveCount(0, { timeout: 10000 });
    expect(await dbMembers(page)).toHaveLength(0);
  });

  test("team tab fits a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signedInClean(page, A());
    await openTeam(page);
    await addPerson(page, "Phone Width Person", "(555) 201-6677");
    await expect(page.locator(".tm-card", { hasText: "Phone Width Person" })).toBeVisible({ timeout: 10000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
