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

    // Block all Supabase upsert calls
    await page.route(SB_REST, (route) => {
      if (route.request().method() === "POST") {
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
  // Deferred to migration 002. Skipping with explicit reason so it shows in output.
  test.skip("cross-device conflict detection — deferred to migration 002 session", () => {
    // Will simulate two browser contexts editing the same row simultaneously.
    // Requires conflict_version column (migration 002) and UI warning banner.
    // Do not implement until migration 002 plan is approved.
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
