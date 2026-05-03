// tests/autosave.spec.js
//
// TDD: these tests are written BEFORE the autosave feature exists. They must fail.
// The expected failure reason for all active tests:
//   - window.autosave does not exist yet
//   - save-status never shows "SAVED ✓" (currently shows "SAVED")
//   - input[data-field="startupCost"] does not exist yet in the DOM
//
// These tests will pass once:
//   - lib/autosave.js is implemented and loaded
//   - index.html wires persistData() → autosave.push()
//   - startupCost input with data-field="startupCost" is added to renderCF()
//   - save-status reflects autosave states: "SAVING...", "SAVED ✓", "OFFLINE — WILL RETRY"

// @ts-check
const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures/users.js");

const SB_REST = "**/rest/v1/bethel_data*";

// Helper: sign in and wait for the dashboard to finish its initial load.
// "Loaded" means save-status shows "SAVED ✓" — autosave drained the queue
// and Supabase confirmed. Fails during TDD because the text never appears.
async function signInAndWaitForLoad(page) {
  await page.goto("/");
  // serve redirects /login.html → /login (clean URLs)
  await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
  await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
  // Wait for the initial save round-trip to complete
  await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
}

// Helper: navigate to Operations tab and wait for startupCost input
async function goToOps(page) {
  await page.locator('[data-tab="ops"]').click();
  await expect(page.locator('input[data-field="startupCost"]').first()).toBeVisible({
    timeout: 5000,
  });
}

// ── Clean up between tests ─────────────────────────────────────────────────────
test.beforeEach(async ({ page }) => {
  // Sign in, clear any pending queue entries left by a previous test
  // This is defensive — fresh login context resets localStorage anyway
  await page.goto("/");
});

