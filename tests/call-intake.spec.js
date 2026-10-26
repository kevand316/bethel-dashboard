// tests/call-intake.spec.js
//
// plans/phone-intake.md: the Edge Function the Google Apps Script calls
// (call-intake) and the day-before move-in reminder in daily-reminders.
// Hits the deployed functions like notify.spec.js does. Phones are fictional
// 555-01xx numbers: texts to them are logged, never sent.
// Needs CALL_INTAKE_SECRET and CRON_SECRET in .env.test.

// @ts-check
const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
require("./fixtures/users.js"); // loads .env.test and enforces the project allowlist

const URL_ = process.env.SUPABASE_URL;
const FN = `${URL_}/functions/v1/call-intake`;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const SECRET = { "x-call-intake-secret": process.env.CALL_INTAKE_SECRET || "" };

const P = { houseMgr: "+13105550141", opsMgr: "+13105550142", otherHome: "+13105550143" };
const HOMES = [
  {
    id: 1,
    name: "Test House",
    beds: [{ id: 1, status: "vacant", name: "", rate: 850, moveIn: "" }],
  },
  {
    id: 2,
    name: "Other House",
    beds: [{ id: 1, status: "vacant", name: "", rate: 850, moveIn: "" }],
  },
];

let A, B, originalHomes, originalConn;
const ids = {};

async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}

async function wipe() {
  for (const uid of [A, B]) {
    await admin.from("reports").delete().eq("user_id", uid);
    await admin.from("notification_rules").delete().eq("user_id", uid);
    await admin.from("team_members").delete().eq("user_id", uid);
    await admin.from("team_roles").delete().eq("user_id", uid);
    await admin.from("org_profiles").delete().eq("user_id", uid);
  }
  await admin.from("sms_messages").delete().like("phone", "+1310555014%");
}

async function seed() {
  await admin.from("org_profiles").insert({
    user_id: A,
    org_name: "Alpha Homes",
    timezone: "America/Los_Angeles",
    reminder_hour: 18,
  });
  const { data: hm } = await admin
    .from("team_roles")
    .insert({ user_id: A, name: "House Manager" })
    .select("id")
    .single();
  const { data: om } = await admin
    .from("team_roles")
    .insert({ user_id: A, name: "Operations Manager", notify_all_reports: true })
    .select("id")
    .single();
  const add = async (key, name, phone, role) => {
    const { data } = await admin
      .from("team_members")
      .insert({ user_id: A, name, phone, role_id: role, all_homes: true })
      .select("id")
      .single();
    await admin.from("team_members").update({ status: "active" }).eq("id", data.id);
    ids[key] = data.id;
  };
  await add("houseMgr", "Hal House", P.houseMgr, hm.id);
  await add("opsMgr", "Olga Ops", P.opsMgr, om.id);
  await add("otherHome", "Owen Other", P.otherHome, hm.id);
  await admin.from("notification_rules").insert([
    { user_id: A, bucket: "move_ins_outs", home_id: 1, member_id: ids.houseMgr },
    { user_id: A, bucket: "move_ins_outs", home_id: 2, member_id: ids.otherHome },
  ]);
  await admin
    .from("bethel_data")
    .upsert(
      { id: "homes", user_id: A, data: HOMES, updated_at: new Date().toISOString() },
      { onConflict: "id,user_id" }
    );
}

async function notifiedNames(reportId) {
  const { data } = await admin
    .from("notifications")
    .select("member_name")
    .eq("report_id", reportId);
  return (data || []).map((n) => n.member_name).sort();
}

const moveIn = (request, extra = {}) =>
  request.post(FN, {
    headers: SECRET,
    data: {
      action: "move_in",
      user_id: A,
      client_label: "Test C.",
      home_name: "test house",
      move_in_date: "2026-11-03",
      drive_file_id: "fake-drive-file-1",
      ops_manager_name: "Olga",
      ...extra,
    },
  });

