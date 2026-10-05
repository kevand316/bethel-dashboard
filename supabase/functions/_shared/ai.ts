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
};

export type Turn = { reply: string; ready: boolean; cancel: boolean; draft: Draft | null };

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
- title: under 80 characters, e.g. "Upstairs toilet leaking". summary: one or two sentences. facts: the key details as label/value pairs.`;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "ready", "cancel", "draft"],
  properties: {
    reply: { type: "string" },
    ready: { type: "boolean" },
    cancel: { type: "boolean" },
    draft: nullable({
      type: "object",
      additionalProperties: false,
      required: ["bucket", "subtype", "urgent", "home_id", "title", "summary", "facts"],
      properties: {
        bucket: { type: "string", enum: [...BUCKETS] },
        subtype: nullable({ type: "string" }),
        urgent: { type: "boolean" },
        home_id: nullable({ type: "integer" }),
        title: { type: "string" },
        summary: { type: "string" },
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
  // A draft can only be complete with a bucket the code knows and a title.
  if (turn.draft && (!BUCKETS.includes(turn.draft.bucket) || !turn.draft.title?.trim())) turn.ready = false;
  return turn;
}
