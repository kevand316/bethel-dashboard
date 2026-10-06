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

export type Turn = {
  intent: "rent" | "report" | "ticket" | "other";
  reply: string; ready: boolean; cancel: boolean; announcement_reply: boolean; draft: Draft | null;
  // Rent payments and "who owes" questions are extracted here and handled by code.
  rent: { kind: "payment" | "question"; resident_name: string | null; amount: number | null; month: string | null; home_id: number | null } | null;
  // An update to an existing open ticket, matched by description; code confirms with the sender.
  ticket: { ticket_nos: number[]; action: "resolved" | "pending"; note: string } | null;
};

const SYSTEM = `You are the HouseBoss texting assistant. Staff at a housing organization text you in plain language for one of two jobs:
(A) RENT: a resident paid rent ("Grant paid his rent", "Marcus paid 300", "Grant paid his October rent"), or a question about who owes rent ("who owes rent?", "who hasn't paid at Oak St?").
(B) REPORTS: anything else that happened (incidents, maintenance, cleaning, move-ins/outs, inventory).
(C) TICKET UPDATE: news about a problem that was ALREADY reported and is in the open tickets list: it's been fixed/handled/taken care of ("the front door at Oak St is fixed", "plumber came, sink works"), or it's still waiting ("still waiting on parts for the dryer").

Set intent first: "rent" for (A), "report" for (B), "ticket" for (C), "other" for greetings or anything else.
For (C) TICKET UPDATE: fill the ticket field and do nothing else; leave draft exactly as it was (or null), ready = false, reply = "". Code confirms with the sender.
- action = "resolved" if it's fixed/done/handled, "pending" if it's still waiting or in progress. note = what they said was done or what it's waiting on, in a few words ("" if nothing).
- ticket_nos = the open tickets it could be about, best match first: one number when it clearly fits one ticket; two or three when several fit about equally (e.g. two door tickets and they didn't say which home); [] when none of the open tickets fit. Only numbers from the open tickets list.
- Something newly broken or a new problem is a REPORT (B), even if a similar ticket is open. Only completion or status news about an existing problem is (C).
If intent is not "ticket", ticket = null.
For (A) RENT: fill the rent field and do nothing else. kind = payment or question. resident_name as written (null for questions). amount = the number paid, or null if they didn't say (means paid in full). month = YYYY-MM only if they named a month (e.g. "October rent" in 2026 = 2026-10), else null. home_id only if they named a home. Leave draft exactly as it was (or null), ready = false, reply = "". Code does the rest.
A move-in or move-out is a report, not rent, even if a price is mentioned.

For (B) REPORTS: rent = null. Understand what happened, ask short follow-up questions only until you have what is needed, then confirm.

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
- For reports, always return the draft with everything known so far, even while still asking questions. draft is never null once a report has started.
- When the draft is complete: ready = true, and the reply is a one-line summary followed by "Reply YES to submit, or tell me what to change." ready = true always comes with the full draft.
- If they change something after a summary, update the draft and summarize again.
- If they say cancel, never mind, or similar: cancel = true and reply that nothing was filed.
- If the text is neither rent nor a report (a question, a greeting), say briefly that you can file reports by text (incidents, maintenance, cleanings, move-ins/outs, inventory) and ask what they want to report. draft stays as it was.
- If photos were sent, say they will be attached.
- For move_ins_outs also fill roster: action (move_in or move_out), resident_name, rate (monthly bed price as a number, move-ins only, null if not said), date (YYYY-MM-DD, resolve "today" etc.), bed_number (only if they named a bed). For every other bucket roster is null.
- title: under 80 characters, e.g. "Upstairs toilet leaking". summary: one or two sentences. facts: the key details as label/value pairs.
- If a recent announcement is shown and the new text is a reply or acknowledgement to it ("got it", "will do", a question about it) rather than a new report, set announcement_reply = true, leave draft as it was, and reply briefly that it was passed along. Otherwise announcement_reply = false.`;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "rent", "ticket", "reply", "ready", "cancel", "announcement_reply", "draft"],
  properties: {
    // Decided first: the JSON is generated in this order, so the model commits to
    // what kind of text this is before filling anything else.
    intent: { type: "string", enum: ["rent", "report", "ticket", "other"] },
    ticket: nullable({
      type: "object",
      additionalProperties: false,
      required: ["ticket_nos", "action", "note"],
      properties: {
        ticket_nos: { type: "array", items: { type: "integer" } },
        action: { type: "string", enum: ["resolved", "pending"] },
        note: { type: "string" },
      },
    }),
    rent: nullable({
      type: "object",
      additionalProperties: false,
      required: ["kind", "resident_name", "amount", "month", "home_id"],
      properties: {
        kind: { type: "string", enum: ["payment", "question"] },
        resident_name: nullable({ type: "string" }),
        amount: nullable({ type: "number" }),
        month: nullable({ type: "string" }),
        home_id: nullable({ type: "integer" }),
      },
    }),
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
  openTickets?: { no: number; title: string; home: string | null; summary: string; by: string | null; at: string }[];
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
    `Open tickets (#number · home · title · summary · reported by · when):\n${(ctx.openTickets || []).map((t) =>
      `#${t.no} · ${t.home || "no home"} · ${t.title} · ${t.summary.slice(0, 160)} · ${t.by || "dashboard"} · ${t.at.slice(0, 10)}`).join("\n") || "(none)"}`,
    `New text from ${ctx.sender.name}: ${ctx.newText || "(no text)"}${ctx.photoCount ? ` [sent ${ctx.photoCount} photo(s)]` : ""}`,
  ].join("\n\n");

  // deno-lint-ignore no-explicit-any
  const ask = async (messages: any[]): Promise<Turn> => {
    // deno-lint-ignore no-explicit-any
    const res: any = await client().beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
      // deno-lint-ignore no-explicit-any
    } as any);
    if (res.stop_reason === "refusal") throw new Error("model refused");
    const out = res.content.find((b: { type: string }) => b.type === "text")?.text;
    if (!out) throw new Error(`no text in response (stop_reason ${res.stop_reason})`);
    return JSON.parse(out) as Turn;
  };

  const first = [{ role: "user", content: prompt }];
  let turn = await ask(first);
  // A summary asking for YES with no draft behind it would make YES file nothing.
  // Ask once more, showing the model its own answer; never let it through as ready.
  if (turn.intent === "report" && (turn.ready || /reply yes/i.test(turn.reply)) && !turn.draft) {
    turn = await ask([...first, { role: "assistant", content: JSON.stringify(turn) },
      { role: "user", content: "Your answer asks for YES but draft is null. Return the same answer with the complete draft filled in." }]);
    if (!turn.draft) turn.ready = false;
  }
  if (!ctx.recentAnnouncement) turn.announcement_reply = false;
  if (turn.intent !== "rent") turn.rent = null;
  if (turn.intent !== "ticket") turn.ticket = null;
  // Only tickets that were actually offered, and at most three.
  if (turn.ticket) {
    const offered = new Set((ctx.openTickets || []).map((t) => t.no));
    turn.ticket.ticket_nos = [...new Set(turn.ticket.ticket_nos)].filter((n) => offered.has(n)).slice(0, 3);
  }
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
