// tests/quickcalc.spec.js
//
// Profit Calculator tab — stateless profitability scratch-pad.
// (ids remain view-quickcalc / qc-* — only the visible label was renamed.)
//
// The tab is pure client-side arithmetic: no Supabase reads or writes, no autosave.
// These tests therefore write nothing and need no cleanup — they only sign in because
// the dashboard is behind the auth gate.
//
// These tests will pass once index.html has:
//   - a "Profit Calculator" tab button between Projections and Reports
//   - #view-quickcalc with inputs #qc-beds, #qc-bedrooms, #qc-occ, #qc-rate,
//     the five expense inputs (#qc-exp-rent, -utilities, -supplies, -staff,
//     -operations), #qc-low-rate, #qc-high-rate
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
  await page.getByRole("button", { name: "Profit Calculator" }).click();
  await expect(page.locator("#view-quickcalc")).toBeVisible();
}

test.describe("@smoke profit calculator", () => {
  // ── Test 1: renders with defaults and reads PROFITABLE ────────────────────
  // 90% of 12 beds rounds DOWN to 10 filled: 10 x $850 = $8,500 revenue,
  // less $6,725 of expenses = $1,775/mo.
  // Fails if: the tab is missing, defaults differ, or the verdict is not profitable.
  test("opens with defaults and shows a profitable verdict", async ({ page }) => {
    await openQuickCalc(page);

    await expect(page.locator("#qc-beds")).toHaveValue("12");
    await expect(page.locator("#qc-bedrooms")).toHaveValue("6");
    await expect(page.locator("#qc-occ")).toHaveValue("90");
    await expect(page.locator("#qc-rate")).toHaveValue("850");
    // Typical starting figures for a 12-bed home. Staff mirrors the bed rate.
    await expect(page.locator("#qc-exp-rent")).toHaveValue("5000");
    await expect(page.locator("#qc-exp-utilities")).toHaveValue("600");
    await expect(page.locator("#qc-exp-supplies")).toHaveValue("175");
    await expect(page.locator("#qc-exp-staff")).toHaveValue("850");
    await expect(page.locator("#qc-exp-operations")).toHaveValue("100");

    // Whole beds only: 90% of 12 is 10.8, which must be billed as 10.
    await expect(page.locator("#qc-verdict")).toHaveText("PROFITABLE");
    await expect(page.locator("#qc-occupied-sub")).toContainText("10 of 12 beds filled");
    await expect(page.locator("#qc-revenue")).toHaveText("$8,500");
    await expect(page.locator("#qc-expenses-out")).toHaveText("$6,725");
    await expect(page.locator("#qc-cashflow")).toHaveText("$1,775");
    await expect(page.locator("#qc-annual")).toHaveText("$21,300");

    // Annual cashflow must be a real, positive number
    expect(num(await page.locator("#qc-annual").textContent())).toBeGreaterThan(0);
  });

  // ── Test 2: live recalculation flips the verdict ──────────────────────────
  // No button press — typing alone must drive the outputs.
  // Fails if: the verdict stays PROFITABLE, or recalculation needs a submit.
  test("changing inputs recalculates live and flips the verdict", async ({ page }) => {
    await openQuickCalc(page);
    await expect(page.locator("#qc-verdict")).toHaveText("PROFITABLE");

    // Rent alone well above the $9,180 of revenue at default settings
    await page.locator("#qc-exp-rent").fill("20000");

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

  // ── Test 3b: the five expense categories add up ───────────────────────────
  // Expenses are entered per category, so the number driving cashflow must be
  // their sum — not one of them, and not a stale total.
  // Fails if: any category is dropped, or the running total drifts from the
  // figure used in the cashflow calculation.
  test("expense categories sum into the total used for cashflow", async ({ page }) => {
    await openQuickCalc(page);

    for (const [id, value] of [
      ["#qc-exp-rent", "1000"],
      ["#qc-exp-utilities", "200"],
      ["#qc-exp-supplies", "300"],
      ["#qc-exp-staff", "400"],
      ["#qc-exp-operations", "100"],
    ]) {
      await page.locator(id).fill(value);
    }

    // 1000 + 200 + 300 + 400 + 100 = 2000, shown both on the input panel and
    // in the results cell, and driving cashflow: $8,500 - $2,000 = $6,500.
    await expect(page.locator("#qc-exp-total")).toHaveText("$2,000");
    await expect(page.locator("#qc-expenses-out")).toHaveText("$2,000");
    await expect(page.locator("#qc-cashflow")).toHaveText("$6,500");

    // Clearing one category must move the total, proving it is really summed.
    await page.locator("#qc-exp-staff").fill("0");
    await expect(page.locator("#qc-exp-total")).toHaveText("$1,600");
    await expect(page.locator("#qc-cashflow")).toHaveText("$6,900");
  });

  // ── Test 3b2: occupancy resolves to whole beds, rounded down ──────────────
  // A bed is a person. 85% of 12 beds is 10.2, and 0.2 of a resident pays
  // nothing — billing the fraction inflates every projection. Revenue must be
  // filled-beds × rate, with filled beds floored.
  //
  // Fails if: revenue is computed from a fractional bed count.
  test("occupancy rounds down to whole beds before revenue is calculated", async ({ page }) => {
    await openQuickCalc(page);
    await page.locator("#qc-rate").fill("800");

    // beds, occupancy %, beds actually filled (floor), revenue at $800
    const cases = [
      [12, 85, 10, "$8,000"],
      [12, 90, 10, "$8,000"],
      [12, 100, 12, "$9,600"],
      [12, 50, 6, "$4,800"],
      [7, 85, 5, "$4,000"],
      [20, 33, 6, "$4,800"],
      [1, 99, 0, "$0"],
    ];

    for (const [beds, occ, filled, revenue] of cases) {
      await page.locator("#qc-beds").fill(String(beds));
      await page.locator("#qc-occ").fill(String(occ));
      await expect(page.locator("#qc-occupied-sub")).toContainText(
        `${filled} of ${beds} bed${beds === 1 ? "" : "s"} filled`
      );
      await expect(page.locator("#qc-revenue")).toHaveText(revenue);
    }
  });

  // ── Test 3c: staff tracks the bed rate until overridden ───────────────────
  // The house lead occupies a bed rent-free, so staffing cost ≈ one bed's rate.
  // Staff follows the rate field, but must stop the moment the operator types
  // their own number — a default that silently overwrites real input is worse
  // than no default at all.
  test("staff follows the bed rate until the operator overrides it", async ({ page }) => {
    await openQuickCalc(page);
    await expect(page.locator("#qc-exp-staff")).toHaveValue("850");

    await page.locator("#qc-rate").fill("1200");
    await expect(page.locator("#qc-exp-staff")).toHaveValue("1200");

    await page.locator("#qc-rate").fill("700");
    await expect(page.locator("#qc-exp-staff")).toHaveValue("700");

    // Hand-entered value must survive later rate changes.
    await page.locator("#qc-exp-staff").fill("2000");
    await page.locator("#qc-rate").fill("950");
    await expect(page.locator("#qc-exp-staff")).toHaveValue("2000");
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
