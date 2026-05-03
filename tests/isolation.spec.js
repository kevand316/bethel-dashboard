// tests/isolation.spec.js
//
// TDD: these tests are written BEFORE the feature exists. They must fail.
// The expected failure reason is: no auth gate exists yet — the dashboard
// renders for anyone without redirecting to login.html.
//
// Each test will pass once:
//   - login.html exists
//   - lib/auth.js redirects unauthenticated users
//   - migration 001 is applied (RLS + composite PK)

// @ts-check
const { test, expect } = require("@playwright/test");
const { signIn, signOut } = require("./fixtures/users.js");

test.describe("@isolation two-user data isolation", () => {
  // ── Test 1: auth gate ─────────────────────────────────────────────────────
  // This is the simplest possible check: does visiting the dashboard without
  // a session redirect to login before loading any data?
  // Fails now because index.html has no auth gate.
  test("unauthenticated visit to dashboard redirects to login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/login\.html/, { timeout: 5000 });
  });

  // ── Test 2: write/read isolation ─────────────────────────────────────────
  // User A logs in, writes a sentinel value, logs out.
  // User B logs in — must NOT see user A's sentinel value.
  // Fails now at the first redirect assertion (same reason as test 1).
  test("user B cannot see data written by user A", async ({ browser }) => {
    // ── User A: establish session and write a sentinel value ─────────────────
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();

    await pageA.goto("/");
    await expect(pageA).toHaveURL(/login\.html/, { timeout: 5000 });

    await signIn(pageA, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);

    // Write a distinctive value that would be easy to spot if it leaked.
    // data-field="startupCost" will be added to index.html when we implement
    // the auth gate update — the selector is intentionally forward-looking.
    const sentinel = "77777";
    await pageA.locator('input[data-field="startupCost"]').first().fill(sentinel);
    await pageA.locator('input[data-field="startupCost"]').first().dispatchEvent("change");
    await expect(pageA.locator("#save-status")).toHaveText("SAVED", { timeout: 10000 });

    await signOut(pageA);
    await ctxA.close();

    // ── User B: verify the sentinel is not visible ───────────────────────────
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();

    await pageB.goto("/");
    await expect(pageB).toHaveURL(/login\.html/, { timeout: 5000 });

    await signIn(pageB, process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);

    const bValue = await pageB.locator('input[data-field="startupCost"]').first().inputValue();
    expect(bValue).not.toBe(sentinel);

    await ctxB.close();
  });

  // ── Test 3: RLS check via direct API call ─────────────────────────────────
  // With RLS enabled, an unauthenticated anon-key request to bethel_data must
  // return an empty array. Currently returns rows because RLS is off.
  // This test documents the current broken state and will pass once migration
  // 001 is applied.
  test("unauthenticated API call returns no rows (RLS not yet enabled)", async ({ request }) => {
    const res = await request.get(
      `${process.env.SUPABASE_URL}/rest/v1/bethel_data?id=eq.homes&select=id`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
      }
    );
    const rows = await res.json();
    // Expect 0 rows (RLS blocks unauthenticated reads).
    // Currently returns 1 row — that is the bug migration 001 fixes.
    expect(rows).toHaveLength(0);
  });
});
