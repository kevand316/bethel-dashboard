// supabase/functions/_shared/ai.ts
// The one Claude call in the texting flow. Claude gets the conversation state and
// returns JSON: the reply to text back and the updated report draft. It has no
// tools: it cannot read or write data, and it never chooses the account. Code
// decides all of that before and after this call.

import Anthropic from "npm:@anthropic-ai/sdk";

export const BUCKETS = ["inventory", "incidents", "maintenance", "cleanings", "move_ins_outs"] as const;

export type Draft = {
  bucket: (typeof BUCKETS)[number];
  subtype: string | null;
  urgent: boolean;
  home_id: number | null;
  title: string;
  summary: string;
  facts: { label: string; value: string }[];
  // Filled only for move_ins_outs: what the roster change would be.
  roster: {
    action: "move_in" | "move_out"; resident_name: string; rate: number | null;
    date: string | null; bed_number: number | null;
  } | null;
};

export type Turn = { reply: string; ready: boolean; cancel: boolean; announcement_reply: boolean; draft: Draft | null };

const SYSTEM = `You are the HouseBoss texting assistant. Staff at a housing organization text you in plain language to file reports. Understand what happened, ask short follow-up questions only until you have what is needed, then confirm.

Buckets (pick exactly one):
- incidents: anything that happened with or between clients. subtype: emergency | conflict | complaint | other.
- maintenance: something broken or needing repair. subtype: null.
- cleanings: cleaning done, including the required daily report (what was cleaned, times). subtype: null.
- move_ins_outs: a resident moving in or out. subtype: move_in | move_out.
- inventory: supplies counted, needed, or received. subtype: null.

What each needs before it is complete:
- incidents: what happened, who was involved, when, and what was done (e.g. police or ambulance called).
- maintenance: what is broken, where in the house, and how urgent.
- cleanings: what was cleaned and when.
- move_ins_outs: resident name, move-in or move-out, the date; for move-ins also the bed price if known.
- inventory: items and quantities, and whether needed or received.
Every report also needs a home from the list provided. If the sender covers only one home, use it without asking.

Rules:
- This is SMS. Replies are short and plain: under 300 characters, no markdown, no emojis.
- Never ask for something already said. Ask at most two questions at a time. When you have enough, stop asking.
- Log what you are told as told. Do not warn about or filter health or personal details.
- urgent is true only for emergencies: someone in danger, medical emergency, fire, flood, police needed now.
- Resolve "today", "yesterday", "this morning" using the local date and time given.
- When the draft is complete: ready = true, and the reply is a one-line summary followed by "Reply YES to submit, or tell me what to change."
- If they change something after a summary, update the draft and summarize again.
- If they say cancel, never mind, or similar: cancel = true and reply that nothing was filed.
- If the text is not a report (a question, a greeting), say briefly that you can file reports by text (incidents, maintenance, cleanings, move-ins/outs, inventory) and ask what they want to report. draft stays as it was.
- If photos were sent, say they will be attached.
- For move_ins_outs also fill roster: action (move_in or move_out), resident_name, rate (monthly bed price as a number, move-ins only, null if not said), date (YYYY-MM-DD, resolve "today" etc.), bed_number (only if they named a bed). For every other bucket roster is null.
- title: under 80 characters, e.g. "Upstairs toilet leaking". summary: one or two sentences. facts: the key details as label/value pairs.
- If a recent announcement is shown and the new text is a reply or acknowledgement to it ("got it", "will do", a question about it) rather than a new report, set announcement_reply = true, leave draft as it was, and reply briefly that it was passed along. Otherwise announcement_reply = false.`;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "ready", "cancel", "announcement_reply", "draft"],
  properties: {
    reply: { type: "string" },
    announcement_reply: { type: "boolean" },
    ready: { type: "boolean" },
    cancel: { type: "boolean" },
    draft: nullable({
      type: "object",
      additionalProperties: false,
      required: ["bucket", "subtype", "urgent", "home_id", "title", "summary", "facts", "roster"],
      properties: {
        bucket: { type: "string", enum: [...BUCKETS] },
        subtype: nullable({ type: "string" }),
        urgent: { type: "boolean" },
        home_id: nullable({ type: "integer" }),
        title: { type: "string" },
        summary: { type: "string" },
        roster: nullable({
          type: "object",
          additionalProperties: false,
          required: ["action", "resident_name", "rate", "date", "bed_number"],
          properties: {
            action: { type: "string", enum: ["move_in", "move_out"] },
            resident_name: { type: "string" },
            rate: nullable({ type: "number" }),
            date: nullable({ type: "string" }),
            bed_number: nullable({ type: "integer" }),
          },
        }),
        facts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "value"],
            properties: { label: { type: "string" }, value: { type: "string" } },
          },
        },
      },
    }),
  },
};

