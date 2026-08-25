// tests/intake.spec.js
//
// Intake tab — client intake forms stored in the operator's own Google Drive.
//
// The invariant these tests exist to defend: NO client information ever reaches
// Supabase. The intake form holds SSNs, dates of birth, Medi-Cal IDs, diagnoses
// and criminal history, and the dashboard's Supabase project has no BAA. Several
// tests below assert the absence of Supabase traffic rather than the presence of
// a feature, and those are the important ones.
//
// Google is faked in the browser (tests/fixtures/fake-drive.js) by replacing
// window.fetch and window.google — the two seams lib/drive.js already uses. All
// of lib/drive.js runs for real; only the far end is a stub. No Google account
// is needed and nothing is written to a real Drive.

// @ts-check
const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures/users.js");
const { installFakeDrive } = require("./fixtures/fake-drive.js");

async function openDashboard(page, { fakeDrive = true } = {}) {
  if (fakeDrive) {
    // index.html loads the real Google Identity Services script, which replaces
    // window.google and would try to open a genuine consent popup against a
    // client ID that does not exist. Block it so the fake survives — and so the
    // suite never reaches out to Google at all.
    await page.route(/accounts\.google\.com/, (route) => route.abort());
    await page.addInitScript(installFakeDrive);
  }
  await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
  await expect(page).toHaveURL("/", { timeout: 10000 });
  await page.getByRole("button", { name: "Intake", exact: true }).click();
  await expect(page.locator("#view-intake")).toBeVisible();
}

async function connectDrive(page) {
  await page.locator("#intake-connect-btn").click();
  await expect(page.locator("#intake-list")).toHaveClass(/active/, { timeout: 10000 });
}

async function openDashboardConnected(page) {
  await openDashboard(page);
  await connectDrive(page);
}

// Fills one field and returns once the form has registered the change.
async function fill(page, name, value) {
  await page.locator(`#intake-form-fields [name="${name}"]`).fill(value);
}

const savedStatus = (page) => page.locator("#intake-save-status");

