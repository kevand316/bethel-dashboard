// tests/contrast.spec.js
//
// Operator instruction, 2026-08-25: every piece of text on this dashboard is
// white, or the brand gold when it is highlighted or selected. Nothing dim.
//
// This is a readability rule, not a taste one — the old washed-out slate sat
// almost on top of the background, so labels and hints were technically present
// and practically invisible. A CSS grep cannot prove it is gone, because what
// matters is the COMPUTED colour of real rendered text against what is actually
// behind it. So this walks the live DOM and measures.

// @ts-check
const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures/users.js");
const { installFakeDrive } = require("./fixtures/fake-drive.js");

// Relative luminance and WCAG contrast ratio.
function ratio(fg, bg) {
  const lum = ([r, g, b]) => {
    const c = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Collects every visible text node's computed colour and its effective
// background (walking up until something is not transparent).
const COLLECT = () => {
  const parse = (c) => (c.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join("");
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    let bgEl = el;
    let bg = null;
    while (bgEl) {
      const c = parse(getComputedStyle(bgEl).backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) {
        bg = c.slice(0, 3);
        break;
      }
      bgEl = bgEl.parentElement;
    }
    out.push({
      text: text.slice(0, 40),
      selector:
        el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""),
      fg: parse(cs.color).slice(0, 3),
      bg: bg || [10, 14, 20],
      size: parseFloat(cs.fontSize),
    });
  }
  return out;
};

// WCAG AA for body text. The operator's rule is stricter than this in spirit —
// white on this background scores ~14:1 — so anything failing 4.5 is unambiguous.
const MIN = 4.5;

async function auditPage(page, label) {
  const items = await page.evaluate(COLLECT);
  expect(items.length, `${label}: found no text to audit — the check is broken`).toBeGreaterThan(5);

  const failures = items
    .map((i) => ({ ...i, ratio: ratio(i.fg, i.bg) }))
    .filter((i) => i.ratio < MIN)
    .map(
      (i) =>
        `${label} — "${i.text}" (${i.selector}) rgb(${i.fg}) on rgb(${i.bg}) = ${i.ratio.toFixed(2)}:1`
    );

  expect(failures, `Unreadable text:\n${failures.join("\n")}`).toEqual([]);
}

test.describe("@smoke text is readable everywhere", () => {
  test("login page has no washed-out text", async ({ page }) => {
    await page.goto("/login");
    await auditPage(page, "login");
  });

  test("every dashboard tab has no washed-out text", async ({ page }) => {
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await page.addInitScript(installFakeDrive);
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });

    for (const tab of ["Overview", "Operations", "Profit Calculator", "Reports"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await page.waitForTimeout(200); // let the view render
      await auditPage(page, tab);
    }
  });

  test("the intake tab has no washed-out text, gate through form", async ({ page }) => {
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await page.addInitScript(installFakeDrive);
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Intake", exact: true }).click();

    // The gate — this is the screen the operator called out by name.
    await expect(page.locator("#intake-gate")).toHaveClass(/active/);
    await auditPage(page, "intake gate");

    await page.locator("#intake-connect-btn").click();
    await expect(page.locator("#intake-list")).toHaveClass(/active/, { timeout: 10000 });
    await auditPage(page, "intake list");

    // The form is a light document, so "readable" there means dark ink on cream,
    // not white. Same rule, measured the same way.
    await page.locator("#intake-new-btn").click();
    await expect(page.locator("#intake-form")).toHaveClass(/active/);
    await auditPage(page, "intake form");
  });

  test("mobile at 375px has no washed-out text", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await page.addInitScript(installFakeDrive);
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await auditPage(page, "mobile overview");
  });
});