test.describe.serial("call-intake", () => {
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
    originalHomes =
      (
        await admin
          .from("bethel_data")
          .select("data")
          .eq("user_id", A)
          .eq("id", "homes")
          .maybeSingle()
      ).data?.data ?? null;
    originalConn =
      (await admin.from("google_connections").select("*").eq("user_id", A).maybeSingle()).data ??
      null;
    await admin.from("google_connections").delete().eq("user_id", A);
    await wipe();
    await seed();
  });

  test.afterAll(async () => {
    await wipe();
    if (originalHomes) {
      await admin
        .from("bethel_data")
        .update({ data: originalHomes, updated_at: new Date().toISOString() })
        .eq("user_id", A)
        .eq("id", "homes");
    }
    if (originalConn) await admin.from("google_connections").upsert(originalConn);
  });

  test("rejects a missing or wrong secret, and unknown accounts", async ({ request }) => {
    expect((await request.post(FN, { data: { action: "open", user_id: A } })).status()).toBe(403);
    expect(
      (
        await request.post(FN, {
          headers: { "x-call-intake-secret": "wrong" },
          data: { action: "open", user_id: A },
        })
      ).status()
    ).toBe(403);
    expect(
      (
        await request.post(FN, {
          headers: SECRET,
          data: { action: "open", user_id: "00000000-0000-0000-0000-000000000000" },
        })
      ).status()
    ).toBe(404);
  });

  test("open without a Google connection says not_connected", async ({ request }) => {
    const res = await request.post(FN, { headers: SECRET, data: { action: "open", user_id: A } });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe("not_connected");
  });

  test("move_in rejects bad input", async ({ request }) => {
    expect((await moveIn(request, { move_in_date: "11/03/2026" })).status()).toBe(400);
    expect((await moveIn(request, { drive_file_id: "" })).status()).toBe(400);
    expect((await moveIn(request, { client_label: "x".repeat(41) })).status()).toBe(400);
  });

  test("move_in files a report with no roster change and texts the right people", async ({
    request,
  }) => {
    const res = await moveIn(request);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.home_matched).toBe(true);

    const { data: r } = await admin.from("reports").select("*").eq("id", body.report_id).single();
    expect(r.user_id).toBe(A);
    expect(r.source).toBe("call");
    expect(r.bucket).toBe("move_ins_outs");
    expect(r.home_name).toBe("Test House");
    expect(r.title).toContain("Test C. moves in");
    expect(r.details.roster).toBeUndefined(); // no Apply-to-roster buttons
    expect(r.details.call_intake).toMatchObject({
      move_in_date: "2026-11-03",
      drive_file_id: "fake-drive-file-1",
      reminded_at: null,
    });

    // House manager for that home (rule) + ops manager (every report); not the other home's manager.
    expect(await notifiedNames(r.id)).toEqual(["Hal House", "Olga Ops"]);
    const { data: texts } = await admin.from("sms_messages").select("body").eq("phone", P.houseMgr);
    expect(
      texts.some((t) => t.body.includes("New move-in/out") && t.body.includes("(Test House)"))
    ).toBe(true);
  });

  test("the same intake file twice files one report", async ({ request }) => {
    const res = await moveIn(request);
    expect((await res.json()).already).toBe(true);
    const { count } = await admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("user_id", A)
      .eq("details->call_intake->>drive_file_id", "fake-drive-file-1");
    expect(count).toBe(1);
  });

  test("account B sees none of it", async () => {
    const { count } = await admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("user_id", B)
      .eq("source", "call");
    expect(count).toBe(0);
  });

  test("day-before reminder goes out once at the reminder hour", async ({ request }) => {
    const { data: r } = await admin
      .from("reports")
      .select("id")
      .eq("user_id", A)
      .eq("details->call_intake->>drive_file_id", "fake-drive-file-1")
      .single();
    const before = (await notifiedNames(r.id)).length;
    // 2026-11-02 18:05 Pacific (PST) = 2026-11-03 02:05 UTC; move-in is 2026-11-03.
    const run = () =>
      request.post(`${URL_}/functions/v1/daily-reminders`, {
        headers: { "x-cron-secret": process.env.CRON_SECRET },
        data: { now: "2026-11-03T02:05:00Z", user_id: A },
      });
    expect((await run()).status()).toBe(200);
    const { data: after } = await admin.from("reports").select("details").eq("id", r.id).single();
    expect(after.details.call_intake.reminded_at).toBeTruthy();
    expect((await notifiedNames(r.id)).length).toBe(before + 2);
    const { data: texts } = await admin.from("sms_messages").select("body").eq("phone", P.opsMgr);
    expect(
      texts.some(
        (t) => t.body.includes("Reminder: move-in") && t.body.includes("moves in tomorrow")
      )
    ).toBe(true);

    await run(); // a second run in the same hour sends nothing new
    expect((await notifiedNames(r.id)).length).toBe(before + 2);
  });
});