test.describe("@smoke intake tab", () => {
  // ── Test 1: the gate ──────────────────────────────────────────────────────
  // The whole design rests on client answers having exactly one destination. If
  // Drive is not connected there is no destination, so there must be no form to
  // type into — not a disabled form, no form at all. An operator who can begin
  // typing an SSN into fields that cannot save is the failure this prevents.
  //
  // Fails if: the form renders, or any input exists, before Drive is connected.
  test("refuses to show the form until Google Drive is connected", async ({ page }) => {
    await openDashboard(page);

    await expect(page.locator("#intake-gate")).toHaveClass(/active/);
    await expect(page.locator("#intake-list")).not.toHaveClass(/active/);
    await expect(page.locator("#intake-form")).not.toHaveClass(/active/);

    // Not one input anywhere in the tab.
    await expect(page.locator("#intake-form-fields input")).toHaveCount(0);
    await expect(page.locator("#intake-form-fields select")).toHaveCount(0);
    await expect(page.locator("#intake-form-fields textarea")).toHaveCount(0);

    // And the reason is stated, including the Workspace advice.
    await expect(page.locator("#intake-gate-connect")).toContainText(
      "Google Workspace account is best"
    );
    await expect(page.locator("#intake-gate-connect")).toContainText("your own");
  });

  // ── Test 2: connecting reveals the list ───────────────────────────────────
  // Fails if: connecting does not move the tab into the list state, or the
  // connected account is not shown back to the operator.
  test("connecting Google Drive opens the intake list", async ({ page }) => {
    await openDashboard(page);
    await connectDrive(page);

    await expect(page.locator("#intake-account-email")).toHaveText("operator@example.org");
    await expect(page.locator("#intake-list-body")).toContainText("No intakes yet");
  });

  // ── Test 3: a new intake is created in Drive immediately ──────────────────
  // There is no local draft by design, so an intake that exists only in the DOM
  // is one closed tab away from being gone. It must exist in Drive from the
  // moment it is started.
  //
  // Fails if: no file is created until the first keystroke, or the form does not
  // open with all eight sections.
  test("starting an intake creates the Drive file up front", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await expect(page.locator("#intake-form")).toHaveClass(/active/);

    await expect(page.locator("#intake-form-fields .if-section")).toHaveCount(8);
    await expect(page.locator('#intake-form-fields [name="ssn"]')).toBeVisible();

    const files = await page.evaluate(() => window.__drive.intakeFiles().length);
    expect(files).toBe(1);
  });

  // ── Test 4: typing saves to Drive, and only says so once it has ───────────
  // The save contract from CLAUDE.md, applied to Drive: SAVED is never shown
  // optimistically. While a write is in flight the indicator must say SAVING,
  // and only after Drive has confirmed may it say SAVED.
  //
  // Fails if: the indicator reports success while the request is outstanding, or
  // the record never reaches Drive.
  test("autosaves to Drive and never reports saved before Drive confirms", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓");

    // Make every Drive call slow so the in-flight window is observable.
    await page.evaluate(() => {
      window.__drive.delayMs = 700;
    });

    await fill(page, "firstName", "Dana");
    await expect(savedStatus(page)).toHaveText("SAVING...", { timeout: 5000 });

    // The critical assertion: mid-flight it must NOT claim to be saved.
    await expect(savedStatus(page)).not.toHaveText("SAVED TO DRIVE ✓");

    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    const stored = await page.evaluate(() => {
      const f = window.__drive.intakeFiles()[0];
      return window.__drive.contentOf(f.id);
    });
    expect(stored.firstName).toBe("Dana");
  });

  // ── Test 5: nothing about the client reaches Supabase ─────────────────────
  // This is the architectural invariant, and the reason the tab exists in this
  // shape at all. A regression here is not a bug, it is a HIPAA incident.
  //
  // Fails if: any request to Supabase carries a value typed into the intake form.
  test("no client information is ever sent to Supabase", async ({ page }) => {
    const supabaseBodies = [];
    page.on("request", (req) => {
      if (req.url().includes("supabase.co")) {
        const body = req.postData();
        if (body) supabaseBodies.push(body);
      }
    });

    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();

    // Values chosen to be unmistakable if they turn up anywhere they shouldn't.
    await fill(page, "firstName", "ZZTESTFIRST");
    await fill(page, "lastName", "ZZTESTLAST");
    await fill(page, "ssn", "123456789");
    await fill(page, "mediCalId", "ZZTESTMEDICAL");
    await page.locator('#intake-form-fields [name="criminalNotes"]').fill("ZZTESTCRIMINAL");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    // Force any queued dashboard write out the door before we judge.
    await page.evaluate(() => window.autosave?.flush?.());
    await page.waitForTimeout(1500);

    const leaked = supabaseBodies.filter((b) => /ZZTEST|123-45-6789|123456789/.test(b));
    expect(leaked, `Client data was sent to Supabase: ${leaked.join("\n")}`).toEqual([]);
  });

  // ── Test 6: round trip ────────────────────────────────────────────────────
  // Drive is the only copy, so reopening has to reproduce the record exactly —
  // including checkbox groups and radios, which are the easy ones to lose.
  //
  // Fails if: any field type does not survive save and reload.
  test("an intake reopens with every answer intact", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();

    await fill(page, "firstName", "Marcus");
    await fill(page, "lastName", "Webb");
    await fill(page, "dob", "1979-04-12");
    await page.locator('#intake-form-fields [name="gender"]').selectOption("Male");
    await page.locator('#intake-form-fields [name="currentSituation"][value="Shelter"]').check();
    await page.locator('#intake-form-fields [name="income"][value="SSI"]').check();
    await page.locator('#intake-form-fields [name="benefits"][value="CalFresh"]').check();
    await page.locator('#intake-form-fields [name="mhDx"][value="PTSD"]').check();
    await page.locator('#intake-form-fields [name="intakeNotes"]').fill("Needs ground floor bed.");

    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    await page.locator("#intake-back-btn").click();
    await expect(page.locator("#intake-list")).toHaveClass(/active/);
    await expect(page.locator("#intake-list-body")).toContainText("Marcus Webb");

    await page.locator(".intake-row-open").first().click();
    await expect(page.locator("#intake-form")).toHaveClass(/active/);

    await expect(page.locator('#intake-form-fields [name="firstName"]')).toHaveValue("Marcus");
    await expect(page.locator('#intake-form-fields [name="lastName"]')).toHaveValue("Webb");
    await expect(page.locator('#intake-form-fields [name="dob"]')).toHaveValue("1979-04-12");
    await expect(page.locator('#intake-form-fields [name="gender"]')).toHaveValue("Male");
    await expect(
      page.locator('#intake-form-fields [name="currentSituation"][value="Shelter"]')
    ).toBeChecked();
    await expect(page.locator('#intake-form-fields [name="income"][value="SSI"]')).toBeChecked();
    await expect(
      page.locator('#intake-form-fields [name="benefits"][value="CalFresh"]')
    ).toBeChecked();
    await expect(
      page.locator('#intake-form-fields [name="income"][value="SSDI"]')
    ).not.toBeChecked();
    await expect(page.locator('#intake-form-fields [name="mhDx"][value="PTSD"]')).toBeChecked();
    await expect(page.locator('#intake-form-fields [name="intakeNotes"]')).toHaveValue(
      "Needs ground floor bed."
    );
  });

  // ── Test 7: a dead Google token holds work, it does not drop it ───────────
  // Tokens last about an hour and an intake can take longer. When one dies
  // mid-form the answers on screen are the only copy in existence — there is no
  // local draft to fall back on. They must be held, the operator told, and the
  // save completed after reconnecting.
  //
  // Fails if: the form is cleared, the tab jumps back to the gate mid-typing, or
  // the held edit is lost after reconnecting.
  test("an expired Google token holds the work and saves it after reconnect", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await fill(page, "firstName", "Priya");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    // Kill the token and refuse silent renewal, as Google does once the browser
    // session is gone or the grant is revoked from the account page.
    await page.evaluate(() => {
      window.__auth.grantSilently = false;
      window.__drive.unauthorized = true;
    });

    await fill(page, "lastName", "Raman");
    await expect(page.locator("#intake-held-bar")).toBeVisible({ timeout: 10000 });
    await expect(savedStatus(page)).toHaveText("WAITING FOR GOOGLE");

    // The operator is still in their form, with their typing on screen.
    await expect(page.locator("#intake-form")).toHaveClass(/active/);
    await expect(page.locator('#intake-form-fields [name="firstName"]')).toHaveValue("Priya");
    await expect(page.locator('#intake-form-fields [name="lastName"]')).toHaveValue("Raman");

    // Reconnect, and the held edit goes to Drive.
    await page.evaluate(() => {
      window.__drive.unauthorized = false;
    });
    await page.locator("#intake-reconnect-btn").click();
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    // Reconnecting must leave them in the form they were filling in, not dump
    // them back on the list to find it again.
    await expect(page.locator("#intake-form")).toHaveClass(/active/);
    await expect(page.locator('#intake-form-fields [name="lastName"]')).toHaveValue("Raman");
    await expect(page.locator("#intake-held-bar")).toBeHidden();

    const stored = await page.evaluate(() => {
      const f = window.__drive.intakeFiles()[0];
      return window.__drive.contentOf(f.id);
    });
    expect(stored.lastName).toBe("Raman");
  });

  // ── Test 8: a second device does not get silently overwritten ─────────────
  // Same class of bug the Supabase autosave had: last-write-wins quietly
  // discarding the other device's work. The head content revision is the guard.
  //
  // Fails if: a save proceeds over a genuinely changed file, or the operator is
  // not told and offered the choice.
  test("refuses to overwrite an intake changed somewhere else", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await fill(page, "firstName", "Ellis");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    // Another device writes the same file — real new bytes, real new revision.
    await page.evaluate(() => {
      const f = window.__drive.intakeFiles()[0];
      window.__drive.writeFromOtherDevice(f.id);
    });

    await fill(page, "lastName", "Nakamura");
    await expect(page.locator("#intake-conflict-bar")).toBeVisible({ timeout: 10000 });
    await expect(savedStatus(page)).toHaveText("NOT SAVED YET");

    // Choosing to keep what was typed here must actually write it.
    await page.locator("#intake-override-btn").click();
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });
    const stored = await page.evaluate(() => {
      const f = window.__drive.intakeFiles()[0];
      return window.__drive.contentOf(f.id);
    });
    expect(stored.lastName).toBe("Nakamura");
  });

  // ── Test 17: reloading the page keeps you connected ───────────────────────
  // Reported from real use: every reload dropped the operator back to a Connect
  // button. The cause was relying on a silent token request at page load —
  // Google's token request opens a popup, and browsers block popups that were
  // not triggered by a click, so it failed every time.
  //
  // Note what makes this test meaningful: page.addInitScript re-runs on reload,
  // which resets the fake Google's grantSilently back to false. So after the
  // reload a silent request CANNOT succeed. If the app still lands on the intake
  // list, the only possible explanation is that it reused a token it had already
  // stored — which is exactly the fix.
  //
  // Fails if: a reload sends the operator back to the gate.
  test("stays connected across a page reload without asking again", async ({ page }) => {
    await openDashboardConnected(page);
    await expect(page.locator("#intake-account-email")).toHaveText("operator@example.org");

    await page.reload();
    await page.getByRole("button", { name: "Intake", exact: true }).click();

    // No clicking Connect. It must already be connected.
    await expect(page.locator("#intake-list")).toHaveClass(/active/, { timeout: 10000 });
    await expect(page.locator("#intake-gate")).not.toHaveClass(/active/);
    await expect(page.locator("#intake-account-email")).toHaveText("operator@example.org");

    // And it is genuinely usable, not just displaying a connected-looking shell.
    await page.locator("#intake-new-btn").click();
    await fill(page, "firstName", "Reload");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });
  });

  // ── Test 18: signing out does not leave a live credential behind ──────────
  // The flip side of remembering the token. On a shared machine, an explicit
  // sign-out must not leave something in localStorage that still reaches the
  // intake records — those are the client files.
  //
  // Fails if: the Drive token survives sign-out.
  test("signing out of the dashboard clears the stored Drive token", async ({ page }) => {
    await openDashboardConnected(page);

    const before = await page.evaluate(() =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith("bethel.drive."))
        .map((k) => !!JSON.parse(localStorage.getItem(k)).token)
    );
    expect(before).toEqual([true]); // a token really was stored

    await page.locator('[data-action="logout"]').click();
    // Wait for the login form rather than the URL: the dev server rewrites
    // /login.html to /login, and that redirect makes waitForURL race the
    // navigation and abort.
    await expect(page.locator("#email")).toBeVisible({ timeout: 10000 });

    const after = await page.evaluate(() =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith("bethel.drive."))
        .map((k) => ({
          token: JSON.parse(localStorage.getItem(k)).token,
          email: JSON.parse(localStorage.getItem(k)).email,
        }))
    );
    // Token gone, but the email is kept so signing back in is one click rather
    // than a fresh Google consent screen.
    expect(after).toHaveLength(1);
    expect(after[0].token).toBeUndefined();
    expect(after[0].email).toBe("operator@example.org");
  });

  // ── Test 16: Drive's own housekeeping is not a conflict ───────────────────
  // The bug that made this whole check worth rewriting. The first version used
  // Drive's `version` field, which the API documents as reflecting "every change
  // made to the file on the server, even those not visible to the user" — our
  // own rename after each save, plus Google's re-indexing. A single operator on
  // a single laptop got told their intake had been "changed somewhere else" by
  // nobody, repeatedly, mid-form.
  //
  // A conflict warning that cries wolf is worse than none: it trains people to
  // dismiss the one that matters.
  //
  // Fails if: server-side churn that leaves the bytes untouched surfaces to the
  // operator as somebody else's edit.
  test("Drive's own metadata churn never looks like someone else's edit", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await fill(page, "firstName", "Solo");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    // Type, and between every save let Drive shuffle `version` underneath us the
    // way it really does. None of this touches the file's content.
    for (const [field, value] of [
      ["lastName", "Operator"],
      ["phone", "9095550100"],
      ["dob", "1985-02-02"],
      ["lastAddress", "Riverside, CA"],
      ["ec1Name", "Pat Operator"],
    ]) {
      await page.evaluate(() => {
        const f = window.__drive.intakeFiles()[0];
        window.__drive.serverSideTouch(f.id);
        window.__drive.serverSideTouch(f.id);
      });
      await fill(page, field, value);
      await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });
      await expect(page.locator("#intake-conflict-bar")).toBeHidden();
    }

    // Everything typed is in Drive, and the operator was never interrupted.
    const stored = await page.evaluate(() => {
      const f = window.__drive.intakeFiles()[0];
      return window.__drive.contentOf(f.id);
    });
    expect(stored.lastName).toBe("Operator");
    expect(stored.ec1Name).toBe("Pat Operator");
    expect(stored.lastAddress).toBe("Riverside, CA");
  });

  // ── Test 9: consecutive saves keep working ────────────────────────────────
  // The Solid Ground packet shipped a version-tracking bug where every save
  // after the first was refused as a conflict, because the version was read back
  // from a different endpoint than the one it was compared against. Typing three
  // separate times is the cheapest possible guard against that returning.
  //
  // Fails if: the second or third edit reports a conflict.
  test("successive edits keep saving without a false conflict", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();

    for (const [field, value] of [
      ["firstName", "Ana"],
      ["lastName", "Duarte"],
      ["phone", "9095550143"],
      ["lastAddress", "Riverside, CA"],
    ]) {
      await fill(page, field, value);
      await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });
      await expect(page.locator("#intake-conflict-bar")).toBeHidden();
    }

    const stored = await page.evaluate(() => {
      const f = window.__drive.intakeFiles()[0];
      return window.__drive.contentOf(f.id);
    });
    expect(stored.lastName).toBe("Duarte");
    expect(stored.lastAddress).toBe("Riverside, CA");
  });

  // ── Test 10: SSN formatting ───────────────────────────────────────────────
  // Carried over from the original form. Fails if digits are not grouped, or the
  // field accepts more than nine.
  test("formats the SSN as it is typed", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();

    const ssn = page.locator('#intake-form-fields [name="ssn"]');
    await ssn.fill("123456789");
    await expect(ssn).toHaveValue("123-45-6789");

    await ssn.fill("12345678901234");
    await expect(ssn).toHaveValue("123-45-6789");
  });

  // ── Test 11: progress reflects required fields ────────────────────────────
  // Fails if: the counter does not move as required fields are filled.
  test("tracks how many required fields are complete", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();

    await expect(page.locator("#intake-progress-text")).toContainText("0 of");
    await fill(page, "firstName", "Sam");
    await expect(page.locator("#intake-progress-text")).toContainText("1 of");
    await fill(page, "lastName", "Ortiz");
    await expect(page.locator("#intake-progress-text")).toContainText("2 of");
  });

  // ── Test 12: removing an intake trashes it rather than destroying it ──────
  // Fails if: the file is hard-deleted, or the list does not update.
  test("removing an intake moves it to Drive trash", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await fill(page, "firstName", "Delete");
    await fill(page, "lastName", "Me");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });
    await page.locator("#intake-back-btn").click();

    page.on("dialog", (d) => d.accept());
    await page.locator(".intake-row-del").first().click();

    await expect(page.locator("#intake-list-body")).toContainText("No intakes yet", {
      timeout: 10000,
    });

    // Still present in Drive, just trashed — recoverable by the operator.
    const state = await page.evaluate(() => {
      const all = [...window.__drive.files.values()].filter(
        (f) => f.mimeType === "application/json"
      );
      return { total: all.length, trashed: all.filter((f) => f.trashed).length };
    });
    expect(state).toEqual({ total: 1, trashed: 1 });
  });

  // ── Test 13: everything lands in one app folder ───────────────────────────
  // drive.file scope means this app can only see what it made. That is only
  // true if it keeps its files together and does not scatter them.
  //
  // Fails if: no app folder is created, or intakes are written outside it.
  test("keeps every intake inside a single app folder", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await fill(page, "firstName", "Folder");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    const layout = await page.evaluate(() => {
      const folders = [...window.__drive.files.values()].filter(
        (f) => f.mimeType === "application/vnd.google-apps.folder"
      );
      const intakes = window.__drive.intakeFiles();
      return {
        folderCount: folders.length,
        folderName: folders[0]?.name,
        allInFolder: intakes.every((f) => f.parents.includes(folders[0]?.id)),
      };
    });
    expect(layout.folderCount).toBe(1);
    expect(layout.folderName).toBe("Bethel Intake Forms");
    expect(layout.allInFolder).toBe(true);
  });

  // ── Test 14: the Drive file is named for the client, and stays that way ───
  // The operator's records have to make sense in Drive itself, not only through
  // this dashboard — otherwise leaving the tool means leaving your files behind
  // as a folder of unreadable JSON.
  //
  // The intake date has no input on the form, so it only survives if it is
  // carried across saves deliberately. Without that, the first autosave strips
  // it and every file in the folder loses its date.
  //
  // Fails if: the file keeps a generic name, or the date falls out of the name
  // after further edits.
  test("names the Drive file after the client and keeps the date", async ({ page }) => {
    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await fill(page, "firstName", "Rosa");
    await fill(page, "lastName", "Iglesias");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    // Keep editing — the date must not be dropped by later saves.
    await fill(page, "phone", "9095550100");
    await fill(page, "lastAddress", "Riverside, CA");
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓", { timeout: 10000 });

    const file = await page.evaluate(() => {
      const f = window.__drive.intakeFiles()[0];
      return { name: f.name, record: window.__drive.contentOf(f.id) };
    });
    expect(file.name).toContain("Iglesias, Rosa");
    expect(file.name).toMatch(/\d{4}-\d{2}-\d{2}\.json$/);
    expect(file.record.intakeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // ── Test 15: a Drive outage is reported, not swallowed ────────────────────
  // Fails if: a failed save silently reports success, which would let an operator
  // close the tab believing an intake was stored when it was not.
  test("a failing Drive is reported and never reads as saved", async ({ page }) => {
    // This one deliberately sits through the whole retry ladder — 2s, then 5s,
    // then 15s — before SAVE FAILED is allowed to appear, because giving up
    // early on a transient Drive blip would be its own bug. That is ~23s of
    // required waiting, which lands on top of the default 30s per-test budget.
    // The extra time is the point of the test, not slack.
    test.setTimeout(90000);

    await openDashboardConnected(page);
    await page.locator("#intake-new-btn").click();
    await expect(savedStatus(page)).toHaveText("SAVED TO DRIVE ✓");

    // Fail every attempt, including the retries.
    await page.evaluate(() => {
      const store = window.__drive;
      Object.defineProperty(store, "failNext", {
        get: () => ({ status: 500 }),
        set: () => {},
      });
    });

    await fill(page, "firstName", "Unsaved");
    await expect(savedStatus(page)).not.toHaveText("SAVED TO DRIVE ✓", { timeout: 5000 });
    await expect(savedStatus(page)).toHaveText("SAVE FAILED", { timeout: 40000 });
  });
});
