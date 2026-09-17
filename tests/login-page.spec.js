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

  // ── Signup against an address that already has an account ─────────────────
  // Kev's report, 2026-09-17: "when people create an account, they're not
  // receiving the confirmation email."
  //
  // The cause is not SMTP. Supabase's user-enumeration protection answers a
  // signup for an existing address with HTTP 200 and a convincing fake user —
  // random id, confirmation_sent_at populated — distinguished from a real
  // signup only by an empty `identities` array. It sends no email. This page
  // used to show "Check your email to confirm your account" for that response,
  // so every repeat signup told someone to wait for mail that was never sent.
  //
  // The response below is a verbatim capture from the live project.
  //
  // Fails if: an already-registered address is reported as a new account.
  test("signup: an address that already has an account says so, and never claims an email was sent", async ({ page }) => {
    await page.route(/\/auth\/v1\/signup/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "5c6cb877-f5f1-407e-8024-b1d153ec8baf",
          aud: "authenticated",
          role: "authenticated",
          email: "already-registered@example.com",
          confirmation_sent_at: "2026-09-17T23:41:51.407977691Z",
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          identities: [],
          created_at: "2026-09-17T23:41:51.4Z",
          updated_at: "2026-09-17T23:41:51.4Z",
          is_anonymous: false,
        }),
      })
    );

    await page.goto("/login");
    await page.locator("#to-signup").click();
    await page.locator("#su-email").fill("already-registered@example.com");
    await page.locator("#su-password").fill("correct-horse-battery");
    await page.locator("#su-confirm").fill("correct-horse-battery");
    await page.locator("#signup-btn").click();

    await expect(page.locator("#signup-exists")).toBeVisible();
    await expect(page.locator("#signup-exists")).toContainText("already exists");

    // The part that did the damage: this must not be on screen.
    await expect(page.locator("#signup-success")).not.toBeVisible();
    await expect(page.locator("#signup-btn")).toHaveText("Create Account");
  });

  // ── A genuinely new signup still reports success ──────────────────────────
  // The guard above must key on `identities`, not on "any signup response", or
  // it would break the case it exists to protect.
  //
  // Fails if: a real new signup stops saying "check your email".
  test("signup: a brand-new address still says to check your email", async ({ page }) => {
    await page.route(/\/auth\/v1\/signup/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "11111111-2222-3333-4444-555555555555",
          aud: "authenticated",
          role: "authenticated",
          email: "brand-new@example.com",
          confirmation_sent_at: "2026-09-17T23:41:51.407977691Z",
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          identities: [{ id: "abc", user_id: "11111111-2222-3333-4444-555555555555", provider: "email" }],
          created_at: "2026-09-17T23:41:51.4Z",
          updated_at: "2026-09-17T23:41:51.4Z",
          is_anonymous: false,
        }),
      })
    );

    await page.goto("/login");
    await page.locator("#to-signup").click();
    await page.locator("#su-email").fill("brand-new@example.com");
    await page.locator("#su-password").fill("correct-horse-battery");
    await page.locator("#su-confirm").fill("correct-horse-battery");
    await page.locator("#signup-btn").click();

    await expect(page.locator("#signup-success")).toBeVisible();
    await expect(page.locator("#signup-exists")).not.toBeVisible();
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
