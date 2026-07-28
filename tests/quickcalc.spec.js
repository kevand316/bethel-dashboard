// tests/quickcalc.spec.js
//
// Quick Calc tab — stateless profitability scratch-pad.
//
// The tab is pure client-side arithmetic: no Supabase reads or writes, no autosave.
// These tests therefore write nothing and need no cleanup — they only sign in because
// the dashboard is behind the auth gate.
//
// These tests will pass once index.html has:
//   - a "Quick Calc" tab button between Projections and Reports
//   - #view-quickcalc with inputs #qc-beds, #qc-bedrooms, #qc-occ, #qc-rate,
//     #qc-expenses, #qc-low-rate, #qc-high-rate
//   - outputs #qc-revenue, #qc-expenses-out, #qc-cashflow, #qc-annual, #qc-margin,
//     #qc-breakeven, #qc-verdict
//   - a range strip with #qc-low-annual, #qc-base-annual, #qc-high-annual

// @ts-check
const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures/users.js");

// Parses "$12,240" / "-$1,200" / "18%" into a number. Returns NaN for "—".
function num(text) {
  const cleaned = String(text).replace(/[$,%\s]/g, "");
  return cleaned === "—" || cleaned === "" ? NaN : parseFloat(cleaned);
}

async function openQuickCalc(page) {
  await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
  await expect(page).toHaveURL("/", { timeout: 10000 });
  await page.getByRole("button", { name: "Quick Calc" }).click();
  await expect(page.locator("#view-quickcalc")).toBeVisible();
}

test.describe("@smoke quick calc", () => {
  // ── Test 1: renders with defaults and reads PROFITABLE ────────────────────
  // 12 beds x $850 x 90% = $9,180 revenue - $1,200 expenses = $7,980/mo.
  // Fails if: the tab is missing, defaults differ, or the verdict is not profitable.
  test("opens with defaults and shows a profitable verdict", async ({ page }) => {
    await openQuickCalc(page);

    await expect(page.locator("#qc-beds")).toHaveValue("12");
    await expect(page.locator("#qc-bedrooms")).toHaveValue("4");
    await expect(page.locator("#qc-occ")).toHaveValue("90");
    await expect(page.locator("#qc-rate")).toHaveValue("850");
    await expect(page.locator("#qc-expenses")).toHaveValue("1200");

    await expect(page.locator("#qc-verdict")).toHaveText("PROFITABLE");
    await expect(page.locator("#qc-revenue")).toHaveText("$9,180");
    await expect(page.locator("#qc-cashflow")).toHaveText("$7,980");
    await expect(page.locator("#qc-annual")).toHaveText("$95,760");

    // Annual cashflow must be a real, positive number
    expect(num(await page.locator("#qc-annual").textContent())).toBeGreaterThan(0);
  });

  // ── Test 2: live recalculation flips the verdict ──────────────────────────
  // No button press — typing alone must drive the outputs.
  // Fails if: the verdict stays PROFITABLE, or recalculation needs a submit.
  test("changing inputs recalculates live and flips the verdict", async ({ page }) => {
    await openQuickCalc(page);
    await expect(page.locator("#qc-verdict")).toHaveText("PROFITABLE");

    // Expenses well above the $9,180 of revenue at default settings
    await page.locator("#qc-expenses").fill("20000");

    await expect(page.locator("#qc-verdict")).toHaveText("NOT PROFITABLE");
    expect(num(await page.locator("#qc-cashflow").textContent())).toBeLessThan(0);
    expect(num(await page.locator("#qc-annual").textContent())).toBeLessThan(0);
  });

  // ── Test 3: zero beds shows "—", never NaN ────────────────────────────────
  // With no revenue basis every derived figure is undefined, not zero.
  // Fails if: any output renders NaN, $NaN, or Infinity.
  test("zero beds shows em-dash states and never NaN", async ({ page }) => {
    await openQuickCalc(page);
    await page.locator("#qc-beds").fill("0");

    for (const id of [
      "#qc-revenue",
      "#qc-cashflow",
      "#qc-annual",
      "#qc-margin",
      "#qc-breakeven",
      "#qc-verdict",
    ]) {
      await expect(page.locator(id)).toHaveText("—");
    }

    const viewText = await page.locator("#view-quickcalc").innerText();
    expect(viewText).not.toContain("NaN");
    expect(viewText).not.toContain("Infinity");
  });

  // ── Test 4: rate range shows low / base / high ────────────────────────────
  // Same home, three price points. Higher rate must produce higher annual cashflow.
  // Fails if: the range strip is missing or the columns don't track their inputs.
  test("rate range shows low, base and high side by side", async ({ page }) => {
    await openQuickCalc(page);

    await page.locator("#qc-low-rate").fill("750");
    await page.locator("#qc-high-rate").fill("1000");

    const low = num(await page.locator("#qc-low-annual").textContent());
    const base = num(await page.locator("#qc-base-annual").textContent());
    const high = num(await page.locator("#qc-high-annual").textContent());

    expect(Number.isFinite(low)).toBe(true);
    expect(base).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(base);
  });
});
