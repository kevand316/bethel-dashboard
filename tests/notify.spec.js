// tests/notify.spec.js
//
// Step 4 of plans/sms-reports.md: who gets texted about a report, delivery status
// callbacks, daily report reminders, and the Team tab's notification rules.
// Phones are fictional 555-01xx numbers: texts to them are logged, never sent.

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { signIn } = require("./fixtures/users.js");

const URL_ = process.env.SUPABASE_URL;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const P = {
  worker: "+13105550111",
  boss: "+13105550112",
  bigBoss: "+13105550113",
  handy: "+13105550114",
  pendingPerson: "+13105550115",
};

let A, B;
const ids = {};

async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}

async function signedInClient(email, password) {
  const c = createClient(URL_, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email, password });
  return c;
}

async function wipe() {
  for (const uid of [A, B]) {
    await admin.from("reports").delete().eq("user_id", uid);
    await admin.from("notification_rules").delete().eq("user_id", uid);
    await admin.from("reminder_log").delete().eq("user_id", uid);
    await admin.from("team_members").update({ reports_to: null }).eq("user_id", uid);
    await admin.from("team_members").delete().eq("user_id", uid);
    await admin.from("team_roles").delete().eq("user_id", uid);
    await admin.from("org_profiles").delete().eq("user_id", uid);
  }
  await admin.from("sms_messages").delete().like("phone", "+1310555%");
}

async function seed() {
  await admin.from("org_profiles").insert({ user_id: A, org_name: "Alpha Homes", timezone: "America/Los_Angeles" });
  const { data: hm } = await admin.from("team_roles")
    .insert({ user_id: A, name: "House Manager", daily_report_required: true }).select("id").single();
  const { data: om } = await admin.from("team_roles")
    .insert({ user_id: A, name: "Operations Manager" }).select("id").single();
  const add = async (key, name, phone, role, reportsTo, status = "active") => {
    const { data } = await admin.from("team_members").insert({
      user_id: A, name, phone, role_id: role, all_homes: true, reports_to: reportsTo ?? null,
    }).select("id").single();
    if (status !== "pending") await admin.from("team_members").update({ status }).eq("id", data.id);
    ids[key] = data.id;
  };
  await add("bigBoss", "Kev Big", P.bigBoss, om.id);
  await add("boss", "Dana Boss", P.boss, om.id, ids.bigBoss);
  await add("worker", "James Worker", P.worker, hm.id, ids.boss);
  await add("handy", "Hank Handy", P.handy, om.id);
  await add("pending", "Pat Pending", P.pendingPerson, om.id, null, "pending");
}

