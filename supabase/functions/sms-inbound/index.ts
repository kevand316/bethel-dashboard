// supabase/functions/sms-inbound/index.ts
// Twilio webhook for the HouseBoss number (plans/sms-reports.md, step 2).
//
// Order of operations, and why:
//   1. Reject anything without a valid Twilio signature.
//   2. Answer Twilio at once and do the work in the background: the AI can take
//      longer than Twilio's 15-second webhook limit. Replies go out via the API.
//   3. Keywords (YES/NO/BLOCK to invites, LEAVE, SWITCH, HELP) are handled by code.
//   4. The account is decided by code from the sender's phone, before the AI runs.
//      The AI never sees another account and has no way to read or write data.
//   5. YES to a finished draft files the report: also code, not the AI.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { deleteMedia, fetchMedia, sendSms, validSignature } from "../_shared/twilio.ts";
import { type Draft, parseAnnouncement, runTurn } from "../_shared/ai.ts";
import { describeRecipients, recentAnnouncementFor, relayReply, resolveAudience, sendAnnouncement } from "../_shared/announce.ts";
import { notifyReport } from "../_shared/notify.ts";

const WEBHOOK_URL = Deno.env.get("SMS_WEBHOOK_URL")!; // the exact URL Twilio calls
const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;

const admin: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Member = {
  id: string; user_id: string; name: string; phone: string; role_id: string;
  all_homes: boolean; home_ids: number[]; status: string; created_at: string;
};
type Conversation = {
  id: string; user_id: string; phone: string; member_id: string;
  history: { from: "staff" | "assistant"; text: string }[];
  // A report draft, or a pending announcement waiting for YES.
  draft: (Draft & { ready?: boolean; kind?: undefined }) |
    { kind: "announcement"; message: string; recipient_ids: string[]; ready: true } | null;
  photos: { path: string; type: string }[];
  status: string; updated_at: string;
};

const word = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const YES = new Set(["YES", "Y", "YEP", "YEAH", "CONFIRM", "OK", "OKAY", "SUBMIT", "SEND"]);
const NO = new Set(["NO", "N", "CANCEL", "NEVERMIND", "STOPIT", "DONTSEND"]);
const ANNOUNCE_RE = /^\s*(announce(ment)?|broadcast|tell (everyone|everybody|all|the team)|send (this )?to (everyone|everybody|all))\b/i;

const HELP_TEXT =
  "HouseBoss: text what happened in your own words and I'll file it. Examples: " +
  "\"toilet leaking upstairs at Oak St\", \"daily report: kitchen and bathrooms cleaned 8am\", " +
  "\"new move-in Marcus, $650 bed\". Reply SWITCH to change organization, LEAVE to leave a team.";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  if (!(await validSignature(WEBHOOK_URL, params, req.headers.get("X-Twilio-Signature")))) {
    return new Response("Invalid signature", { status: 403 });
  }

  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime.waitUntil(
    handle(params).catch((e) => console.error("[sms-inbound] failed:", e)),
  );
  return new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });
});

async function orgName(userId: string): Promise<{ name: string; timezone: string }> {
  const { data } = await admin.from("org_profiles").select("org_name, timezone").eq("user_id", userId).maybeSingle();
  return { name: data?.org_name || "your organization", timezone: data?.timezone || "America/Los_Angeles" };
}

