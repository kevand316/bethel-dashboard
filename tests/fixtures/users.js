// tests/fixtures/users.js
// Auth helpers for Playwright tests.
//
// The URL guard at the top of this file runs on import. It refuses to proceed if
// SUPABASE_URL is not a known project. This prevents a misconfigured .env.test from
// silently pointing tests at the wrong Supabase project.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env.test") });

// ── URL GUARD ─────────────────────────────────────────────────────────────────
// Update this list only when a project is explicitly added for test use.
// Do NOT remove the guard when adding a new project — update the allowlist.
const ALLOWED_SUPABASE_URLS = ["https://yqgccykbdihsjqlapghr.supabase.co"];

const supabaseUrl = process.env.SUPABASE_URL;

if (!supabaseUrl) {
  throw new Error(
    "[tests/fixtures/users.js] SUPABASE_URL is not set.\n" +
      "Copy .env.test.example to .env.test and fill in the values."
  );
}

if (!ALLOWED_SUPABASE_URLS.includes(supabaseUrl)) {
  throw new Error(
    `[tests/fixtures/users.js] SUPABASE_URL "${supabaseUrl}" is not in the allowed list.\n` +
      `Allowed: ${ALLOWED_SUPABASE_URLS.join(", ")}\n` +
      "This guard prevents tests from firing against an unknown Supabase project.\n" +
      "If you are deliberately targeting a new project, add it to ALLOWED_SUPABASE_URLS in this file."
  );
}
// ── END URL GUARD ─────────────────────────────────────────────────────────────

/**
 * Signs in via the login page UI.
 * Expects login.html to exist with #email, #password inputs and a submit button.
 * Will fail (correctly) until login.html is built.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} email
 * @param {string} password
 */
async function signIn(page, email, password) {
  // serve redirects /login.html → /login (clean URLs), so navigate to /login directly.
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('#login-btn').click();
  await page.waitForURL("/", { timeout: 10000 });
}

/**
 * Signs out by clicking the logout button in the dashboard.
 * Expects a [data-action="logout"] element. Will fail until logout is built.
 *
 * @param {import('@playwright/test').Page} page
 */
async function signOut(page) {
  await page.locator('[data-action="logout"]').click();
  // serve redirects /login.html → /login (clean URLs)
  await page.waitForURL(/\/login/, { timeout: 5000 });
}

/**
 * Deletes all bethel_data rows belonging to a test user.
 * No-op until auth + RLS are built — implemented in the autosave work session.
 * Must be called in afterEach to keep the test project clean.
 *
 * @param {string} _userId - The test user's Supabase UID
 */
async function cleanupUserData(_userId) {
  // TODO: once lib/supabase.js and auth exist, sign in as the test user and
  // delete their bethel_data rows. Until then this is intentionally a no-op.
}

module.exports = { signIn, signOut, cleanupUserData };
