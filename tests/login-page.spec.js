// tests/login-page.spec.js
//
// Login page UI tests: mobile layout, tap targets, and form validation.
// No Supabase calls are made — these are pure UI/render tests.
//
// These tests will pass once:
//   - login.html renders without horizontal overflow at 375px
//   - all interactive elements meet minimum tap target size
//   - signup form validation catches 7-char passwords (< 8 min)
//   - signup form validation catches password mismatch

// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("@smoke login page UI", () => {
  // ── Test 1: 375px mobile — no horizontal scroll ───────────────────────────
  // At 375px (iPhone SE), the card must fit without triggering document overflow.
  // Horizontal scroll on mobile means the user has to hunt for inputs — broken UX.
  test("375px viewport: no horizontal scroll", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await page.goto("/login");

    // document.documentElement.scrollWidth > clientWidth means overflow exists
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);

    await ctx.close();
  });

  // ── Test 2: 375px mobile — primary action elements are tappable ─────────
  // Touch targets must be at least 44px tall (Apple HIG / WCAG 2.5.8).
  // Checks inputs and submit button only — inline text toggles (.toggle-link)
  // are intentionally excluded (they're navigational, not action elements).
  test("375px viewport: inputs and submit button meet minimum tap target size", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await page.goto("/login");

    const MIN_HEIGHT = 44; // px

    // Only primary action elements: text/email/password inputs + submit button
    const elements = await page
      .locator("#login-view input, #login-view button[type='submit']")
      .all();

    for (const el of elements) {
      const box = await el.boundingBox();
      if (!box) continue; // skip hidden elements
      expect(box.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
    }

    await ctx.close();
  });

  // ── Test 3: signup form — short password shows validation error ──────────
  // HTML minlength="8" blocks native form submission for short passwords, so
  // to exercise the JS validation branch we remove the minlength attribute
  // before submitting. The JS check (pw.length < 8) must show #signup-error.
  test("signup: short password shows 'at least 8 characters' error", async ({ page }) => {
    await page.goto("/login");

    // Switch to signup view
    await page.locator("#to-signup").click();
    await expect(page.locator("#signup-view")).toBeVisible();

    await page.locator("#su-email").fill("test@example.com");
    await page.locator("#su-password").fill("Short7!"); // 7 chars — under minimum

    // Remove minlength so we reach the JS validation branch
    await page.evaluate(() => {
      document.querySelector("#su-password").removeAttribute("minlength");
      document.querySelector("#su-confirm").removeAttribute("minlength");
    });

    await page.locator("#su-confirm").fill("Short7!");
    await page.locator("#signup-btn").click();

    await expect(page.locator("#signup-error")).toBeVisible({ timeout: 3000 });
    await expect(page.locator("#signup-error")).toContainText("8 characters");
  });

  // ── Test 4: signup form — password mismatch shows error ───────────────────
  // Both password fields must match. Mismatch must show error in #signup-error
  // without making any network request.
  test("signup: mismatched passwords show mismatch error", async ({ page }) => {
    await page.goto("/login");

    await page.locator("#to-signup").click();
    await expect(page.locator("#signup-view")).toBeVisible();

    await page.locator("#su-email").fill("test@example.com");
    await page.locator("#su-password").fill("ValidPass123!");
    await page.locator("#su-confirm").fill("DifferentPass123!");
    await page.locator("#signup-btn").click();

    await expect(page.locator("#signup-error")).toBeVisible({ timeout: 3000 });
    await expect(page.locator("#signup-error")).toContainText("do not match");
  });

  // ── Test 5: forgot-password link shows reset view ─────────────────────────
  // Clicking "Forgot password?" must hide the login view and show #reset-view.
  // This is pure JS view-switching — no network call.
  test("forgot-password link navigates to reset view", async ({ page }) => {
    await page.goto("/login");

    await page.locator("#forgot-link").click();

    await expect(page.locator("#reset-view")).toBeVisible({ timeout: 2000 });
    await expect(page.locator("#login-view")).toBeHidden();
  });
});
