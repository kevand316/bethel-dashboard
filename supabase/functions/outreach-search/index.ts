// supabase/functions/outreach-search/index.ts
// Outreach tab (plans/outreach.md): find organizations that could refer clients.
// Answers at once with a new list (status "searching"), then searches the web in the
// background with Claude and fills outreach_orgs. Contact details are only ever what
// a page said; anything not found stays null, and every org carries its source URL.

import Anthropic from "npm:@anthropic-ai/sdk";
import { admin, callerId, CORS, json } from "../_shared/http.ts";

const DAILY_CAP = 25;
const MAX_RESUMES = 4;

const str = { type: "string" };
const nul = { anyOf: [{ type: "string" }, { type: "null" }] };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "organizations"],
  properties: {
    summary: str,
    organizations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "category", "address", "phone", "phone_label", "contact_name", "contact_title",
          "email", "website", "source_url", "why"],
        properties: {
          name: str, category: str, address: nul, phone: nul, phone_label: nul, contact_name: nul,
          contact_title: nul, email: nul, website: nul, source_url: str, why: str,
        },
      },
    },
  },
};

const SYSTEM = `You research referral partners for a residential housing provider (sober living / supportive / recuperative housing). The operator wants organizations whose staff could refer clients to them, so they can call and build relationships.

Search the web and return real organizations matching the request in or near the area given. Aim for 10-15 when that many exist; fewer real ones beat padded ones.
Work efficiently: you have about 15 searches and 12 page fetches. Use varied searches (different organization types, nearby cities, "case management", "intake", "referral") rather than repeating one, and fetch an organization's contact or staff page when the search snippet lacks a direct phone, email or contact name.

For each organization:
- name: the organization (and department/program when that's who refers, e.g. "St. Mary Medical Center - Case Management").
- category: a short type, e.g. Hospital, Probation, Behavioral health, Reentry, Homeless services, Veterans, Court, Church, Nonprofit.
- address: street address as published; null if not found.
- phone: the most direct point-of-contact number you can find for referrals: intake line, case management, social work, discharge planning, program coordinator, or a named person's line. Only use the main switchboard when nothing more direct is published. Format (XXX) XXX-XXXX. phone_label: what that number is ("Intake line", "Social work dept.", "Main office").
- contact_name / contact_title: a named person responsible for intake, referrals, case management or partnerships, only if a page names them; else null.
- email: a published email, preferring intake/referral/program addresses; null if none is published.
- website: the organization's site. source_url: the page where you found the contact details.
- why: one short line on why they'd refer clients.

Never guess or construct a phone number, email or name: only what a page you saw states. Use null when unknown. Skip results that are directories or ads rather than an organization.
summary: one or two plain sentences for the operator about what you found and who to call first.`;

type Org = {
  name: string; category: string; address: string | null; phone: string | null; phone_label: string | null;
  contact_name: string | null; contact_title: string | null; email: string | null; website: string | null;
  source_url: string; why: string;
};

const clean = (s: string | null, max = 300) => (s && s.trim() ? s.trim().slice(0, max) : null);
const httpUrl = (s: string | null) => (s && /^https?:\/\//i.test(s.trim()) ? s.trim().slice(0, 500) : null);

async function search(query: string, area: string): Promise<{ summary: string; organizations: Org[] }> {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{
    role: "user",
    content: `Find: ${query}\nArea: ${area || "(not given: ask nothing, search broadly in the US and say so in the summary)"}`,
  }];
  for (let i = 0; i <= MAX_RESUMES; i++) {
    // deno-lint-ignore no-explicit-any
    const res: any = await client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 15 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 12 },
      ],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages,
      // deno-lint-ignore no-explicit-any
    } as any).finalMessage();
    if (res.stop_reason === "pause_turn") {
      // The server-side search loop paused; send its turn so far back and it resumes.
      const sofar = messages[1]?.content ?? [];
      messages.splice(1, 1, { role: "assistant", content: [...sofar, ...res.content] });
      continue;
    }
    if (res.stop_reason === "refusal") throw new Error("refused");
    // deno-lint-ignore no-explicit-any
    const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    if (!text) throw new Error(`no answer (stop_reason ${res.stop_reason})`);
    return JSON.parse(text);
  }
  throw new Error("search ran too long");
}

async function run(userId: string, listId: string, query: string, area: string) {
  try {
    const out = await search(query, area);
    const rows = (out.organizations || []).filter((o) => clean(o.name)).slice(0, 25).map((o, i) => ({
      user_id: userId, list_id: listId, sort: i,
      name: clean(o.name, 200)!, category: clean(o.category, 60), address: clean(o.address),
      phone: clean(o.phone, 40), phone_label: clean(o.phone_label, 80),
      contact_name: clean(o.contact_name, 120), contact_title: clean(o.contact_title, 120),
      email: clean(o.email, 200)?.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/) ? clean(o.email, 200) : null,
      website: httpUrl(o.website), source_url: httpUrl(o.source_url) ?? httpUrl(o.website), why: clean(o.why, 300),
    }));
    if (rows.length) {
      const { error } = await admin.from("outreach_orgs").insert(rows);
      if (error) throw new Error(`save failed: ${error.message}`);
    }
    await admin.from("outreach_lists").update({ status: "done", summary: clean(out.summary, 1000) ?? "" })
      .eq("id", listId).eq("user_id", userId);
  } catch (e) {
    console.error("[outreach-search]", e);
    await admin.from("outreach_lists").update({
      status: "failed", error: "The search didn't finish. Try again in a minute, or word it a little differently.",
    }).eq("id", listId).eq("user_id", userId);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerId(req);
  if (!userId) return json({ error: "Not signed in" }, 401);

  const body = await req.json().catch(() => ({}));
  const query = String(body.query || "").trim().slice(0, 300);
  const area = String(body.area || "").trim().slice(0, 120);
  if (!query) return json({ error: "Type what kind of organization to look for." }, 400);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await admin.from("outreach_lists").select("id", { count: "exact", head: true })
    .eq("user_id", userId).gte("created_at", since);
  if ((count ?? 0) >= DAILY_CAP) {
    return json({ error: `You've used all ${DAILY_CAP} searches a day. Try again tomorrow.` }, 429);
  }

  const { data: list, error } = await admin.from("outreach_lists")
    .insert({ user_id: userId, query, area, status: "searching" }).select("*").single();
  if (error) return json({ error: "Couldn't start the search." }, 500);

  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime.waitUntil(run(userId, list.id, query, area));
  return json({ ok: true, list });
});