async function fileAsA(report) {
  const { data } = await admin.from("reports").insert({
    user_id: A, source: "dashboard", subtype: null, urgent: false, details: {},
    sender_member_id: ids.worker, sender_name: "James Worker", sender_phone: P.worker, ...report,
  }).select("*").single();
  const c = await signedInClient(process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
  const res = await c.functions.invoke("notify-report", { body: { report_id: data.id } });
  return { report: data, res };
}

async function notifiedPhones(reportId) {
  const { data } = await admin.from("notifications").select("phone").eq("report_id", reportId);
  return (data || []).map((n) => n.phone).sort();
}

test.describe("@notify notifications and reminders", () => {
  test.describe.configure({ timeout: 120000 });
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(async () => { await wipe(); await seed(); });
  test.afterAll(async () => { await wipe(); });

  test("a normal report texts the sender's supervisor only", async () => {
    const { report, res } = await fileAsA({ bucket: "maintenance", title: "Sink clogged", home_name: "Oak St" });
    expect(res.error).toBeNull();
    expect(await notifiedPhones(report.id)).toEqual([P.boss]);
    const { data: log } = await admin.from("sms_messages").select("body").eq("phone", P.boss);
    expect(log[0].body).toBe("[Alpha Homes] New maintenance report from James Worker (Oak St): Sink clogged");
  });

  test("an urgent report texts the whole chain of command", async () => {
    const { report } = await fileAsA({ bucket: "incidents", subtype: "emergency", urgent: true, title: "Ambulance called" });
    expect(await notifiedPhones(report.id)).toEqual([P.boss, P.bigBoss].sort());
    const { data: log } = await admin.from("sms_messages").select("body").eq("phone", P.bigBoss);
    expect(log[0].body).toMatch(/^\[Alpha Homes\] URGENT incident from James Worker: Ambulance called$/);
  });

  test("notification rules add people by bucket; pending people and the sender never get one", async () => {
    await admin.from("notification_rules").insert([
      { user_id: A, bucket: "maintenance", home_id: null, member_id: ids.handy },
      { user_id: A, bucket: null, home_id: null, member_id: ids.pending },
      { user_id: A, bucket: null, home_id: null, member_id: ids.worker },
    ]);
    const m = await fileAsA({ bucket: "maintenance", title: "Fridge warm" });
    expect(await notifiedPhones(m.report.id)).toEqual([P.boss, P.handy].sort());
    const c = await fileAsA({ bucket: "cleanings", title: "Daily report" });
    expect(await notifiedPhones(c.report.id)).toEqual([P.boss]);
  });

  test("a report is never notified twice", async () => {
    const { report } = await fileAsA({ bucket: "inventory", title: "Towels" });
    const c = await signedInClient(process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await c.functions.invoke("notify-report", { body: { report_id: report.id } });
    expect(await notifiedPhones(report.id)).toEqual([P.boss]);
  });

  test("@isolation another account cannot trigger notifications for your report", async () => {
    const { data } = await admin.from("reports").insert({
      user_id: A, bucket: "maintenance", title: "A only", source: "dashboard", sender_member_id: ids.worker,
    }).select("id").single();
    const c = await signedInClient(process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);
    const res = await c.functions.invoke("notify-report", { body: { report_id: data.id } });
    expect(res.error).not.toBeNull();
    expect(await notifiedPhones(data.id)).toEqual([]);
  });

  test("Twilio delivery callbacks update the notification status", async ({ request }) => {
    const { report } = await fileAsA({ bucket: "maintenance", title: "Status check" });
    const sid = "SM" + crypto.randomBytes(16).toString("hex");
    await admin.from("notifications").update({ twilio_sid: sid }).eq("report_id", report.id);
    const url = `${URL_}/functions/v1/sms-status`;
    const params = { MessageSid: sid, MessageStatus: "delivered" };
    const sig = crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN)
      .update(url + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
    expect((await request.post(url, { form: params })).status()).toBe(403);
    expect((await request.post(url, { form: params, headers: { "X-Twilio-Signature": sig } })).status()).toBe(200);
    const { data } = await admin.from("notifications").select("status").eq("report_id", report.id).single();
    expect(data.status).toBe("delivered");
  });

  test("daily reminders: nudge at reminder time once, escalate to the supervisor next morning", async ({ request }) => {
    const call = (now) => request.post(`${URL_}/functions/v1/daily-reminders`, {
      headers: { "x-cron-secret": process.env.CRON_SECRET }, data: { now, user_id: A },
    });
    expect((await request.post(`${URL_}/functions/v1/daily-reminders`, { data: {} })).status()).toBe(403);

    // 9:05pm Pacific on 2026-10-05 is 04:05Z on the 6th.
    expect((await call("2026-10-06T04:05:00Z")).status()).toBe(200);
    await call("2026-10-06T04:20:00Z"); // same hour again: no second nudge
    const { data: nudges } = await admin.from("sms_messages").select("body").eq("phone", P.worker);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].body).toMatch(/daily report hasn't come in/);

    // 8:05am Pacific on the 6th is 15:05Z.
    await call("2026-10-06T15:05:00Z");
    const { data: esc } = await admin.from("sms_messages").select("body").eq("phone", P.boss);
    expect(esc.map((m) => m.body)).toContain("[Alpha Homes] James Worker didn't send yesterday's daily report.");
  });

  test("a daily report filed in time means no reminder", async ({ request }) => {
    await admin.from("reports").insert({
      user_id: A, bucket: "cleanings", title: "Daily", source: "text", sender_member_id: ids.worker,
      created_at: "2026-10-05T23:00:00Z", // 4pm Pacific on the 5th
    });
    await request.post(`${URL_}/functions/v1/daily-reminders`, {
      headers: { "x-cron-secret": process.env.CRON_SECRET }, data: { now: "2026-10-06T04:05:00Z", user_id: A },
    });
    const { data } = await admin.from("sms_messages").select("body").eq("phone", P.worker);
    expect(data).toHaveLength(0);
  });

  test("Team tab: add a notification rule and see who was notified on a report", async ({ page }) => {
    await page.route(/accounts\.google\.com/, (r) => r.abort());
    await signIn(page, process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await page.getByRole("button", { name: "Team", exact: true }).click();
    await expect(page.locator("#nrMember option", { hasText: "Hank Handy" })).toHaveCount(1, { timeout: 10000 });
    await page.selectOption("#nrBucket", "maintenance");
    await page.selectOption("#nrMember", { label: "Hank Handy" });
    await page.click("#nrAdd");
    await expect(page.locator(".nr-row", { hasText: "Hank Handy" })).toContainText(/maintenance/i, { timeout: 10000 });
    const { data: rules } = await admin.from("notification_rules").select("bucket, member_id").eq("user_id", A);
    expect(rules).toEqual([{ bucket: "maintenance", member_id: ids.handy }]);

    // Daily-report switch is shown per role.
    await expect(page.locator('.tm-role', { hasText: "House Manager" }).locator('input[data-perm="daily_report_required"]')).toBeChecked();

    const { report } = await fileAsA({ bucket: "maintenance", title: "Window cracked" });
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await page.locator(".rp-card", { hasText: "Window cracked" }).click();
    await expect(page.locator("#rpDetail")).toContainText("Notified", { timeout: 10000 });
    await expect(page.locator("#rpDetail")).toContainText("Dana Boss");
    await expect(page.locator("#rpDetail")).toContainText("Hank Handy");
    expect(report.id).toBeTruthy();
  });
});
