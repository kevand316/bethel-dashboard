// tests/auth.spec.js
//
// Auth gate and session lifecycle tests.
//
// These tests will pass once:
//   - login.html exists with #login-error, #email, #password, #login-btn
//   - lib/auth.js redirects unauthenticated users on every protected page
//   - logout clears the Supabase session and redirects to /login
//   - session survives a page reload (SDK persists in localStorage)
//   - a corrupted/deleted token causes requireAuth() to redirect

// @ts-check
const { test, expect } = require("@playwright/test");
const { signIn, signOut } = require("./fixtures/users.js");

test.describe("@smoke auth sign-in and session", () => {
  // ── Test 1: invalid credentials show inline error ─────────────────────────
  // Supabase returns "Invalid login credentials" for wrong password.
  // The login form must show that message in #login-error (visible class).
  // Fails if: #login-error stays hidden, or message text doesn't match.
  test("invalid credentials show inline error message", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(process.env.TEST_USER_A_EMAIL);
    await page.locator("#password").fill("definitely-wrong-password-xyz");
    await page.locator("#login-btn").click();

    // Error element must become visible
    await expect(page.locator("#login-error")).toBeVisible({ timeout: 8000 });
    // Supabase SDK surfaces the message from the API response
    await expect(page.locator("#login-error")).toContainText("Invalid login credentials");
    // Still on login page — did NOT redirect
    await expect(page).toHaveURL(/\/login/, { timeout: 3000 });
  });

  // ── Test 2: logout clears session and redirects ───────────────────────────
  // After signing in, clicking the logout button must:
  //   1. Call supabase.auth.signOut()
  //   2. Redirect to /login
  //   3. Leave no valid session — revisiting / immediately redirects back to /login
  test("logout clears session and revisiting dashboard redirects", async ({ page }) => {
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });

    await signOut(page);
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });

    // Revisiting / with no session must redirect again — proves session was cleared
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
  });

  // ── Test 3: session persists across page reload ───────────────────────────
  // The Supabase SDK stores the session in localStorage. A hard reload must
  // not log the user out.
  // Fails if: auth gate doesn't check localStorage-persisted session, or
  //           if the SDK re-validates and clears it on every reload.
  test("session survives page reload", async ({ page }) => {
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });

    // Hard reload — session must survive
    await page.reload();
    await expect(page).toHaveURL("/", { timeout: 8000 });
    // Dashboard should render, not redirect
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
  });

  // ── Test 4: corrupted token causes redirect before data fetch ─────────────
  // If the JWT in localStorage is tampered with, getSession() returns null.
  // requireAuth() must redirect to /login BEFORE any data fetch fires.
  // We simulate this by deleting the Supabase session key from localStorage.
  //
  // The "before any data fetch" requirement: check that no request to
  // /rest/v1/bethel_data is made when the session is invalid.
  test("deleted session token redirects before any data fetch", async ({ page }) => {
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });

    // Track whether any data fetch fires after we corrupt the token
    let dataFetchFired = false;
    page.on("request", (req) => {
      if (req.url().includes("/rest/v1/bethel_data")) dataFetchFired = true;
    });

    // Delete the session from localStorage — simulates expired/tampered JWT
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      if (key) localStorage.removeItem(key);
    });

    // Reload — requireAuth() should redirect immediately
    await page.reload();
    await expect(page).toHaveURL(/\/login/, { timeout: 8000 });

    // No data fetch should have fired
    expect(dataFetchFired).toBe(false);
  });
});