async function handle(p: Record<string, string>) {
  const phone = p.From;
  const body = (p.Body || "").trim();
  const mediaCount = Number(p.NumMedia || 0);

  const { data: inbound } = await admin.from("sms_messages")
    .insert({ direction: "in", phone, body, media_count: mediaCount, twilio_sid: p.MessageSid ?? null, status: "received" })
    .select("id").single();
  const finish = (status: string, userId: string | null = null, error: string | null = null) =>
    admin.from("sms_messages").update({ status, user_id: userId, error }).eq("id", inbound!.id);

  try {
    const { data: rows } = await admin.from("team_members").select("*").eq("phone", phone).order("created_at", { ascending: false });
    const memberships = (rows || []) as Member[];
    const pending = memberships.filter((m) => m.status === "pending");
    const active = memberships.filter((m) => m.status === "active");
    const kw = word(body);

    // ── Invite answers ────────────────────────────────────────────────────────
    if (pending.length && (YES.has(kw) || kw === "NO" || kw === "BLOCK")) {
      const m = pending[0]; // most recent invite
      const org = await orgName(m.user_id);
      if (YES.has(kw)) {
        await admin.from("team_members").update({ status: "active" }).eq("id", m.id).eq("user_id", m.user_id);
        await admin.from("sms_phone_prefs").upsert({ phone, user_id: m.user_id, choosing: false, updated_at: new Date().toISOString() });
        await sendSms(admin, m.user_id, phone,
          `You're on ${org.name}'s HouseBoss team. Text this number anytime to send reports. Text HELP for examples.`);
      } else if (kw === "NO") {
        await admin.from("team_members").update({ status: "declined" }).eq("id", m.id).eq("user_id", m.user_id);
        await sendSms(admin, m.user_id, phone, `Got it. You won't be added to ${org.name}'s team.`);
      } else {
        await admin.from("team_members").update({ status: "blocked" }).eq("id", m.id).eq("user_id", m.user_id);
        await admin.from("sms_blocks").upsert({ phone, user_id: m.user_id });
        await sendSms(admin, m.user_id, phone, `Blocked. ${org.name} can't invite this number again.`);
      }
      return finish("processed", m.user_id);
    }

    // Only people who said YES can text in. Everyone else gets silence.
    if (!active.length) return finish("ignored");

    // ── Which account? ─────────────────────────────────────────────────────────
    const { data: pref } = await admin.from("sms_phone_prefs").select("*").eq("phone", phone).maybeSingle();
    const orgs = await Promise.all(active.map(async (m) => ({ m, org: await orgName(m.user_id) })));
    const askWhich = async () => {
      await admin.from("sms_phone_prefs").upsert({ phone, user_id: pref?.user_id ?? null, choosing: true, updated_at: new Date().toISOString() });
      await sendSms(admin, null, phone,
        "Which organization is this for? " + orgs.map((o, i) => `${i + 1}) ${o.org.name}`).join("  ") + "  Reply with the number.");
    };

    if (active.length > 1 && pref?.choosing && /^\d+$/.test(kw)) {
      const pick = orgs[Number(kw) - 1];
      if (!pick) { await askWhich(); return finish("processed"); }
      await admin.from("sms_phone_prefs").upsert({ phone, user_id: pick.m.user_id, choosing: false, updated_at: new Date().toISOString() });
      await sendSms(admin, pick.m.user_id, phone, `Now texting for ${pick.org.name}. Go ahead.`);
      return finish("processed", pick.m.user_id);
    }
    if (kw === "SWITCH") {
      if (active.length > 1) { await askWhich(); return finish("processed"); }
      await sendSms(admin, active[0].user_id, phone, `You're only on ${orgs[0].org.name}'s team.`);
      return finish("processed", active[0].user_id);
    }

    let member: Member;
    if (active.length === 1) member = active[0];
    else {
      const chosen = active.find((m) => m.user_id === pref?.user_id);
      if (!chosen) { await askWhich(); return finish("processed"); }
      member = chosen;
    }
    const userId = member.user_id;
    const org = orgs.find((o) => o.m.id === member.id)!.org;

    if (kw === "HELP") { await sendSms(admin, userId, phone, HELP_TEXT); return finish("processed", userId); }
    if (kw === "LEAVE") {
      await admin.from("team_members").update({ status: "declined" }).eq("id", member.id).eq("user_id", userId);
      await sendSms(admin, userId, phone, `You've left ${org.name}'s HouseBoss team.`);
      return finish("processed", userId);
    }

    // ── Conversation ───────────────────────────────────────────────────────────
    let note = "";
    const { data: open } = await admin.from("sms_conversations").select("*")
      .eq("user_id", userId).eq("phone", phone).eq("status", "open")
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    let conv = open as Conversation | null;
    if (conv && Date.now() - new Date(conv.updated_at).getTime() > DRAFT_TTL_MS) {
      await admin.from("sms_conversations").update({ status: "expired" }).eq("id", conv.id).eq("user_id", userId);
      if (conv.draft) note = "(Your earlier unfinished report expired and wasn't filed.) ";
      conv = null;
    }
    if (!conv) {
      const { data: created } = await admin.from("sms_conversations")
        .insert({ user_id: userId, phone, member_id: member.id }).select("*").single();
      conv = created as Conversation;
    }

    // Photos go straight to the private bucket, then off Twilio.
    for (let i = 0; i < mediaCount; i++) {
      const url = p[`MediaUrl${i}`];
      if (!url) continue;
      const media = await fetchMedia(url);
      const ext = (media.type.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "");
      const path = `${userId}/drafts/${conv.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await admin.storage.from("report-photos").upload(path, media.bytes, { contentType: media.type });
      if (error) throw new Error(`photo upload failed: ${error.message}`);
      conv.photos.push({ path, type: media.type });
      await deleteMedia(url);
    }

    const { data: role } = await admin.from("team_roles").select("name, can_announce").eq("id", member.role_id).eq("user_id", userId).maybeSingle();
    const save = (fields: Record<string, unknown>) => admin.from("sms_conversations")
      .update({ ...fields, updated_at: new Date().toISOString() }).eq("id", conv!.id).eq("user_id", userId);

    // ── Announcements ──────────────────────────────────────────────────────────
    if (conv.draft?.kind === "announcement") {
      const pendingAnn = conv.draft;
      if (YES.has(kw)) {
        const recipients = (await resolveAudience(admin, userId,
          { everyone: false, roles: [], homes: [], people: [], member_ids: pendingAnn.recipient_ids }, member.id));
        await sendAnnouncement(admin, userId, {
          message: pendingAnn.message, fromName: member.name, senderMemberId: member.id, senderPhone: member.phone,
          recipients, source: "text",
        });
        await save({ status: "filed" });
        await sendSms(admin, userId, phone, `Sent to ${recipients.length} ✓`);
        return finish("processed", userId);
      }
      if (NO.has(kw)) {
        await save({ status: "cancelled" });
        await sendSms(admin, userId, phone, "Not sent.");
        return finish("processed", userId);
      }
      // Anything else: drop the pending announcement and treat this text normally.
      await save({ status: "cancelled" });
      const { data: fresh } = await admin.from("sms_conversations")
        .insert({ user_id: userId, phone, member_id: member.id }).select("*").single();
      conv = fresh as Conversation;
      note = "(Announcement not sent.) ";
    }

    if (ANNOUNCE_RE.test(body)) {
      if (!role?.can_announce) {
        await sendSms(admin, userId, phone, "Your role can't send announcements. Ask the owner to turn it on in the Team tab.");
        return finish("processed", userId);
      }
      const [{ data: roleRows }, { data: people }] = await Promise.all([
        admin.from("team_roles").select("name").eq("user_id", userId),
        admin.from("team_members").select("name").eq("user_id", userId).eq("status", "active"),
      ]);
      const allHomes = await homesFor(userId, { ...member, all_homes: true });
      let parsed;
      try {
        parsed = await parseAnnouncement(body, {
          roles: (roleRows || []).map((r) => r.name), homes: allHomes, people: (people || []).map((p) => p.name),
        });
      } catch (e) {
        console.error("[sms-inbound] announcement parse failed:", e);
        await sendSms(admin, userId, phone, "Sorry, I couldn't process that just now. Please try again in a minute.");
        return finish("failed", userId, String(e));
      }
      const recipients = await resolveAudience(admin, userId,
        { everyone: parsed.everyone, roles: parsed.roles, homes: parsed.home_ids, people: parsed.people }, member.id);
      if (!parsed.message.trim() || !recipients.length) {
        await sendSms(admin, userId, phone, !parsed.message.trim()
          ? "What should the announcement say?"
          : "No one on the team matched that. Try e.g. \"announce to all house managers: ...\"");
        return finish("processed", userId);
      }
      if (conv.draft && !conv.draft.kind) note = "(Your unfinished report was set aside.) ";
      await save({
        draft: { kind: "announcement", message: parsed.message, recipient_ids: recipients.map((r) => r.id), ready: true },
        history: [...conv.history, { from: "staff", text: body }],
      });
      await sendSms(admin, userId, phone,
        `${note}Send to ${describeRecipients(recipients)}: "${parsed.message}"? Reply YES to send or NO to cancel.`);
      return finish("processed", userId);
    }

    // YES to a finished draft: file it.
    if (conv.draft?.ready && !conv.draft.kind && YES.has(kw)) {
      const report = await fileReport(conv as Conversation & { draft: Draft }, member, userId);
      await admin.from("sms_conversations").update({ status: "filed", photos: conv.photos, updated_at: new Date().toISOString() })
        .eq("id", conv.id).eq("user_id", userId);
      const notified = await notifyReport(admin, userId, report);
      const who = notified.map((n) => n.name);
      await sendSms(admin, userId, phone,
        `Submitted ✓ ${report.title}` + (who.length ? `. Notified: ${who.join(", ")}.` : ""));
      return finish("processed", userId);
    }

    const homes = await homesFor(userId, member);
    const ann = await recentAnnouncementFor(admin, userId, member.id);
    const localTime = new Date().toLocaleString("en-US", {
      timeZone: org.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
    });

    let turn;
    try {
      turn = await runTurn({
        orgName: org.name, localTime, sender: { name: member.name, role: role?.name || "" }, homes,
        history: conv.history, draft: conv.draft?.kind ? null : conv.draft, newText: body, photoCount: mediaCount,
        recentAnnouncement: ann ? { from: ann.sender_name || "the office", message: ann.summary, at: ann.created_at } : null,
      });
    } catch (e) {
      console.error("[sms-inbound] AI failed:", e);
      await sendSms(admin, userId, phone, "Sorry, I couldn't process that just now. Please try again in a minute.");
      return finish("failed", userId, String(e));
    }

    // A reply to an announcement goes back to whoever sent it.
    if (turn.announcement_reply && ann) {
      await relayReply(admin, userId, ann, { name: member.name }, body);
      await save({ history: [...conv.history, { from: "staff", text: body }] });
      await sendSms(admin, userId, phone, `Passed along to ${ann.sender_name || "the office"} ✓`);
      return finish("processed", userId);
    }

    let reply = note + turn.reply;
    // Emergencies: the first thing they hear is to call 911, once per conversation.
    const warned = conv.history.some((h) => h.from === "assistant" && h.text.includes("call 911"));
    if (turn.draft?.urgent && !warned) reply = "If anyone is in danger, call 911 now. " + reply;

    const history = [...conv.history, { from: "staff" as const, text: body + (mediaCount ? ` [${mediaCount} photo(s)]` : "") },
      { from: "assistant" as const, text: reply }];
    await admin.from("sms_conversations").update({
      history,
      draft: turn.draft ? { ...turn.draft, ready: turn.ready } : (conv.draft?.kind ? null : conv.draft),
      photos: conv.photos,
      status: turn.cancel ? "cancelled" : "open",
      updated_at: new Date().toISOString(),
    }).eq("id", conv.id).eq("user_id", userId);

    await sendSms(admin, userId, phone, reply);
    return finish("processed", userId);
  } catch (e) {
    console.error("[sms-inbound] error:", e);
    await finish("failed", null, String(e));
  }
}

async function homesFor(userId: string, member: Member): Promise<{ id: number; name: string }[]> {
  const { data } = await admin.from("bethel_data").select("data").eq("user_id", userId).eq("id", "homes").maybeSingle();
  const all = (Array.isArray(data?.data) ? data!.data : []) as { id: number; name: string }[];
  const list = all.map((h) => ({ id: Number(h.id), name: String(h.name) }));
  return member.all_homes ? list : list.filter((h) => member.home_ids.includes(h.id));
}

async function fileReport(conv: Conversation & { draft: Draft }, member: Member, userId: string) {
  const d = conv.draft;
  const homes = await homesFor(userId, { ...member, all_homes: true });
  const home = homes.find((h) => h.id === d.home_id);
  const { data: report, error } = await admin.from("reports").insert({
    user_id: userId,
    bucket: d.bucket,
    subtype: d.subtype,
    urgent: d.urgent,
    home_id: home ? home.id : null,
    home_name: home ? home.name : null,
    title: d.title.slice(0, 200),
    summary: d.summary,
    details: { facts: d.facts, conversation: conv.history },
    sender_member_id: member.id,
    sender_name: member.name,
    sender_phone: member.phone,
    source: "text",
  }).select("*").single();
  if (error) throw new Error(`filing failed: ${error.message}`);

  for (const photo of conv.photos) {
    const dest = photo.path.replace(`/drafts/${conv.id}/`, `/reports/${report.id}/`);
    const { error: moveErr } = await admin.storage.from("report-photos").move(photo.path, dest);
    await admin.from("report_photos").insert({
      user_id: userId, report_id: report.id, storage_path: moveErr ? photo.path : dest, content_type: photo.type,
    });
  }
  return report;
}
