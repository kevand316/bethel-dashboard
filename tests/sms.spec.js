// tests/sms.spec.js
//
// Step 2 of plans/sms-reports.md: the texting server (Edge Function sms-inbound).
// Sends signed fake Twilio webhooks to the deployed function and reads results
// back with a server-side (service role) client. All phones are in the fictional
// 555-01xx range, so the function logs replies instead of sending real texts.
//
// These hit the real Claude API for the report conversation (a few cents a run).

// @ts-check
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
require("./fixtures/users.js"); // loads .env.test and enforces the project allowlist

const FN_URL = `${process.env.SUPABASE_URL}/functions/v1/sms-inbound`;
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PHONE = {
  aTester: "+12135550101",
  bTester: "+12135550102",
  invited: "+12135550103",
  shared: "+12135550104",
  stranger: "+12135550199",
};
const ALL_PHONES = Object.values(PHONE);

let A, B; // user ids

async function userId(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email).id;
}

async function wipe() {
  for (const uid of [A, B]) {
    await admin.from("reports").delete().eq("user_id", uid);
    await admin.from("sms_conversations").delete().eq("user_id", uid);
    await admin.from("team_members").delete().eq("user_id", uid);
    await admin.from("team_roles").delete().eq("user_id", uid);
    await admin.from("org_profiles").delete().eq("user_id", uid);
  }
  await admin.from("sms_messages").delete().in("phone", ALL_PHONES);
  await admin.from("sms_phone_prefs").delete().in("phone", ALL_PHONES);
  await admin.from("sms_blocks").delete().in("phone", ALL_PHONES);
}

async function seedAccount(uid, orgName, people) {
  await admin.from("org_profiles").insert({ user_id: uid, org_name: orgName, timezone: "America/Los_Angeles" });
  const { data: role } = await admin.from("team_roles")
    .insert({ user_id: uid, name: "House Manager", can_file_reports: true }).select("id").single();
  for (const [name, phone, status] of people) {
    const { data: m } = await admin.from("team_members")
      .insert({ user_id: uid, name, phone, role_id: role.id, all_homes: true }).select("id").single();
    // The service role may set status; the dashboard never can (see team.spec.js).
    if (status !== "pending") await admin.from("team_members").update({ status }).eq("id", m.id);
  }
}

function sign(params) {
  const data = FN_URL + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN).update(data).digest("base64");
}

// Send a text "from" a phone and wait until the server has finished with it.
// Returns the replies logged for that phone after this text.
async function text(request, from, body) {
  const sid = "SM" + crypto.randomBytes(16).toString("hex");
  const params = { From: from, To: "+18882677502", Body: body, MessageSid: sid, NumMedia: "0" };
  const started = new Date().toISOString();
  const res = await request.post(FN_URL, { form: params, headers: { "X-Twilio-Signature": sign(params) } });
  expect(res.status()).toBe(200);
  let row;
  await expect.poll(async () => {
    const { data } = await admin.from("sms_messages").select("*").eq("twilio_sid", sid).maybeSingle();
    row = data;
    return data?.status;
  }, { timeout: 90000, intervals: [500, 1000, 2000] }).not.toMatch(/^(received)?$/);
  const { data: out } = await admin.from("sms_messages").select("*")
    .eq("phone", from).eq("direction", "out").gte("created_at", started).order("created_at");
  return { inbound: row, replies: out || [], last: (out || []).at(-1)?.body || "" };
}

