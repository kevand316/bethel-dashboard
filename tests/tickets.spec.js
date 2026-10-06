// tests/tickets.spec.js
//
// plans/tickets.md: report numbers, Open/Resolved tickets, resolving by text
// ("#14 resolved ...", "#14 still pending ...") and on the dashboard.
// Phones are fictional 555-01xx numbers: texts to them are logged, never sent.

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const FN_URL = `${URL_}/functions/v1/sms-inbound`;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const P = { reporter: "+14155550121", fixer: "+14155550122", owner: "+14155550123", other: "+14155550124" };
const PHONES = Object.values(P);
let A, B;
const ids = {};

async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}

async function wipe() {
  for (const uid of [A, B]) {
    await admin.from("reports").delete().eq("user_id", uid);
    await admin.from("notification_rules").delete().eq("user_id", uid);
    await admin.from("sms_conversations").delete().eq("user_id", uid);
    await admin.from("team_members").update({ reports_to: null }).eq("user_id", uid);
    await admin.from("team_members").delete().eq("user_id", uid);
    await admin.from("team_roles").delete().eq("user_id", uid);
    await admin.from("org_profiles").delete().eq("user_id", uid);
  }
  await admin.from("sms_messages").delete().in("phone", PHONES);
  await admin.from("sms_phone_prefs").delete().in("phone", PHONES);
}

async function member(uid, key, name, phone, roleId) {
  const { data } = await admin.from("team_members")
    .insert({ user_id: uid, name, phone, role_id: roleId, all_homes: true }).select("id").single();
  await admin.from("team_members").update({ status: "active" }).eq("id", data.id);
  ids[key] = data.id;
}

async function seed() {
  await admin.from("org_profiles").insert({ user_id: A, org_name: "Alpha Homes", timezone: "America/Los_Angeles" });
  await admin.from("org_profiles").insert({ user_id: B, org_name: "Bravo Living", timezone: "America/Los_Angeles" });
  const role = async (uid, name, every) =>
    (await admin.from("team_roles").insert({ user_id: uid, name, notify_all_reports: every }).select("id").single()).data.id;
  const hm = await role(A, "House Manager", false);
  const owner = await role(A, "Owner", true);
  await member(A, "reporter", "Rita Reporter", P.reporter, hm);
  await member(A, "fixer", "Fred Fixer", P.fixer, hm);
  await member(A, "owner", "Olga Owner", P.owner, owner);
  await member(B, "other", "Ollie Other", P.other, await role(B, "House Manager", false));
}

async function file(uid, report) {
  const { data, error } = await admin.from("reports").insert({
    user_id: uid, source: "text", subtype: null, urgent: false, details: {},
    sender_member_id: ids.reporter, sender_name: "Rita Reporter", sender_phone: P.reporter, ...report,
  }).select("*").single();
  if (error) throw error;
  return data;
}

function sign(params) {
  const data = FN_URL + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN).update(data).digest("base64");
}

// Text the number and wait until the server is done; returns the reply to the sender.
async function text(request, from, body) {
  const sid = "SM" + crypto.randomBytes(16).toString("hex");
  const params = { From: from, To: "+18882677502", Body: body, MessageSid: sid, NumMedia: "0" };
  const started = new Date().toISOString();
  const res = await request.post(FN_URL, { form: params, headers: { "X-Twilio-Signature": sign(params) } });
  expect(res.status()).toBe(200);
  await expect.poll(async () => {
    const { data } = await admin.from("sms_messages").select("status").eq("twilio_sid", sid).maybeSingle();
    return data?.status;
  }, { timeout: 60000, intervals: [500, 1000, 2000] }).not.toMatch(/^(received)?$/);
  const { data: out } = await admin.from("sms_messages").select("body")
    .eq("phone", from).eq("direction", "out").gte("created_at", started).order("created_at");
  return (out || []).at(-1)?.body || "";
}

async function textsTo(phone) {
  const { data } = await admin.from("sms_messages").select("body").eq("phone", phone).eq("direction", "out");
  return (data || []).map((m) => m.body);
}

async function fresh(id) {
  return (await admin.from("reports").select("*").eq("id", id).single()).data;
}