export type TurnContext = {
  orgName: string;
  localTime: string;
  sender: { name: string; role: string };
  homes: { id: number; name: string }[];
  history: { from: "staff" | "assistant"; text: string }[];
  draft: Draft | null;
  newText: string;
  photoCount: number;
  recentAnnouncement?: { from: string; message: string; at: string } | null;
};

const client = () => new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

export async function runTurn(ctx: TurnContext): Promise<Turn> {
  const prompt = [
    `Organization: ${ctx.orgName || "(not set)"}`,
    `Local date and time: ${ctx.localTime}`,
    `Sender: ${ctx.sender.name} (${ctx.sender.role})`,
    `Sender's homes (id: name): ${ctx.homes.map((h) => `${h.id}: ${h.name}`).join("; ") || "none listed"}`,
    `Conversation so far:\n${ctx.history.map((m) => `${m.from}: ${m.text}`).join("\n") || "(none)"}`,
    `Current draft: ${ctx.draft ? JSON.stringify(ctx.draft) : "none"}`,
    `Recent announcement received: ${ctx.recentAnnouncement
      ? `from ${ctx.recentAnnouncement.from} at ${ctx.recentAnnouncement.at}: "${ctx.recentAnnouncement.message}"` : "none"}`,
    `New text from ${ctx.sender.name}: ${ctx.newText || "(no text)"}${ctx.photoCount ? ` [sent ${ctx.photoCount} photo(s)]` : ""}`,
  ].join("\n\n");

  // deno-lint-ignore no-explicit-any
  const res: any = await client().beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
    // deno-lint-ignore no-explicit-any
  } as any);

  if (res.stop_reason === "refusal") throw new Error("model refused");
  const text = res.content.find((b: { type: string }) => b.type === "text")?.text;
  if (!text) throw new Error(`no text in response (stop_reason ${res.stop_reason})`);
  const turn = JSON.parse(text) as Turn;
  if (!ctx.recentAnnouncement) turn.announcement_reply = false;
  // A draft can only be complete with a bucket the code knows and a title.
  if (turn.draft && (!BUCKETS.includes(turn.draft.bucket) || !turn.draft.title?.trim())) turn.ready = false;
  return turn;
}

// ── Announcements ─────────────────────────────────────────────────────────────
export type ParsedAnnouncement = {
  message: string;
  everyone: boolean;
  roles: string[];
  home_ids: number[];
  people: string[];
};

const ANNOUNCE_SYSTEM = `Extract an announcement a manager wants texted to their team.
Return the message to send WORD FOR WORD as they wrote it (only drop the instruction part, e.g. "announce to all house managers:"). Do not rephrase, fix, or add anything.
Audience: everyone = true if they said everyone/all/the team/all staff with no narrower group. Otherwise list role names exactly as given in the role list, home ids from the home list, and people's names from the people list. If no audience is named, everyone = true.`;

const ANNOUNCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "everyone", "roles", "home_ids", "people"],
  properties: {
    message: { type: "string" },
    everyone: { type: "boolean" },
    roles: { type: "array", items: { type: "string" } },
    home_ids: { type: "array", items: { type: "integer" } },
    people: { type: "array", items: { type: "string" } },
  },
};

export async function parseAnnouncement(text: string, ctx: {
  roles: string[]; homes: { id: number; name: string }[]; people: string[];
}): Promise<ParsedAnnouncement> {
  const prompt = [
    `Roles: ${ctx.roles.join("; ") || "none"}`,
    `Homes (id: name): ${ctx.homes.map((h) => `${h.id}: ${h.name}`).join("; ") || "none"}`,
    `People: ${ctx.people.join("; ") || "none"}`,
    `Text: ${text}`,
  ].join("\n");
  // deno-lint-ignore no-explicit-any
  const res: any = await client().beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: ANNOUNCE_SCHEMA } },
    system: ANNOUNCE_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    // deno-lint-ignore no-explicit-any
  } as any);
  if (res.stop_reason === "refusal") throw new Error("model refused");
  const out = res.content.find((b: { type: string }) => b.type === "text")?.text;
  if (!out) throw new Error(`no text in response (stop_reason ${res.stop_reason})`);
  return JSON.parse(out) as ParsedAnnouncement;
}