test.describe("@autosave autosave queue", () => {
  // ── Test 1: Happy path ─────────────────────────────────────────────────────
  // Edit a field → "SAVING..." appears immediately → "SAVED ✓" after confirmation
  // → reload → value persists.
  //
  // Fails now because: save-status never reaches "SAVED ✓" (it says "SAVED"),
  // and input[data-field="startupCost"] does not exist.
  test("happy path: edit persists after reload", async ({ page }) => {
    await signInAndWaitForLoad(page);
    await goToOps(page);

    const input = page.locator('input[data-field="startupCost"]').first();

    // Trigger an edit
    await input.fill("99000");
    await input.dispatchEvent("change");

    // Indicator should transition through saving → saved
    await expect(page.locator("#save-status")).toHaveText("SAVING...", { timeout: 5000 });
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });

    // Reload and verify persistence
    await page.reload();
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
    await goToOps(page);
    await expect(page.locator('input[data-field="startupCost"]').first()).toHaveValue("99000");

    // Cleanup: reset to 0
    await input.fill("0");
    await input.dispatchEvent("change");
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
  });

  // ── Test 2: Network drop mid-save ─────────────────────────────────────────
  // Block the Supabase POST. Edit a field. Verify indicator says
  // "OFFLINE — WILL RETRY" and NOT "SAVED ✓".
  // Restore network. Verify queue drains and indicator reaches "SAVED ✓".
  //
  // Fails now because: no autosave module, no retry logic, no offline state.
  test("network drop shows offline state then recovers", async ({ page }) => {
    await signInAndWaitForLoad(page);
    await goToOps(page);

    // Block all Supabase write calls (POST = upsert pre-migration, PATCH = conditional update post-migration)
    await page.route(SB_REST, (route) => {
      const method = route.request().method();
      if (method === "POST" || method === "PATCH") {
        route.abort("failed");
      } else {
        route.continue();
      }
    });

    const input = page.locator('input[data-field="startupCost"]').first();
    await input.fill("55000");
    await input.dispatchEvent("change");

    // Should show offline, NOT saved
    await expect(page.locator("#save-status")).toHaveText("OFFLINE — WILL RETRY", {
      timeout: 15000,
    });
    await expect(page.locator("#save-status")).not.toHaveText("SAVED ✓");

    // Restore the network
    await page.unroute(SB_REST);

    // Queue should drain and reach saved
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 30000 });

    // Cleanup
    await input.fill("0");
    await input.dispatchEvent("change");
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
  });

  // ── Test 3: Reload while pending ──────────────────────────────────────────
  // Intercept to delay the POST by 5 seconds. Edit a field while SAVING...
  // Reload before Supabase confirms. After reload, the queue in localStorage
  // must replay the pending write — value eventually persists.
  //
  // Fails now because: no autosave queue in localStorage, reload loses the edit.
  test("reload during pending write — queue drains on next load", async ({ page }) => {
    await signInAndWaitForLoad(page);
    await goToOps(page);

    // Delay the next POST by 8 seconds so we can reload during it
    let resolveDelay;
    const delayPromise = new Promise((res) => (resolveDelay = res));
    await page.route(SB_REST, async (route) => {
      if (route.request().method() === "POST") {
        await delayPromise;
        route.continue();
      } else {
        route.continue();
      }
    });

    const input = page.locator('input[data-field="startupCost"]').first();
    await input.fill("42000");
    await input.dispatchEvent("change");

    // Confirm we're in saving state
    await expect(page.locator("#save-status")).toHaveText("SAVING...", { timeout: 5000 });

    // Reload during the pending window — unblock route first so reload can succeed
    resolveDelay();
    await page.unroute(SB_REST);
    await page.reload();

    // After reload, autosave.drainQueueOnLoad() should flush the pending write.
    // Wait for saved confirmation.
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 20000 });

    await goToOps(page);
    await expect(page.locator('input[data-field="startupCost"]').first()).toHaveValue("42000");

    // Cleanup
    await page.locator('input[data-field="startupCost"]').first().fill("0");
    await page.locator('input[data-field="startupCost"]').first().dispatchEvent("change");
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
  });

  // ── Test 4: Cross-device conflict detection ───────────────────────────────
  // Two browser contexts load the same row. Context A saves first (bumping
  // updated_at). Context B then tries to save — the conditional UPDATE finds
  // 0 rows and the conflict banner appears.
  //
  // Skips gracefully if migration 002 hasn't been applied yet (updatedAt null).
  // SKIPPED: requires migration 002 to be applied. Un-skip after manual SQL run.
  test.skip("cross-device conflict: second write shows conflict banner", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      // Both devices sign in — each gets the same current updatedAt.
      await signInAndWaitForLoad(pageA);
      await signInAndWaitForLoad(pageB);

      // Guard: skip if migration 002 hasn't been applied yet.
      const updatedAt = await pageA.evaluate(async () => {
        const result = await window.sbGetWithTs("homes");
        return result.updatedAt;
      });
      if (updatedAt === null) {
        test.skip(true, "Migration 002 not yet applied — skipping conflict test");
        return;
      }

      // Device A edits and waits for confirmed save (bumps updated_at on server).
      await pageA.locator('[data-tab="ops"]').click();
      await expect(pageA.locator('input[data-field="startupCost"]').first()).toBeVisible({
        timeout: 5000,
      });
      await pageA.locator('input[data-field="startupCost"]').first().fill("11111");
      await pageA.locator('input[data-field="startupCost"]').first().dispatchEvent("change");
      await expect(pageA.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });

      // Device B edits — its _loadedAt is now stale (A's save bumped updated_at).
      await pageB.locator('[data-tab="ops"]').click();
      await expect(pageB.locator('input[data-field="startupCost"]').first()).toBeVisible({
        timeout: 5000,
      });
      await pageB.locator('input[data-field="startupCost"]').first().fill("22222");
      await pageB.locator('input[data-field="startupCost"]').first().dispatchEvent("change");

      // Conflict banner must appear on device B.
      await expect(pageB.locator("#conflict-banner")).toBeVisible({ timeout: 15000 });
      await expect(pageB.locator("#save-status")).toHaveText("CHANGED ELSEWHERE", {
        timeout: 5000,
      });
    } finally {
      await ctxA.close();
      await ctxB.close();
      // Cleanup: reset startup cost to 0
      const ctxClean = await browser.newContext();
      const pageClean = await ctxClean.newPage();
      await signInAndWaitForLoad(pageClean);
      await pageClean.locator('[data-tab="ops"]').click();
      await expect(pageClean.locator('input[data-field="startupCost"]').first()).toBeVisible({
        timeout: 5000,
      });
      await pageClean.locator('input[data-field="startupCost"]').first().fill("0");
      await pageClean.locator('input[data-field="startupCost"]').first().dispatchEvent("change");
      await expect(pageClean.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
      await ctxClean.close();
    }
  });

  // ── Test 7: Conflict override path ────────────────────────────────────────
  // After a conflict banner appears, clicking "Override and save anyway"
  // clears the banner, saves the local version unconditionally, and resumes
  // normal conditional writes (verified by subsequent reload + value check).
  //
  // Skips gracefully if migration 002 hasn't been applied yet.
  // SKIPPED: requires migration 002 to be applied. Un-skip after manual SQL run.
  test.skip("conflict override: clicking Override saves local version", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await signInAndWaitForLoad(pageA);
      await signInAndWaitForLoad(pageB);

      // Guard: skip if migration 002 hasn't been applied yet.
      const updatedAt = await pageA.evaluate(async () => {
        const result = await window.sbGetWithTs("homes");
        return result.updatedAt;
      });
      if (updatedAt === null) {
        test.skip(true, "Migration 002 not yet applied — skipping override test");
        return;
      }

      // Device A saves first (bumps updated_at).
      await pageA.locator('[data-tab="ops"]').click();
      await expect(pageA.locator('input[data-field="startupCost"]').first()).toBeVisible({
        timeout: 5000,
      });
      await pageA.locator('input[data-field="startupCost"]').first().fill("33333");
      await pageA.locator('input[data-field="startupCost"]').first().dispatchEvent("change");
      await expect(pageA.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });

      // Device B edits — conflict detected, banner appears.
      await pageB.locator('[data-tab="ops"]').click();
      await expect(pageB.locator('input[data-field="startupCost"]').first()).toBeVisible({
        timeout: 5000,
      });
      await pageB.locator('input[data-field="startupCost"]').first().fill("44444");
      await pageB.locator('input[data-field="startupCost"]').first().dispatchEvent("change");
      await expect(pageB.locator("#conflict-banner")).toBeVisible({ timeout: 15000 });

      // Click "Override and save anyway".
      await pageB.locator(".conflict-banner-btn.secondary").click();

      // Banner must disappear and save must confirm.
      await expect(pageB.locator("#conflict-banner")).not.toBeVisible({ timeout: 5000 });
      await expect(pageB.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });

      // Reload device B — override value (44444) must have persisted.
      await pageB.reload();
      await expect(pageB.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
      await pageB.locator('[data-tab="ops"]').click();
      await expect(pageB.locator('input[data-field="startupCost"]').first()).toHaveValue("44444");
    } finally {
      await ctxA.close();
      await ctxB.close();
      // Cleanup
      const ctxClean = await browser.newContext();
      const pageClean = await ctxClean.newPage();
      await signInAndWaitForLoad(pageClean);
      await pageClean.locator('[data-tab="ops"]').click();
      await expect(pageClean.locator('input[data-field="startupCost"]').first()).toBeVisible({
        timeout: 5000,
      });
      await pageClean.locator('input[data-field="startupCost"]').first().fill("0");
      await pageClean.locator('input[data-field="startupCost"]').first().dispatchEvent("change");
      await expect(pageClean.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
      await ctxClean.close();
    }
  });

  // ── Test 5: Quota stress — de-duplication ─────────────────────────────────
  // Push 1000 rapid updates for the same row. Queue must hold exactly 1 entry
  // (de-duplication by row_id), not 1000. Eventually reaches "SAVED ✓".
  //
  // Fails now because: no autosave module, no localStorage queue.
  test("1000 rapid pushes result in 1 queue entry, eventually saved", async ({ page }) => {
    await signInAndWaitForLoad(page);

    // Drive 1000 rapid push calls via window.autosave.push (bypasses UI debounce)
    const queueLength = await page.evaluate(async () => {
      if (!window.autosave) throw new Error("window.autosave not found");
      const fakeHomes = [{ id: 1, name: "stress-test", startupCost: 999, expenses: [], beds: [] }];
      for (let i = 0; i < 1000; i++) {
        window.autosave.push("homes", fakeHomes);
      }
      // Read the queue immediately (synchronous localStorage read)
      const QUEUE_KEY = "bethel_autosave_queue";
      const raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return 0;
      return JSON.parse(raw).length;
    });

    expect(queueLength).toBe(1);

    // Eventually drains
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 30000 });
  });

  // ── Test 6: pagehide flush ────────────────────────────────────────────────
  // Edit a field — while SAVING... (debounce hasn't fired yet) — dispatch pagehide.
  // Verify that localStorage has a queue entry (sync write happened).
  // On subsequent reload, the queue drains and value persists.
  //
  // Fails now because: no autosave queue, pagehide doesn't flush a queue.
  test("pagehide during debounce writes queue to localStorage", async ({ page }) => {
    await signInAndWaitForLoad(page);
    await goToOps(page);

    // Delay the POST so we're guaranteed to be mid-debounce when pagehide fires
    await page.route(SB_REST, async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 10000)); // hold it
        route.abort("failed");
      } else {
        route.continue();
      }
    });

    const input = page.locator('input[data-field="startupCost"]').first();
    await input.fill("31000");
    await input.dispatchEvent("change");

    // Dispatch pagehide synchronously — simulates user closing the tab
    const queueLength = await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      const QUEUE_KEY = "bethel_autosave_queue";
      const raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return 0;
      return JSON.parse(raw).length;
    });

    // Queue must have the pending entry
    expect(queueLength).toBeGreaterThan(0);

    // Unblock route and reload — queue should drain
    await page.unroute(SB_REST);
    await page.reload();
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 20000 });

    await goToOps(page);
    await expect(page.locator('input[data-field="startupCost"]').first()).toHaveValue("31000");

    // Cleanup
    await page.locator('input[data-field="startupCost"]').first().fill("0");
    await page.locator('input[data-field="startupCost"]').first().dispatchEvent("change");
    await expect(page.locator("#save-status")).toHaveText("SAVED ✓", { timeout: 15000 });
  });
});