test.describe("@sms texting server", () => {
  test.describe.configure({ timeout: 300000 });

  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(async () => {
    await wipe();
    await seedAccount(A, "Alpha Homes", [
      ["Alice Tester", PHONE.aTester, "active"],
      ["Ivy Invited", PHONE.invited, "pending"],
      ["Sam Shared", PHONE.shared, "active"],
    ]);
    await seedAccount(B, "Bravo Living", [
      ["Bob Tester", PHONE.bTester, "active"],
      ["Sam Shared", PHONE.shared, "active"],
    ]);
  });
  test.afterAll(async () => { await wipe(); });

  test("unsigned or wrongly signed requests are rejected", async ({ request }) => {
    const params = { From: PHONE.aTester, Body: "hi" };
    expect((await request.post(FN_URL, { form: params })).status()).toBe(403);
    expect((await request.post(FN_URL, { form: params, headers: { "X-Twilio-Signature": "bogus" } })).status()).toBe(403);
  });

  test("a number on no team gets no reply and nothing is stored", async ({ request }) => {
    const r = await text(request, PHONE.stranger, "the sink is broken");
    expect(r.inbound.status).toBe("ignored");
    expect(r.replies).toHaveLength(0);
    const { count } = await admin.from("sms_conversations").select("id", { count: "exact", head: true }).eq("phone", PHONE.stranger);
    expect(count).toBe(0);
  });

  test("YES from an invited phone activates them", async ({ request }) => {
    const r = await text(request, PHONE.invited, "Yes");
    expect(r.last).toContain("Alpha Homes");
    const { data } = await admin.from("team_members").select("status").eq("user_id", A).eq("phone", PHONE.invited).single();
    expect(data.status).toBe("active");
  });

  test("BLOCK stops that account's invites for good", async ({ request }) => {
    await text(request, PHONE.invited, "BLOCK");
    const { data: m } = await admin.from("team_members").select("status").eq("user_id", A).eq("phone", PHONE.invited).single();
    expect(m.status).toBe("blocked");
    const { data: b } = await admin.from("sms_blocks").select("*").eq("user_id", A).eq("phone", PHONE.invited);
    expect(b).toHaveLength(1);
  });

  test("a maintenance report is filed in the right account and bucket after YES", async ({ request }) => {
    let r = await text(request, PHONE.aTester,
      "The upstairs hall bathroom toilet is leaking from the base, water on the floor. Started this morning, needs a plumber today.");
    const answers = [
      "It's the upstairs hall bathroom, leaking from the base, urgent, needs a plumber today.",
      "That's everything, please submit it.",
    ];
    for (const a of answers) {
      if (/Reply YES/i.test(r.last)) break;
      r = await text(request, PHONE.aTester, a);
    }
    expect(r.last).toMatch(/Reply YES/i);
    r = await text(request, PHONE.aTester, "YES");
    expect(r.last).toMatch(/Submitted/);

    const { data: mine } = await admin.from("reports").select("*").eq("user_id", A);
    expect(mine).toHaveLength(1);
    expect(mine[0].bucket).toBe("maintenance");
    expect(mine[0].source).toBe("text");
    expect(mine[0].sender_phone).toBe(PHONE.aTester);
    const { data: theirs } = await admin.from("reports").select("id").eq("user_id", B);
    expect(theirs).toHaveLength(0);
  });

  test("a phone on two teams is asked which, and only that account gets its texts", async ({ request }) => {
    let r = await text(request, PHONE.shared, "HELP");
    expect(r.last).toMatch(/Which organization/);
    const options = r.last.match(/(\d)\) Bravo Living/);
    expect(options).not.toBeNull();
    r = await text(request, PHONE.shared, options[1]);
    expect(r.last).toContain("Bravo Living");
    r = await text(request, PHONE.shared, "HELP");
    expect(r.replies.at(-1).user_id).toBe(B);
    const { data: convA } = await admin.from("sms_conversations").select("id").eq("user_id", A).eq("phone", PHONE.shared);
    expect(convA).toHaveLength(0);
  });

  test("the dashboard owner can read their own text log but not another account's", async () => {
    await admin.from("sms_messages").insert({ user_id: A, direction: "out", phone: PHONE.aTester, body: "A only", status: "test" });
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await client.auth.signInWithPassword({ email: process.env.TEST_USER_B_EMAIL, password: process.env.TEST_USER_B_PASSWORD });
    const { data } = await client.from("sms_messages").select("body").eq("phone", PHONE.aTester);
    expect(data).toHaveLength(0);
    const { data: conv, error } = await client.from("sms_conversations").select("id");
    expect(error ? [] : conv).toHaveLength(0);
  });
});

test.describe("@sms intake by text", () => {
  test.beforeAll(async () => {
    A = await userId(process.env.TEST_USER_A_EMAIL);
    B = await userId(process.env.TEST_USER_B_EMAIL);
  });
  test.beforeEach(async () => {
    await wipe();
    await admin.from("org_profiles").insert({ user_id: A, org_name: "Alpha Homes" });
    const yes = (await admin.from("team_roles").insert({ user_id: A, name: "Intake Staff", can_request_intake: true }).select("id").single()).data.id;
    const no = (await admin.from("team_roles").insert({ user_id: A, name: "Cleaner", can_request_intake: false }).select("id").single()).data.id;
    for (const [name, phone, role] of [["Ina Intake", PHONE.aTester, yes], ["Cal Cleaner", PHONE.invited, no]]) {
      const { data } = await admin.from("team_members").insert({ user_id: A, name, phone, role_id: role, all_homes: true }).select("id").single();
      await admin.from("team_members").update({ status: "active" }).eq("id", data.id);
    }
  });
  test.afterAll(async () => { await wipe(); });

  test("texting 'intake' without texted intakes turned on says how to turn them on; other roles are refused", async ({ request }) => {
    expect((await text(request, PHONE.aTester, "intake")).last)
      .toBe("Texted intakes aren't turned on yet. The owner can turn them on in the Intake tab at houseboss.ai.");
    expect((await text(request, PHONE.invited, "intake")).last).toMatch(/can't request intake links/);
  });
});
