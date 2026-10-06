// supabase/functions/ai-edit/index.ts
// Edit with AI tab (plans/edit-with-ai.md): turn a typed request into a list of
// proposed changes to the caller's own roster. This function WRITES NOTHING to the
// roster — the dashboard previews the changes, and on Apply saves them through its
// normal autosave path. The only write here is one usage row for the daily cap.

import Anthropic from "npm:@anthropic-ai/sdk";
import { admin, callerId, CORS, json } from "../_shared/http.ts";

const DAILY_CAP = 100;
const MAX_BODY = 300_000; // bytes; a large roster is well under this

const TYPES = [
  "add_expense", "update_expense", "remove_expense", "set_startup_cost",
  "add_home", "rename_home", "add_beds", "update_bed", "remove_bed",
];

const nul = (t: string, extra: Record<string, unknown> = {}) => ({ anyOf: [{ type: t, ...extra }, { type: "null" }] });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "changes"],
  properties: {
    reply: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "home_id", "home_name", "expense_name", "new_name", "category", "amount",
          "bed_id", "status", "resident_name", "move_in", "count"],
        properties: {
          type: { type: "string", enum: TYPES },
          home_id: nul("integer"),
          home_name: nul("string"),
          expense_name: nul("string"),
          new_name: nul("string"),
          category: nul("string"),
          amount: nul("number"),
          bed_id: nul("integer"),
          status: nul("string", { enum: ["occupied", "recup", "vacant", "manager"] }),
          resident_name: nul("string"),
          move_in: nul("string"),
          count: nul("integer"),
        },
      },
    },
  },
};

const SYSTEM = `You help a sober-living / residential home operator change their own dashboard by typing plain requests.
You are given their homes as JSON. Turn the request into changes using ONLY these types; leave every field a type doesn't use as null.

- add_expense: home_id, expense_name, category, amount (monthly dollars). Prefer a category the home already uses; otherwise a short one like Utilities, Supplies, Software, Staff, Admin, Housing, Maintenance, Food, Other.
- update_expense: home_id, expense_name (EXACTLY as it appears in that home), and whichever of amount / new_name / category change. Rent is an expense named "Rent".
- remove_expense: home_id, expense_name (exact).
- set_startup_cost: home_id, amount (one-time setup cost).
- add_home: home_name, count (beds, default 1), amount (rate per bed, null = 850).
- rename_home: home_id, new_name.
- add_beds: home_id, count, amount (rate per bed, null = 850).
- update_bed: home_id, bed_id, and whichever of status / resident_name / amount (monthly rate) / move_in (YYYY-MM-DD) change. Statuses: occupied, recup (recuperative care, $3,000+), vacant, manager (house lead). Moving someone in = status occupied + resident_name. Moving out = status vacant + resident_name "".
- remove_bed: home_id, bed_id. Only vacant beds can be removed.

To change a home added in the same request, give its home_name and home_id null.
Match homes loosely by street number or name ("Maple" = "12 Maple Ave."). If the same request applies to several homes ("all homes"), emit one change per home.
If the request is unclear, ambiguous between homes or people, or asks for something outside these types (deleting a whole home, rent payments, reports, team), return no changes and say briefly in reply what you need or that it's done elsewhere: rent payments on the Rent tab, deleting a home on Operations.
reply: one or two short plain sentences for a non-technical user summarizing what you're proposing (they will see each change listed and press Apply). Never claim anything is already done.`;

type Bed = { id: number; status: string; name: string; rate: number; moveIn: string; managerType?: string };
type Home = { id: number; name: string; startupCost?: number; beds: Bed[]; expenses: { cat: string; name: string; amount: number }[] };

const summary = (homes: Home[]) => homes.map((h) => ({
  id: h.id, name: h.name, startupCost: h.startupCost ?? 0,
  beds: (h.beds || []).map((b) => ({ id: b.id, status: b.status, name: b.name, rate: b.rate, moveIn: b.moveIn })),
  expenses: (h.expenses || []).map((e) => ({ name: e.name, category: e.cat, amount: e.amount })),
}));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "That's too much to send at once." }, 413);
  let body: { message?: string; history?: { from: string; text: string }[]; homes?: Home[] };
  try { body = JSON.parse(raw); } catch { return json({ error: "Bad request" }, 400); }
  const message = String(body.message || "").trim().slice(0, 4000);
  if (!message) return json({ error: "Type what you'd like changed." }, 400);
  if (!Array.isArray(body.homes)) return json({ error: "Bad request" }, 400);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await admin.from("ai_edit_usage").select("id", { count: "exact", head: true })
    .eq("user_id", userId).gte("created_at", since);
  if ((count ?? 0) >= DAILY_CAP) {
    return json({ error: `You've reached today's limit of ${DAILY_CAP} requests. It resets over the next 24 hours.` }, 429);
  }
  await admin.from("ai_edit_usage").insert({ user_id: userId });

  const history = (Array.isArray(body.history) ? body.history : []).slice(-10)
    .map((m) => `${m.from === "assistant" ? "assistant" : "user"}: ${String(m.text || "").slice(0, 2000)}`).join("\n");
  const prompt = [
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    `Homes: ${JSON.stringify(summary(body.homes))}`,
    `Conversation so far:\n${history || "(none)"}`,
    `New request: ${message}`,
  ].join("\n\n");

  try {
    // deno-lint-ignore no-explicit-any
    const res: any = await new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! }).beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
      // deno-lint-ignore no-explicit-any
    } as any);
    if (res.stop_reason === "refusal") return json({ reply: "I can't help with that one.", changes: [] });
    const out = res.content.find((b: { type: string }) => b.type === "text")?.text;
    if (!out) throw new Error(`no text (stop_reason ${res.stop_reason})`);
    const parsed = JSON.parse(out);
    return json({ reply: String(parsed.reply || ""), changes: Array.isArray(parsed.changes) ? parsed.changes : [] });
  } catch (e) {
    console.error("[ai-edit]", (e as Error).message);
    return json({ error: "The AI didn't answer. Try again in a moment." }, 502);
  }
});