test.describe("@tickets tickets", () => {
  test.describe.configure({ timeout: 120000 });
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(async () => { await wipe(); await seed(); });
  test.afterAll(async () => { await wipe(); });

  test("reports are numbered per account; tickets start Open, other reports have no status", async () => {
    const a1 = await file(A, { bucket: "maintenance", title: "Door off hinges" });
    const a2 = await file(A, { bucket: "cleanings", title: "Daily report" });
    const a3 = await file(A, { bucket: "incidents", title: "Argument" });
    const b1 = await file(B, { bucket: "inventory", title: "Towels", sender_member_id: ids.other });
    expect(a2.ticket_no).toBe(a1.ticket_no + 1);
    expect(a3.ticket_no).toBe(a1.ticket_no + 2);
    expect(b1.ticket_no).toBeGreaterThan(0);
    expect([a1.status, a2.status, a3.status, b1.status]).toEqual(["open", null, "open", "open"]);
  });

  test("the dashboard can't change a ticket number", async () => {
    const r = await file(A, { bucket: "maintenance", title: "Leak" });
    const c = createClient(URL_, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await c.auth.signInWithPassword({ email: process.env.TEST_USER_A_EMAIL, password: process.env.TEST_USER_A_PASSWORD });
    await c.from("reports").update({ ticket_no: 9999 }).eq("id", r.id).eq("user_id", A);
    expect((await fresh(r.id)).ticket_no).toBe(r.ticket_no);
  });

  test("texting '#N resolved' closes it and tells the reporter and owner, not the resolver", async ({ request }) => {
    const r = await file(A, { bucket: "maintenance", title: "Front door off hinges", home_name: "Oak St" });
    const reply = await text(request, P.fixer, `#${r.ticket_no} resolved new hinge installed`);
    expect(reply).toBe(`Ticket #${r.ticket_no} marked resolved ✓`);
    const after = await fresh(r.id);
    expect(after.status).toBe("resolved");
    expect(after.resolved_by).toBe("Fred Fixer");
    expect(after.resolved_at).toBeTruthy();
    expect(after.updates).toEqual([expect.objectContaining({ by: "Fred Fixer", action: "resolved", note: "new hinge installed" })]);
    const msg = `[Alpha Homes] Ticket #${r.ticket_no} resolved by Fred Fixer (Oak St): Front door off hinges. Note: new hinge installed`;
    expect(await textsTo(P.reporter)).toEqual([msg]);
    expect(await textsTo(P.owner)).toEqual([msg]);
    expect(await textsTo(P.fixer)).toEqual([reply]);
  });

  test("texting 'ticket N still pending' keeps it open, logs the note and texts nobody else", async ({ request }) => {
    const r = await file(A, { bucket: "maintenance", title: "Fridge warm" });
    const reply = await text(request, P.fixer, `ticket ${r.ticket_no} still pending - waiting on parts`);
    expect(reply).toBe(`Noted on ticket #${r.ticket_no}: still pending ✓`);
    const after = await fresh(r.id);
    expect(after.status).toBe("open");
    expect(after.updates).toEqual([expect.objectContaining({ by: "Fred Fixer", action: "pending", note: "waiting on parts" })]);
    expect(await textsTo(P.reporter)).toEqual([]);
    expect(await textsTo(P.owner)).toEqual([]);
  });

  test("a report that isn't a ticket, or a number that doesn't exist, is answered plainly", async ({ request }) => {
    const r = await file(A, { bucket: "cleanings", title: "Daily report" });
    expect(await text(request, P.fixer, `#${r.ticket_no} resolved`)).toBe(`#${r.ticket_no} is a cleaning report, not a ticket.`);
    expect(await text(request, P.fixer, "#99999 resolved")).toBe("No ticket #99999.");
  });

  test("@isolation a ticket number from another account can't be touched", async ({ request }) => {
    const r = await file(A, { bucket: "maintenance", title: "A only" });
    expect(await text(request, P.other, `#${r.ticket_no} resolved`)).toBe(`No ticket #${r.ticket_no}.`);
    expect((await fresh(r.id)).status).toBe("open");
  });

  test("dashboard: number and Open on the card, resolve with a note, filter, reopen", async ({ page }) => {
    const r = await file(A, { bucket: "maintenance", title: "Window cracked" });
    await page.route(/accounts\.google\.com/, (x) => x.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    const card = page.locator(".rp-card", { hasText: "Window cracked" });
    await expect(card).toContainText(`#${r.ticket_no}`, { timeout: 10000 });
    await expect(card.locator(".rp-status")).toHaveText("Open");

    await card.click();
    await page.fill("#rpTicketNote", "glass replaced");
    await page.click("#rpResolve");
    await expect(page.locator("#rpDetail .rp-status")).toHaveText("Resolved", { timeout: 10000 });
    await expect(page.locator("#rpDetail")).toContainText("glass replaced");
    const after = await fresh(r.id);
    expect(after.status).toBe("resolved");
    // The reporter hears about it.
    await expect.poll(() => textsTo(P.reporter), { timeout: 15000 })
      .toEqual([`[Alpha Homes] Ticket #${r.ticket_no} resolved: Window cracked. Note: glass replaced`]);

    await page.click("#rpDetailClose");
    await page.selectOption("#rpStatus", "open");
    await expect(page.locator(".rp-card", { hasText: "Window cracked" })).toHaveCount(0);
    await page.selectOption("#rpStatus", "resolved");
    await page.locator(".rp-card", { hasText: "Window cracked" }).click();
    await page.click("#rpReopen");
    await expect(page.locator("#rpDetail .rp-status")).toHaveText("Open", { timeout: 10000 });
    expect((await fresh(r.id)).status).toBe("open");
  });

  test("dashboard tickets fit a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await file(A, { bucket: "maintenance", title: "A long ticket title that should wrap nicely on a phone screen" });
    await page.route(/accounts\.google\.com/, (x) => x.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await page.locator(".rp-card").first().click();
    await expect(page.locator("#rpResolve")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
