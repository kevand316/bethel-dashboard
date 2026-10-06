// tests/text-number.spec.js
//
// The number staff text (1-888-267-7502) is always on screen: in the header,
// between the signed-in email and Sign Out, and at the top of the Team tab.

// @ts-check
const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures/users.js");

async function signedIn(page) {
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
  await expect(page).toHaveURL("/", { timeout: 10000 });
}

test.describe("@textnumber texting number", () => {
  test("header shows the number between the email and Sign Out, and it opens a text", async ({ page }) => {
    await signedIn(page);
    const order = await page.evaluate(() =>
      [...document.querySelectorAll(".header-right > *")].map((el) => el.id || el.className));
    const at = (name) => order.findIndex((x) => x.includes(name));
    expect(at("text-number")).toBeGreaterThan(at("session-email"));
    expect(at("text-number")).toBeLessThan(at("logout-btn"));
    const link = page.locator(".header-right .text-number");
    await expect(link).toContainText("1-888-267-7502");
    await expect(link).toHaveAttribute("href", "sms:+18882677502");
  });

  test("Team tab shows the number", async ({ page }) => {
    await signedIn(page);
    await page.getByRole("button", { name: "Team", exact: true }).click();
    await expect(page.locator("#view-team")).toContainText("1-888-267-7502");
  });

  test("header fits a 375px phone with the number in it", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signedIn(page);
    await expect(page.locator(".header-right .text-number")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
