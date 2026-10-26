# Phone Intake & Call Follow-Up Automation — Build Plan

**Owner:** Kev (Bethel Residency / HouseBoss.AI) · **Written:** 2026-10-26 · **Status:** approved design, not yet built
**Repo:** `kevand316/bethel-dashboard` (HouseBoss.AI). Save this file as `plans/phone-intake.md` in that repo.

Claude Code: read `CLAUDE.md` first. Everything in its Standards and Guardrails applies here (TDD for anything touching data, never weaken RLS, never commit secrets, full Playwright suite green before deploy). The operator is non-technical. Make technical decisions yourself and explain them plainly. The steps marked **[Kev]** are the only ones that need him: sign-ins, money, legal agreements, and admin settings he approves in chat.

---

## 1. What this does

Any Google Voice call where staff tap **Notes** gets processed automatically. Nobody has to lift a finger after the call.

**Intake calls** (staff screen the caller off the record, then tap Notes for the intake questions):

1. The full call transcript is pulled from Google Vault.
2. Gemini (Vertex AI) fills in the **existing HouseBoss intake form** from the transcript.
3. The intake is saved to the **same "HouseBoss Intake Forms" Drive folder**, in the same format, so it opens in the **HouseBoss Intake tab** like any other intake.
4. Kev's rules build a **checklist**. Example: a mental health diagnosis with no treatment produces "Connect to a local behavioral health provider (e.g., Jefferson Wellness)".
5. A **PDF** (intake + checklist + anything still missing) is saved to that folder and emailed to the operations manager.
6. **HouseBoss texts** the people who get move-in reports (house manager for that home, operations manager, owner):
   - **the day the intake is processed:** "New move-in/out #12 (Grand Ave): John D. moves in Thu 10/29. Call Marcus for details."
   - **the day before move-in:** "Reminder: move-in (Grand Ave): John D. moves in tomorrow."

**Any other recorded call** (referral partners, families, vendors):

7. Gemini reads the transcript for anything staff **committed to** on the call ("I'll email you more information about our organization", "I'll call you Tuesday") and creates it:
   - **Emails:** a Gmail draft in info@ with Kev's signature and the right documents from the Documents library attached. It is not auto-sent unless Kev turns that on (see 7.3).
   - **Reminders:** a Google Calendar event at the right time.
8. The staff member who took the call gets one email: "From your call with Jasmine (RCH): draft ready, reminder set for Tue 9:00 AM."

Failures never pass silently. If a call can't be processed after three tries, Kev gets an email and a HouseBoss text.

## 2. The design rules (don't change them without asking Kev)

| Rule | Why |
|---|---|
| **Client information stays in Google Workspace.** Transcripts, intake answers, PDFs, drafts and calendar events live only in Gmail, Drive, Vault, Calendar and Vertex AI, all covered by Google's BAAs. HouseBoss (Supabase/Twilio, no BAA) receives only a first name + last initial, the home, the move-in date and a Drive file id. | Same rule HouseBoss was built on (`INTAKE-SETUP.md`, `lib/drive.js`). |
| **Claude never handles real client data.** Claude builds and tests with fake data only. In production everything runs inside Google with no Claude in the loop. | Anthropic's BAA does not cover Claude in Chrome or Claude Code computer use. |
| **Nothing is made up.** Gemini may only fill a field or create an action if it can quote the transcript words that support it, and the script verifies the quote is really in the transcript. Unsupported answers are dropped and flagged. Unanswered required fields print as **NOT CAPTURED** in red. | Kev's standing rule: never make anything up. |
| **The checklist comes from rules, not AI judgment.** Same answers always give the same checklist. Kev edits the rules in a Google Sheet. | Predictable, explainable, editable without code. |
| **Outside emails are drafts by default.** | AI-written mail to partners goes out only after a person taps Send, unless Kev switches it to auto-send. |
| **Vault is the transcript source.** | The Voice notes email holds only a summary. Vault's call-log export includes the full transcript when Note Taking is on, covers every staff member's calls, and needs no email watching or forwarding. Speed isn't a concern because move-ins are days out. |

Sources checked 2026-10-26:
- Take notes for me (Voice): https://support.google.com/voice/answer/16968663
- Admin setup for Voice AI notes: https://knowledge.workspace.google.com/admin/voice/let-google-voice-take-ai-notes-for-my-users
- Vault + Voice ("if a call enables Note Taking, the corresponding call log entry can include transcripts and notes"): https://knowledge.workspace.google.com/vault/search/use-vault-to-search-google-voice
- Vault export contents: https://knowledge.workspace.google.com/vault/exports/vault-export-contents
- Vault API Voice covered data (TEXT_MESSAGES, VOICEMAILS, CALL_LOGS): https://developers.google.com/workspace/vault/reference/rest/v1/VoiceCoveredData
- Editions with Vault (Business Plus and up, not Business Standard): https://knowledge.workspace.google.com/admin/vault/about-upgrading-to-an-edition-that-includes-vault
- Anthropic BAA coverage: https://support.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers

## 3. Architecture

```
Call (staff tap Notes)
   │
   ▼
Google Voice ──► Vault (holds call log + full transcript)
                    │  every 30 min
                    ▼
        Apps Script "HouseBoss Call Automation"  (runs as info@bethelresidency.com)
          1. Vault export: Voice CALL_LOGS since last run (2-hour overlap, deduped)
          2. Download + unzip + read each call's transcript
          3. ONE Gemini call per transcript (Vertex AI) → call type, intake fields, actions
          4. Intake calls:
               - ask HouseBoss for a short-lived Drive pass ("open")
               - save intake JSON + PDF + transcript into "HouseBoss Intake Forms"
               - email PDF to the operations manager
               - tell HouseBoss "move_in" (label, home, date, file id)
          5. Every call: Gmail drafts + Calendar reminders for staff commitments
          6. One summary email to the staff member who took the call
          7. One row per call in the "Calls Log" sheet
                    │
                    ▼
   HouseBoss Edge Function `call-intake`
          - files a Move-ins/outs report (source "call", no roster change)
          - texts via the existing notifyReport() rules
   HouseBoss `daily-reminders` (already runs every 15 min)
          - at the org's reminder hour: texts the day-before move-in reminder
```

Pieces to build: **1 Apps Script project, 1 Google Sheet, 1 new Edge Function, 1 small migration, 3 small edits to existing HouseBoss code.** No always-on laptop, no Gmail watching, no forwarding rules.

The HouseBoss Drive pass works the same way as the texted intake link (`supabase/functions/intake-link`, `lib/intake-link.js`). The server trades the owner's stored `drive.file` refresh token for a 1-hour access token, and the client writes to Drive itself. Files created with that token belong to the HouseBoss OAuth app, so the Intake tab lists and opens them. No intake answers ever pass through Supabase.

---

## 4. One-time setup runbook

Do these in order. Claude runs each step in the browser on Kev's Mac. Where a step says **[Kev]**, stop and ask him in chat.

### A. Google Workspace Admin (admin.google.com, signed in as info@bethelresidency.com)

1. **[Kev] Upgrade Workspace from Business Standard to Business Plus**, which includes Vault. Show Kev the exact per-user price on the upgrade screen and get a yes before clicking. Alternative: Google says Vault add-on licenses exist for compatible editions through Google Sales. Mention it, but only if Kev wants to ask.
2. **[Kev] Confirm the Google Workspace HIPAA BAA is accepted** (Account → Legal and compliance). If it isn't, show Kev the amendment and get a yes before accepting.
3. **Turn on Gemini notes for Voice** ([Kev] approve the settings change): Apps → Google Workspace → Google Voice → Settings → Policies → **On-demand call recording: On**, **Gemini notes: On**, announcement: default ("This call is being recorded and captured by AI"). Also confirm Generative AI → Gemini for Workspace is on and Smart features are enabled. (Source: the admin page linked above.)
4. **Licenses:** confirm every person who takes intake calls (Kev, Rodney) has a Google Voice Standard license.
5. **Vault access:** open vault.google.com as info@. A super admin has Vault privileges. If access is denied, give info@ a Vault role with Manage Matters + Export ([Kev] approve).

### B. Google Cloud: a new, internal project for the script

Use a **new** project, not the HouseBoss project (`909342292895`). The HouseBoss OAuth app is "External" and publishing broad Gmail/Vault scopes on it would trigger Google verification. An **Internal** project (only bethelresidency.com users) needs no verification.

1. console.cloud.google.com → New project **`bethel-call-automation`** under the bethelresidency.com organization.
2. **[Kev] Link billing** (Vertex AI is pay-per-use. Show Kev the billing screen; no price figures from memory).
3. **[Kev] Accept the Google Cloud HIPAA BAA** for the organization if it isn't already. Find the current link on Google's "HIPAA compliance on Google Cloud" page, and confirm in Google's current HIPAA covered-products list that the Vertex AI generative AI service is on it. If it isn't covered, stop and tell Kev.
4. **Enable APIs:** Vertex AI API, Google Vault API, Gmail API, Apps Script API.
5. **OAuth consent screen:** User type **Internal**, app name "HouseBoss Call Automation", support email info@.
6. **Pick the model:** Vertex AI → Model Garden → the newest **generally available** Gemini Pro model. Record its model ID for `GEMINI_MODEL`. Don't use preview models with client data.
7. **Vertex location:** `us-central1` unless the model page says otherwise. Use `global` only if the model is offered only there (the code handles both).

### C. HouseBoss changes (repo `bethel-dashboard`). See section 5 for the code.

1. `git pull`, branch `feature/phone-intake`.
2. Migration `023_call_intake.sql`.
3. `_shared/notify.ts`: add optional `lead`.
4. New Edge Function `call-intake`.
5. `daily-reminders`: add the day-before move-in reminder.
6. `lib/intake-form.js`: add the two screening fields.
7. `tools/export-intake-fields.mjs`: generates the Apps Script field list from the form.
8. Tests (section 5.8), prettier, full Playwright suite green.
9. Generate the shared secret: `openssl rand -hex 32`. `supabase secrets set CALL_INTAKE_SECRET=<value>`. Never commit it.
10. Deploy: `supabase functions deploy call-intake --no-verify-jwt` (it authenticates with the shared secret, like `daily-reminders`), `supabase functions deploy daily-reminders`, then push to main for Pages once tests are green.
11. In HouseBoss as Kev: **Intake tab → "Allow texted intakes" must be On**, connected to **info@bethelresidency.com** (the Drive where Intake Forms live). That's what lets the server mint the Drive pass.
12. **Team page:** make sure each home has a notification rule for **Move-ins/outs → that home's house manager**. The Operations Manager and Owner roles already get every report (migration 018).

### D. Apps Script project

1. **[Kev]** script.google.com/home/usersettings → **Google Apps Script API: On** (signed in as info@).
2. In the repo: create `apps-script/call-automation/` with the files from section 6. Run `node tools/export-intake-fields.mjs` to generate `IntakeFields.gs`.
3. **[Kev signs in]** `npx @google/clasp login` (as info@), then:
   `npx @google/clasp create --type standalone --title "HouseBoss Call Automation" --rootDir apps-script/call-automation`
   `npx @google/clasp push`
   Commit `.clasp.json`; the script id isn't a secret.
4. Script editor → Project Settings → **Change Google Cloud project** → the project **number** of `bethel-call-automation`.
5. Project Settings → **Script properties** (secrets live here, never in code):

   | Property | Value |
   |---|---|
   | `GCP_PROJECT_ID` | `bethel-call-automation` (the project **id**) |
   | `VERTEX_LOCATION` | `us-central1` |
   | `GEMINI_MODEL` | the model id from B6 |
   | `HB_FUNCTION_URL` | `https://yqgccykbdihsjqlapghr.supabase.co/functions/v1/call-intake` |
   | `HB_SECRET` | the CALL_INTAKE_SECRET from C9 |
   | `HB_USER_ID` | Kev's HouseBoss account id (Supabase auth user id) |

6. **[Kev approves the Google consent screen]** Run `setup()` once from the editor. It creates the **HouseBoss Call Automation** sheet in info@'s Drive, the Vault matter, and the 30-minute trigger.
7. Fill in the sheet (section 7): Settings (operations manager email and name), Staff, Documents (upload the organization one-pager and other send-able documents into a Drive folder and list them).
8. Run `checkSetup()`. Every line must say OK.

### E. First test (fake client only). See section 8.

---

## 5. HouseBoss code

### 5.1 Migration `migrations/023_call_intake.sql`

Before applying, confirm the constraint's real name:
`SELECT conname FROM pg_constraint WHERE conrelid = 'public.reports'::regclass AND contype = 'c';`
If it isn't `reports_source_check`, use the real name.

```sql
-- =============================================================================
-- Migration: 023_call_intake.sql
-- Date:      2026-10-26
-- Plan:      plans/phone-intake.md
--
-- Reports filed by the phone-intake automation (Edge Function call-intake) carry
-- source 'call'. They are ordinary Move-ins/outs reports with no roster change;
-- details.call_intake holds {move_in_date, drive_file_id, client_label, reminded_at}.
-- Only a first name + last initial is stored. No intake answers.
--
-- IDEMPOTENT.
-- ROLLBACK: UPDATE public.reports SET source = 'dashboard' WHERE source = 'call';
--           then re-add the check without 'call'; DROP INDEX IF EXISTS reports_call_intake_date_idx;
-- =============================================================================
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_source_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_source_check
  CHECK (source IN ('text', 'dashboard', 'calculator', 'call'));

CREATE INDEX IF NOT EXISTS reports_call_intake_date_idx
  ON public.reports (user_id, ((details -> 'call_intake' ->> 'move_in_date')))
  WHERE bucket = 'move_ins_outs';
```

Also grep `index.html` for where report `source` is displayed or filtered. Show `call` as "Call" wherever `text`/`dashboard` are labelled.

### 5.2 `supabase/functions/_shared/notify.ts`: optional lead

Change the signature and the two body lines. Everything else stays the same.

```ts
export async function notifyReport(
  admin: SupabaseClient,
  userId: string,
  report: Report,
  opts: { lead?: string } = {},
) {
  // ...unchanged...
  const lead = opts.lead ?? `New ${what}`;
  const body = report.urgent
    ? `[${orgName}] URGENT ${what}${from}${where}: ${report.title}`
    : `[${orgName}] ${lead}${from}${where}: ${report.title}`;
  // ...unchanged...
}
```

### 5.3 New Edge Function `supabase/functions/call-intake/index.ts`

```ts
// supabase/functions/call-intake/index.ts
// Server side of the phone-intake automation (plans/phone-intake.md).
// Called only by the Google Apps Script "HouseBoss Call Automation", which
// authenticates with the shared secret CALL_INTAKE_SECRET (deploy --no-verify-jwt).
//
//   {action:"open"}    -> {access_token, expires_in, homes}
//        A short-lived drive.file token minted from the owner's "Allow texted
//        intakes" consent, exactly like intake-link. The script saves the intake
//        straight into the HouseBoss Intake Forms folder with it, so the Intake
//        tab lists it. No intake answers ever reach this function.
//   {action:"move_in", client_label, home_name, move_in_date, drive_file_id, ops_manager_name?}
//        Files a Move-ins/outs report (no roster change; the bed is assigned in
//        person) and texts whoever gets move-in reports. daily-reminders texts
//        them again the day before. Receives only first name + last initial.
//   {action:"alert"}   -> texts Owner-role members that a call needs a look.

import { admin, json } from "../_shared/http.ts";
import { accessFromRefresh } from "../_shared/google.ts";
import { notifyReport } from "../_shared/notify.ts";
import { sendSms } from "../_shared/twilio.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function homeList(userId: string): Promise<{ id: number; name: string }[]> {
  const { data } = await admin.from("bethel_data").select("data").eq("user_id", userId).eq("id", "homes").maybeSingle();
  return (Array.isArray(data?.data) ? data!.data : [])
    .filter((h: { name?: string }) => h?.name)
    .map((h: { id: number; name: string }) => ({ id: Number(h.id), name: h.name }));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameSecret(req.headers.get("x-call-intake-secret") || "", Deno.env.get("CALL_INTAKE_SECRET") || "")) {
    return json({ error: "Forbidden" }, 403);
  }
  const body = await req.json().catch(() => ({}));
  const userId = String(body.user_id || "");
  const { data: org } = await admin.from("org_profiles").select("user_id, org_name").eq("user_id", userId).maybeSingle();
  if (!org) return json({ error: "unknown account" }, 404);

  if (body.action === "open") {
    const { data: conn } = await admin.from("google_connections").select("refresh_token").eq("user_id", userId).maybeSingle();
    if (!conn) return json({ error: "not_connected" }, 409);
    let google;
    try {
      google = await accessFromRefresh(conn.refresh_token);
    } catch (e) {
      // Revoked consent: the owner has to click "Allow texted intakes" again.
      if ((e as { code?: string }).code === "invalid_grant") {
        await admin.from("google_connections").delete().eq("user_id", userId);
      }
      return json({ error: "not_connected" }, 409);
    }
    const homes = (await homeList(userId)).map((h) => h.name);
    return json({ access_token: google.access_token, expires_in: google.expires_in, homes });
  }

  if (body.action === "move_in") {
    const label = String(body.client_label || "").trim();
    const date = String(body.move_in_date || "");
    const fileId = String(body.drive_file_id || "");
    if (!label || label.length > 40 || !DATE.test(date) || !fileId || fileId.length > 200) {
      return json({ error: "bad request" }, 400);
    }
    // A retried run sending the same intake again files nothing new.
    const { data: dup } = await admin.from("reports").select("id")
      .eq("user_id", userId).eq("bucket", "move_ins_outs")
      .eq("details->call_intake->>drive_file_id", fileId).maybeSingle();
    if (dup) return json({ ok: true, report_id: dup.id, already: true });

    const wanted = norm(String(body.home_name || ""));
    const home = (await homeList(userId)).find((h) => norm(h.name) === wanted);
    const when = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
      weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC",
    });
    const ops = String(body.ops_manager_name || "").trim().slice(0, 40);
    const title = `${label} moves in ${when}.${ops ? ` Call ${ops} for details.` : ""}`;

    const { data: report, error } = await admin.from("reports").insert({
      user_id: userId,
      bucket: "move_ins_outs",
      subtype: "upcoming_move_in",
      home_id: home?.id ?? null,
      home_name: home?.name ?? null,
      title,
      summary: "From a recorded intake call. The full intake is in the Intake tab.",
      details: { call_intake: { move_in_date: date, drive_file_id: fileId, client_label: label, reminded_at: null } },
      source: "call",
    }).select("*").single();
    if (error) return json({ error: error.message }, 500);

    const notified = await notifyReport(admin, userId, report);
    return json({ ok: true, report_id: report.id, notified, home_matched: !!home });
  }

  if (body.action === "alert") {
    const [{ data: roles }, { data: members }] = await Promise.all([
      admin.from("team_roles").select("id").eq("user_id", userId).eq("name", "Owner"),
      admin.from("team_members").select("phone, status, role_id").eq("user_id", userId),
    ]);
    const ownerRoles = new Set((roles || []).map((r: { id: string }) => r.id));
    const text = `[${org.org_name}] A recorded call couldn't be processed automatically. Check the Calls Log sheet.`;
    let sent = 0;
    for (const m of members || []) {
      if (m.status === "active" && ownerRoles.has(m.role_id)) {
        await sendSms(admin, userId, m.phone, text);
        sent++;
      }
    }
    return json({ ok: true, sent });
  }

  return json({ error: "unknown action" }, 400);
});
```

### 5.4 `supabase/functions/daily-reminders/index.ts`: day-before move-in reminder

Add the import:

```ts
import { notifyReport } from "../_shared/notify.ts";
```

Inside the `for (const org of orgs || [])` loop, **after** the line `if (hour !== org.reminder_hour && hour !== org.escalation_hour) continue;` and **before** the roles/members query, add:

```ts
    // Day-before move-in reminders for intakes that came in by phone
    // (plans/phone-intake.md). Same people as the original move-in text.
    if (hour === org.reminder_hour) {
      const tomorrow = addDays(today, 1);
      const { data: upcoming } = await admin.from("reports").select("*")
        .eq("user_id", org.user_id).eq("bucket", "move_ins_outs")
        .eq("details->call_intake->>move_in_date", tomorrow)
        .is("details->call_intake->>reminded_at", null);
      for (const r of upcoming || []) {
        const ci = r.details.call_intake;
        // Claim first so two overlapping runs can't both text.
        const { data: claimed } = await admin.from("reports")
          .update({ details: { ...r.details, call_intake: { ...ci, reminded_at: new Date().toISOString() } } })
          .eq("user_id", org.user_id).eq("id", r.id)
          .is("details->call_intake->>reminded_at", null).select("id");
        if (!claimed?.length) continue;
        await notifyReport(admin, org.user_id, { ...r, title: `${ci.client_label} moves in tomorrow.` },
          { lead: "Reminder: move-in" });
        sent.push(`move-in-reminder:${r.id}`);
      }
    }
```

### 5.5 `lib/intake-form.js`: the two screening questions

Kev screens for these on every call and the form doesn't have them yet. **Add** them; never rename existing fields (that would break saved intakes). In the `medical` section, after `onMedication`:

```js
        {
          name: "medCompliant",
          label: "Medication Compliant?",
          type: "select",
          options: ["Yes", "No", "N/A – No Medications"],
        },
```

and after `physicalHealth`:

```js
        {
          name: "adlIndependent",
          label: "Can Complete All ADLs Independently?",
          type: "select",
          options: ["Yes", "No – Needs Some Help", "No – Needs Significant Help"],
        },
```

### 5.6 `tools/export-intake-fields.mjs`: one source of truth for the field list

The Apps Script must use exactly the form's field names and choices. Generate it from the form; never hand-copy. Re-run whenever `lib/intake-form.js` changes, then `clasp push`.

```js
// tools/export-intake-fields.mjs
// Generates apps-script/call-automation/IntakeFields.gs from lib/intake-form.js so
// the phone automation fills exactly the fields the Intake tab shows.
// Usage: node tools/export-intake-fields.mjs
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const src = fs.readFileSync(new URL("lib/intake-form.js", root), "utf8");
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { SECTIONS } = ctx.window.intakeForm;

const sections = SECTIONS.map((s) => ({
  title: s.title,
  fields: s.fields
    .filter((f) => f.name)
    .map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: !!f.required,
      ...(f.dynamic ? { dynamic: f.dynamic } : {}),
      ...(f.options ? { options: f.options.map((o) => (typeof o === "string" ? o : o.value)) } : {}),
    })),
}));

const out =
  "// IntakeFields.gs: GENERATED from bethel-dashboard/lib/intake-form.js by\n" +
  "// tools/export-intake-fields.mjs. Do not edit by hand.\n" +
  `const INTAKE_SECTIONS = ${JSON.stringify(sections, null, 2)};\n` +
  "const INTAKE_FIELDS = INTAKE_SECTIONS.reduce((all, s) => all.concat(s.fields), []);\n";

const dir = new URL("apps-script/call-automation/", root);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(new URL("IntakeFields.gs", dir), out);
console.log(`Wrote ${sections.reduce((n, s) => n + s.fields.length, 0)} fields to apps-script/call-automation/IntakeFields.gs`);
```

Add `apps-script/` to `.prettierignore` if prettier fights `.gs` files.

### 5.7 Dashboard display

No new UI is required. Call intakes show in the Intake tab (they're normal intake files in the folder), and the move-in report shows in Reports like any other. Optional polish: a small "Call" badge on reports with `source === 'call'`.

### 5.8 Tests (write first; follow the patterns in `tests/sms.spec.js` and `tests/intake-link.spec.js`)

`tests/call-intake.spec.js`:
1. Wrong or missing `x-call-intake-secret` → 403. Unknown `user_id` → 404.
2. `open` with no Google connection → 409 `not_connected`.
3. `move_in` with bad date / missing file id / label over 40 chars → 400.
4. `move_in` valid → one `move_ins_outs` report, `source = 'call'`, `details.call_intake` stored, **no** `details.roster` (no roster buttons). Texts go to rule-matched and notify-all members. Use the fictional 555-01xx numbers so nothing is really sent.
5. Same `drive_file_id` twice → one report, second response `already: true`.
6. Isolation: the account in `user_id` is the only one touched. Account B sees nothing (RLS).
7. `daily-reminders` with `{"now": ...}` at the reminder hour the day before → one reminder text per recipient and `reminded_at` set. Run again → no second text.
8. Intake tab: the two new fields render, save, and reload (extend `tests/intake.spec.js`).

---

## 6. Apps Script code: `apps-script/call-automation/`

Files: `appsscript.json`, `Config.gs`, `Main.gs`, `Vault.gs`, `Transcript.gs`, `Gemini.gs`, `Intake.gs`, `Rules.gs`, `Pdf.gs`, `HouseBoss.gs`, `Actions.gs`, `Sheet.gs`, `Setup.gs`, plus the generated `IntakeFields.gs`.

### 6.1 `appsscript.json`

```json
{
  "timeZone": "America/Los_Angeles",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "dependencies": {
    "enabledAdvancedServices": [{ "userSymbol": "Gmail", "serviceId": "gmail", "version": "v1" }]
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/ediscovery",
    "https://www.googleapis.com/auth/devstorage.read_only",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/calendar"
  ]
}
```

### 6.2 `Config.gs`

```js
/** Config.gs: settings, shared helpers. Secrets live in Script Properties, never in code. */
const TZ = 'America/Los_Angeles';
const P = PropertiesService.getScriptProperties();
const ROOT_FOLDER_NAME = 'HouseBoss Intake Forms';   // same as lib/drive.js
const LEGACY_FOLDER_NAME = 'Bethel Intake Forms';    // pre-rebrand name; dashboard renames it
const MIN_TRANSCRIPT_CHARS = 300;                    // shorter = a plain call log with no notes (confirm at first test)

function cfg(key, fallback) {
  const v = P.getProperty(key);
  if (v == null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Missing script property ' + key);
  }
  return v;
}

/** Lowercase, unify dashes, collapse spaces: so "Yes - Felony" matches "Yes – Felony". */
function norm_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[‒-―]/g, '-').replace(/\s+/g, ' ').trim();
}

function isBlank_(v) {
  return v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
}

function show_(v) {
  return Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v);
}

function fmtTime_(d) {
  return Utilities.formatDate(d, TZ, 'EEE M/d h:mm a');
}

function fmtDate_(ymd) {
  if (!ymd) return '';
  return Utilities.formatDate(Utilities.parseDate(ymd, TZ, 'yyyy-MM-dd'), TZ, 'EEE M/d');
}

function sha_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 32);
}

/** Per-call step markers, so a retried run never repeats a finished step. */
function stepDone_(key) { return P.getProperty('STEP:' + key) === '1'; }
function markStep_(key) { P.setProperty('STEP:' + key, '1'); }
function clearSteps_(callId) {
  const all = P.getProperties();
  Object.keys(all).forEach(function (k) { if (k.indexOf('STEP:' + callId) === 0) P.deleteProperty(k); });
}

/** Tell Kev something needs a look: email + HouseBoss text. No client details in either.
 *  The same message goes out at most once every 6 hours. */
function alert_(msg) {
  const key = 'ALERT:' + sha_(msg);
  if (Date.now() - Number(P.getProperty(key) || 0) < 6 * 3600 * 1000) return;
  P.setProperty(key, String(Date.now()));
  try {
    GmailApp.sendEmail(setting_('ALERT_EMAIL'), 'HouseBoss call automation needs attention',
      msg + '\n\nCalls Log: ' + sheetUrl_());
  } catch (e) { console.error('alert email failed', e); }
  try { hbCall_('alert', {}); } catch (e) { console.error('alert text failed', e); }
}
```

### 6.3 `Main.gs`

```js
/** Main.gs: the 30-minute pipeline. Entry point: runPipeline (time trigger). */
const RUN_BUDGET_MS = 4.5 * 60 * 1000;     // Apps Script stops a run at 6 minutes
const OVERLAP_MS = 2 * 3600 * 1000;        // re-ask Vault for the last 2h each time; the log skips repeats

function runPipeline() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  const started = Date.now();
  try {
    const pendingId = P.getProperty('PENDING_EXPORT_ID');
    if (!pendingId) { startExport_(); return; }

    const exp = getExport_(pendingId);
    if (exp.status === 'IN_PROGRESS') return;
    if (exp.status !== 'COMPLETED') {
      clearExport_(pendingId);
      alert_('A Vault export did not complete (' + exp.status + '). The next run will try again.');
      return;
    }

    const calls = readExportCalls_(exp);
    const log = loadLog_();
    let finished = true;
    for (let i = 0; i < calls.length; i++) {
      if (log.isDone(calls[i].id)) continue;
      if (Date.now() - started > RUN_BUDGET_MS) { finished = false; break; }
      processCallSafely_(calls[i], log);
    }
    // Only move the window forward once every call in this export is handled.
    // Otherwise the next run picks up where this one stopped (same export).
    if (finished) {
      const end = new Date(P.getProperty('PENDING_EXPORT_END'));
      P.setProperty('WINDOW_START', new Date(end.getTime() - OVERLAP_MS).toISOString());
      clearExport_(pendingId);
    }
  } catch (e) {
    alert_('The call pipeline hit an error: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function processCallSafely_(call, log) {
  const attempts = log.attempts(call.id) + 1;
  try {
    const result = processCall_(call);
    log.write(call, Object.assign({ status: 'done', attempts: attempts }, result));
    clearSteps_(call.id);
  } catch (e) {
    const giveUp = attempts >= 3;
    log.write(call, { status: giveUp ? 'failed' : 'retrying', attempts: attempts, error: String(e.message || e).slice(0, 500) });
    if (giveUp) alert_('A recorded call from ' + fmtTime_(call.when) + ' could not be processed after 3 tries. See the Calls Log.');
  }
}

function processCall_(call) {
  const ctx = {
    settings: readSettings_(),
    staff: readStaff_(),
    documents: readDocuments_(),
    rules: readRules_(),
  };
  const hb = hbCall_('open', {});                 // Drive pass + home names
  ctx.homes = hb.homes || [];
  ctx.staffName = (ctx.staff[(call.owner || '').toLowerCase()] || {}).name || call.owner || 'Staff';

  const ai = analyzeCall_(call, ctx);             // one Gemini call
  const out = { type: ai.callType, otherParty: partyLabel_(ai.otherParty), summary: ai.summary || '' };
  if (ai.callType === 'none') return out;

  if (ai.callType === 'intake') Object.assign(out, runIntake_(call, ai, ctx, hb));
  out.actions = runActions_(call, ai.actions || [], ctx);
  if (out.client || out.actions.length) sendCallSummary_(call, out, ctx);
  return out;
}

function partyLabel_(p) {
  p = p || {};
  return [p.name, p.organization].filter(Boolean).join(', ') || p.phone || '';
}
```

### 6.4 `Vault.gs`

```js
/** Vault.gs: export Voice call logs (with Gemini notes transcripts) for the whole org. */
const VAULT = 'https://vault.googleapis.com/v1';

function vault_(method, path, body) {
  const res = UrlFetchApp.fetch(VAULT + path, {
    method: method,
    contentType: 'application/json',
    payload: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error('Vault ' + method + ' ' + path + ' -> ' + code + ': ' + text.slice(0, 400));
  return text ? JSON.parse(text) : {};
}

function ensureMatter_() {
  const existing = P.getProperty('VAULT_MATTER_ID');
  if (existing) return existing;
  const m = vault_('post', '/matters', {
    name: 'HouseBoss call transcripts',
    description: 'Automated export of Google Voice call notes for intake and follow-up processing (plans/phone-intake.md).',
  });
  P.setProperty('VAULT_MATTER_ID', m.matterId);
  return m.matterId;
}

function startExport_() {
  const matter = ensureMatter_();
  const now = new Date();
  const start = P.getProperty('WINDOW_START') || new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const exp = vault_('post', '/matters/' + matter + '/exports', {
    name: 'calls ' + Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss'),
    query: {
      corpus: 'VOICE',
      dataScope: 'ALL_DATA',
      searchMethod: 'ENTIRE_ORG',
      startTime: start,
      endTime: now.toISOString(),
      timeZone: TZ,
      voiceOptions: { coveredData: ['CALL_LOGS'] },
    },
    exportOptions: { voiceOptions: { exportFormat: 'MBOX' }, region: 'ANY' },
  });
  P.setProperty('PENDING_EXPORT_ID', exp.id);
  P.setProperty('PENDING_EXPORT_END', now.toISOString());
}

function getExport_(id) {
  return vault_('get', '/matters/' + ensureMatter_() + '/exports/' + id);
}

function clearExport_(id) {
  try { vault_('delete', '/matters/' + ensureMatter_() + '/exports/' + id); } catch (e) { console.warn('export delete', e); }
  P.deleteProperty('PENDING_EXPORT_ID');
  P.deleteProperty('PENDING_EXPORT_END');
}

/** Export files sit in a Google-managed Cloud Storage bucket; the ediscovery +
 *  devstorage.read_only scopes on our own token are what let us read them. */
function gcsDownload_(f) {
  const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(f.bucketName) +
    '/o/' + encodeURIComponent(f.objectName) + '?alt=media';
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('Export download failed ' + res.getResponseCode() + ' for ' + f.objectName);
  return res.getBlob().setName(f.objectName.split('/').pop());
}
```

### 6.5 `Transcript.gs`

**First-test step:** Google documents that transcripts and notes ride on the call-log entry but not the exact layout. At the first test (section 8, fake data only), download one export, look at a call-log message, and adjust `callFromMessage_` so that:
- `text` is the **full transcript** (if the summary is also present, keep both and label them; Gemini is told to use the transcript),
- `owner` is the staff member's email,
- calls without notes are skipped.

```js
/** Transcript.gs: unzip a Vault Voice export and turn each call-log message into a call. */
function readExportCalls_(exp) {
  const files = (exp.cloudStorageSink && exp.cloudStorageSink.files) || [];
  const calls = [];
  files.forEach(function (f) {
    const blob = gcsDownload_(f);
    const parts = /\.zip$/i.test(f.objectName) ? Utilities.unzip(blob.setContentType('application/zip')) : [blob];
    parts.forEach(function (p) {
      const name = p.getName() || f.objectName;
      if (!/\.mbox$/i.test(name)) return;
      const owner = ownerFromName_(name);
      splitMbox_(p.getDataAsString('UTF-8')).forEach(function (raw) {
        const call = callFromMessage_(raw, owner);
        if (call) calls.push(call);
      });
    });
  });
  calls.sort(function (a, b) { return a.when - b.when; });
  return calls;
}

function ownerFromName_(name) {
  const m = String(name).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : '';
}

function splitMbox_(text) {
  return text.split(/\r?\n(?=From [^\r\n]*\r?\n)/)
    .map(function (m) { return m.replace(/^From [^\r\n]*\r?\n/, ''); })
    .filter(function (m) { return m.trim(); });
}

function parseMime_(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  const cut = m ? m.index : raw.length;
  const head = raw.slice(0, cut);
  const body = m ? raw.slice(cut + m[0].length) : '';
  const headers = {};
  head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(function (line) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  return { headers: headers, body: body };
}

function textParts_(raw, out) {
  const msg = parseMime_(raw);
  const ct = msg.headers['content-type'] || 'text/plain';
  const boundary = (ct.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (/^multipart\//i.test(ct) && boundary) {
    msg.body.split('--' + boundary).slice(1).forEach(function (part) {
      if (/^--/.test(part)) return;                       // closing boundary
      textParts_(part.replace(/^\r?\n/, ''), out);
    });
    return out;
  }
  if (!/^text\//i.test(ct)) return out;
  const charset = (ct.match(/charset="?([^";]+)"?/i) || [])[1] || 'UTF-8';
  const enc = (msg.headers['content-transfer-encoding'] || '').toLowerCase();
  let text = msg.body;
  if (enc === 'base64') text = Utilities.newBlob(Utilities.base64Decode(msg.body.replace(/\s+/g, ''))).getDataAsString(charset);
  else if (enc === 'quoted-printable') text = Utilities.newBlob(decodeQP_(msg.body)).getDataAsString(charset);
  out.push({ html: /^text\/html/i.test(ct), text: text });
  return out;
}

function decodeQP_(s) {
  s = s.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.substr(i + 1, 2);
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      const v = parseInt(hex, 16);
      bytes.push(v > 127 ? v - 256 : v);
      i += 2;
    } else {
      Utilities.newBlob(s[i]).getBytes().forEach(function (b) { bytes.push(b); });
    }
  }
  return bytes;
}

function htmlToText_(h) {
  return h.replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n');
}

function callFromMessage_(raw, owner) {
  const headers = parseMime_(raw).headers;
  const parts = textParts_(raw, []);
  let text = parts.filter(function (p) { return !p.html; }).map(function (p) { return p.text; }).join('\n\n');
  if (!text.trim()) text = parts.filter(function (p) { return p.html; }).map(function (p) { return htmlToText_(p.text); }).join('\n\n');
  text = text.trim();
  if (text.length < MIN_TRANSCRIPT_CHARS) return null;   // call log with no notes
  const phones = ((headers['from'] || '') + ' ' + (headers['to'] || '')).match(/\+?1?\d{10}/g) || [];
  return {
    id: sha_(headers['message-id'] || raw),            // stable, safe for Drive queries
    when: headers['date'] ? new Date(headers['date']) : new Date(),
    owner: owner,
    counterpart: phones[0] || '',
    text: text,
  };
}

/** True when the quote really appears in the transcript (ignoring case, punctuation, spacing). */
function inTranscript_(quote, text) {
  const clean = function (s) { return norm_(s).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); };
  const q = clean(quote);
  return q.length >= 3 && clean(text).indexOf(q) >= 0;
}
```

### 6.6 `Gemini.gs`

```js
/** Gemini.gs: one Vertex AI call per transcript. Returns call type, intake fields, actions. */
const CALL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    callType: { type: 'STRING', enum: ['intake', 'referral_partner', 'client_or_family', 'vendor_or_other', 'none'] },
    summary: { type: 'STRING' },
    otherParty: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING' }, organization: { type: 'STRING' }, email: { type: 'STRING' }, phone: { type: 'STRING' } },
    },
    intakeFields: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          value: { type: 'STRING' },
          values: { type: 'ARRAY', items: { type: 'STRING' } },
          quote: { type: 'STRING' },
        },
        required: ['name', 'quote'],
      },
    },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['email', 'reminder'] },
          reason: { type: 'STRING' },
          quote: { type: 'STRING' },
          to: { type: 'STRING' },
          subject: { type: 'STRING' },
          body: { type: 'STRING' },
          documents: { type: 'ARRAY', items: { type: 'STRING' } },
          title: { type: 'STRING' },
          when: { type: 'STRING' },
          notes: { type: 'STRING' },
        },
        required: ['kind', 'reason', 'quote'],
      },
    },
  },
  required: ['callType', 'summary', 'actions'],
};

function analyzeCall_(call, ctx) {
  const org = ctx.settings.ORG_NAME;
  const callDate = Utilities.formatDate(call.when, TZ, 'yyyy-MM-dd (EEEE)');
  const fieldList = INTAKE_FIELDS.map(function (f) {
    const choices = f.dynamic === 'homes' ? ctx.homes : (f.options || []);
    return f.name + ' | ' + f.label + ' | ' + f.type + (choices.length ? ' | ' + choices.join(' ; ') : '');
  }).join('\n');
  const docs = ctx.documents.length
    ? ctx.documents.map(function (d) { return '- ' + d.name + (d.use ? ' (use when: ' + d.use + ')' : ''); }).join('\n')
    : '(none)';

  const system = [
    'You process transcripts of phone calls taken by staff of ' + org + ', a supportive housing provider in Riverside County, California. Return JSON only, following the schema.',
    '',
    'HARD RULES',
    '1. Use only what was said in the transcript. Never guess, infer, or fill in typical values. If something was not clearly said, leave it out.',
    '2. Every intake field and every action must include "quote": the exact words from the transcript that support it, copied verbatim (a short phrase or sentence).',
    '3. If the input contains both a summary and a transcript, use the transcript.',
    '',
    'CALL TYPE',
    '"intake" only if staff collected a prospective resident\'s intake information (their name plus intake questions). "none" if there is no real conversation.',
    '',
    'INTAKE FIELDS (only when callType is "intake")',
    'Use the field names below exactly. For choice fields, "value" must be exactly one of the listed choices. For multi-choice (check) fields use "values". Dates as YYYY-MM-DD. The call date is ' + callDate + '; resolve relative dates like "next Thursday" from it. Spell names, emails and ID numbers exactly as spelled out on the call. moveInDate and prefLocation are the move-in date and home staff confirmed on the call.',
    'Fields (name | label | type | choices):',
    fieldList,
    '',
    'ACTIONS',
    'Create an action only when a staff member committed to something on the call (for example "I\'ll email you our information", "I\'ll call you Tuesday") or agreed to something the other person asked for. Do not invent tasks.',
    '- email: the message the staff member promised, warm, professional and concise, from ' + org + '. No signature or sign-off name (added automatically). "to" only if an email address was stated on the call. Attach documents only by exact name from this list, only when they fit:',
    docs,
    '  Never put a client\'s health, diagnosis, criminal, benefits or ID details in an email to someone outside ' + org + '.',
    '- reminder: short "title"; "when" as YYYY-MM-DDTHH:MM Pacific time; if no time was said use 09:00; if no day was said use the next business day after the call.',
  ].join('\n');

  const user = 'Call date/time: ' + fmtTime_(call.when) + '\nStaff on the call: ' + ctx.staffName +
    '\nOther phone number: ' + (call.counterpart || 'unknown') + '\n\nTRANSCRIPT:\n<<<\n' + call.text + '\n>>>';

  return gemini_(system, user, CALL_SCHEMA);
}

function gemini_(systemText, userText, schema) {
  const project = cfg('GCP_PROJECT_ID');
  const loc = cfg('VERTEX_LOCATION', 'us-central1');
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : loc + '-aiplatform.googleapis.com';
  const url = 'https://' + host + '/v1/projects/' + project + '/locations/' + loc +
    '/publishers/google/models/' + cfg('GEMINI_MODEL') + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const data = JSON.parse(res.getContentText());
  const text = (((data.candidates || [])[0] || {}).content || { parts: [{}] }).parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) throw new Error('Gemini returned no content');
  return JSON.parse(text);
}
```

### 6.7 `Intake.gs`

```js
/** Intake.gs: build the HouseBoss intake record, save it where the Intake tab sees it, notify. */
function runIntake_(call, ai, ctx, hb) {
  const built = buildRecord_(ai.intakeFields || [], ctx.homes, call, ctx);
  const record = built.record;
  const checklist = applyRules_(record, ctx.rules);
  const stillNeed = INTAKE_FIELDS
    .filter(function (f) { return f.required && isBlank_(record[f.name]); })
    .map(function (f) { return 'Not captured on the call: ' + f.label; })
    .concat(built.flags);
  if (!record.moveInDate || !record.prefLocation) stillNeed.push('Move-in date or home not captured: HouseBoss was not notified. Add them in the Intake tab and tell the house manager.');

  const drive = new HbDrive_(hb.access_token);
  const folder = drive.folder();
  const base = fileBase_(record);
  const fileId = drive.saveIntake(folder, base + '.json', record, call.id);

  let pdfId = P.getProperty('STEP:' + call.id + ':pdf');
  const pdf = buildPdf_(record, { checklist: checklist, stillNeed: stillNeed, sources: built.sources, call: call, staff: ctx.staffName, org: ctx.settings.ORG_NAME }, base);
  if (!pdfId) {
    pdfId = drive.upload(folder, pdf, 'application/pdf');
    drive.upload(folder, Utilities.newBlob(transcriptText_(call, ctx), 'text/plain', base + ' — call transcript.txt'), 'text/plain');
    P.setProperty('STEP:' + call.id + ':pdf', pdfId);
  }
  if (!stepDone_(call.id + ':ops')) { emailOpsManager_(record, checklist, stillNeed, pdf, ctx); markStep_(call.id + ':ops'); }

  let houseboss = 'not sent (no move-in date or home)';
  if (record.moveInDate && record.prefLocation) {
    const r = hbCall_('move_in', {
      client_label: clientLabel_(record),
      home_name: record.prefLocation,
      move_in_date: record.moveInDate,
      drive_file_id: fileId,
      ops_manager_name: ctx.settings.OPS_MANAGER_NAME || '',
    });
    houseboss = r.already ? 'already notified' : 'notified (' + ((r.notified || []).length) + ' texts)';
  }
  return {
    client: [record.firstName, record.lastName].filter(Boolean).join(' ') || 'Unnamed intake',
    moveIn: record.moveInDate, home: record.prefLocation,
    intakeFileId: fileId, pdfUrl: 'https://drive.google.com/file/d/' + pdfId + '/view',
    checklist: checklist, stillNeed: stillNeed, houseboss: houseboss,
  };
}

function buildRecord_(aiFields, homes, call, ctx) {
  const record = {};
  INTAKE_FIELDS.forEach(function (f) { record[f.name] = f.type === 'check' ? [] : ''; });
  const byName = {};
  INTAKE_FIELDS.forEach(function (f) { byName[f.name] = f; });
  const flags = [];
  const sources = {};

  aiFields.forEach(function (a) {
    const f = byName[a.name];
    if (!f) return;
    if (!inTranscript_(a.quote, call.text)) { flags.push(f.label + ': answer could not be matched to the transcript. Confirm it.'); return; }
    const v = coerce_(f, a, homes);
    if (v.error) { flags.push(f.label + ': heard "' + v.error + '", which is not one of the form\'s choices. Confirm it.'); return; }
    if (isBlank_(v.value)) return;
    record[f.name] = v.value;
    sources[f.name] = a.quote;
  });

  record.intakeDate = Utilities.formatDate(call.when, TZ, 'yyyy-MM-dd');
  if (byName.callDateTime && !record.callDateTime) record.callDateTime = Utilities.formatDate(call.when, TZ, "yyyy-MM-dd'T'HH:mm");
  if (byName.staffName && !record.staffName) record.staffName = ctx.staffName;
  if (byName.intakeNotes) {
    record.intakeNotes = [record.intakeNotes, 'Filled automatically from the recorded call on ' + fmtTime_(call.when) +
      '. See the PDF for the checklist and anything still missing.'].filter(Boolean).join('\n\n');
  }
  return { record: record, flags: flags, sources: sources };
}

function coerce_(f, a, homes) {
  const raw = String(a.value == null ? '' : a.value).trim();
  const choices = f.dynamic === 'homes' ? homes : (f.options || []);
  const pick = function (s) {
    for (let i = 0; i < choices.length; i++) if (norm_(choices[i]) === norm_(s)) return choices[i];
    return null;
  };
  switch (f.type) {
    case 'check': {
      const vals = (a.values && a.values.length ? a.values : raw ? raw.split(/\s*[,;]\s*/) : []);
      const out = [];
      for (let i = 0; i < vals.length; i++) {
        const c = pick(vals[i]);
        if (!c) return { error: vals[i] };
        if (out.indexOf(c) < 0) out.push(c);
      }
      return { value: out };
    }
    case 'select':
    case 'radio': {
      if (!raw) return { value: '' };
      const c = pick(raw);
      return c ? { value: c } : { error: raw };
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { value: raw } : raw ? { error: raw } : { value: '' };
    case 'datetime-local':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? { value: raw } : raw ? { error: raw } : { value: '' };
    default:
      if (f.name === 'ssn' && raw) {
        const d = raw.replace(/\D/g, '');
        return d.length === 9 ? { value: d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5) } : { error: 'incomplete SSN' };
      }
      return { value: raw };
  }
}

/** Same file name rule as lib/drive.js fileNameFor(), minus the extension. */
function fileBase_(record) {
  const who = [String(record.lastName || '').trim(), String(record.firstName || '').trim()].filter(Boolean).join(', ') || 'Unnamed intake';
  return who + (record.intakeDate ? ' — ' + record.intakeDate : '');
}

function clientLabel_(record) {
  const first = String(record.firstName || '').trim();
  const last = String(record.lastName || '').trim();
  return (first + (last ? ' ' + last[0].toUpperCase() + '.' : '')).slice(0, 40) || 'New resident';
}

function transcriptText_(call, ctx) {
  return 'Recorded call · ' + fmtTime_(call.when) + ' · Staff: ' + ctx.staffName +
    ' · Other number: ' + (call.counterpart || 'unknown') + '\n\n' + call.text;
}

function emailOpsManager_(record, checklist, stillNeed, pdf, ctx) {
  const to = String(ctx.settings.OPS_MANAGER_EMAIL || '').trim();
  if (!to) throw new Error('Settings: OPS_MANAGER_EMAIL is empty');
  const domain = '@' + String(ctx.settings.ORG_DOMAIN || '').toLowerCase();
  // Client details stay inside Google Workspace (BAA): never to a personal address.
  if (to.toLowerCase().slice(-domain.length) !== domain) throw new Error('OPS_MANAGER_EMAIL must be a ' + domain + ' address');
  const name = [record.firstName, record.lastName].filter(Boolean).join(' ') || 'New resident';
  const li = function (xs) { return xs.length ? '<ul>' + xs.map(function (x) { return '<li>' + escHtml_(x) + '</li>'; }).join('') + '</ul>' : '<p>None.</p>'; };
  const html =
    '<p><b>' + escHtml_(name) + '</b>' + (record.moveInDate ? ' moves in <b>' + fmtDate_(record.moveInDate) + '</b>' : '') +
    (record.prefLocation ? ' at <b>' + escHtml_(record.prefLocation) + '</b>' : '') + '.</p>' +
    '<p><b>Checklist</b></p>' + li(checklist) +
    '<p><b>Still needed</b></p>' + li(stillNeed) +
    '<p>The full intake is attached and is in HouseBoss → Intake.</p>';
  GmailApp.sendEmail(to, 'New intake: ' + name + (record.moveInDate ? ' (moves in ' + fmtDate_(record.moveInDate) + ')' : ''),
    'Open this email in Gmail to see the intake summary. The full intake PDF is attached.',
    { htmlBody: html, attachments: [pdf], name: ctx.settings.ORG_NAME });
}

function escHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
```

### 6.8 `HouseBoss.gs`: HouseBoss endpoint + Drive via the HouseBoss pass

```js
/** HouseBoss.gs: talk to the call-intake Edge Function; write to Drive with its short-lived pass. */
function hbCall_(action, payload) {
  const res = UrlFetchApp.fetch(cfg('HB_FUNCTION_URL'), {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-call-intake-secret': cfg('HB_SECRET') },
    payload: JSON.stringify(Object.assign({ action: action, user_id: cfg('HB_USER_ID') }, payload || {})),
    muteHttpExceptions: true,
  });
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() >= 300) {
    const why = body.error === 'not_connected'
      ? 'HouseBoss is not allowed to save to Drive. Turn on "Allow texted intakes" in the Intake tab (as info@).'
      : (body.error || res.getContentText().slice(0, 200));
    throw new Error('HouseBoss ' + action + ' -> ' + res.getResponseCode() + ': ' + why);
  }
  return body;
}

/** Drive REST with the HouseBoss drive.file token, so files belong to the HouseBoss app
 *  and the Intake tab can list and open them (same as lib/drive.js). */
function HbDrive_(token) { this.token = token; }

HbDrive_.prototype.api = function (method, path, opt) {
  opt = opt || {};
  const base = opt.upload ? 'https://www.googleapis.com/upload/drive/v3' : 'https://www.googleapis.com/drive/v3';
  const qs = opt.query ? '?' + Object.keys(opt.query).map(function (k) { return k + '=' + encodeURIComponent(opt.query[k]); }).join('&') : '';
  const params = { method: method, headers: { Authorization: 'Bearer ' + this.token }, muteHttpExceptions: true };
  if (opt.payload !== undefined) { params.payload = opt.payload; params.contentType = opt.contentType || 'application/json'; }
  const res = UrlFetchApp.fetch(base + path + qs, params);
  if (res.getResponseCode() >= 300) throw new Error('Drive ' + method + ' ' + path + ' -> ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  const t = res.getContentText();
  return t ? JSON.parse(t) : {};
};

HbDrive_.prototype.folder = function () {
  const names = [ROOT_FOLDER_NAME, LEGACY_FOLDER_NAME];
  for (let i = 0; i < names.length; i++) {
    const r = this.api('get', '/files', { query: {
      q: "name='" + names[i] + "' and mimeType='application/vnd.google-apps.folder' and trashed=false", fields: 'files(id)' } });
    if (r.files && r.files.length) return r.files[0].id;
  }
  return this.api('post', '/files', { query: { fields: 'id' },
    payload: JSON.stringify({ name: ROOT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) }).id;
};

/** One JSON file per intake, same shape and metadata as lib/drive.js createIntake().
 *  A retried run finds its own earlier file by callId and never overwrites it
 *  (Kev may already have edited it in the Intake tab). */
HbDrive_.prototype.saveIntake = function (folder, name, record, callId) {
  const found = this.api('get', '/files', { query: {
    q: "'" + folder + "' in parents and trashed=false and appProperties has { key='callId' and value='" + callId + "' }",
    fields: 'files(id)' } });
  if (found.files && found.files.length) return found.files[0].id;
  const created = this.api('post', '/files', { query: { fields: 'id' }, payload: JSON.stringify({
    name: name, parents: [folder], mimeType: 'application/json',
    appProperties: {
      clientName: [record.firstName, record.lastName].filter(Boolean).join(' ').trim() || 'Unnamed intake',
      status: record.placementDecision || '',
      intakeDate: record.intakeDate || '',
      callId: callId,
    } }) });
  this.api('patch', '/files/' + created.id, { upload: true, query: { uploadType: 'media' },
    payload: JSON.stringify(record, null, 2), contentType: 'application/json' });
  return created.id;
};

HbDrive_.prototype.upload = function (folder, blob, mime) {
  const created = this.api('post', '/files', { query: { fields: 'id' },
    payload: JSON.stringify({ name: blob.getName(), parents: [folder], mimeType: mime }) });
  this.api('patch', '/files/' + created.id, { upload: true, query: { uploadType: 'media' }, payload: blob.getBytes(), contentType: mime });
  return created.id;
};
```

### 6.9 `Rules.gs`

```js
/** Rules.gs: checklist from the Rules tab. Deterministic: same answers, same checklist. */
const RULE_OPS = ['is', 'is not', 'is one of', 'includes any of', 'contains', 'is blank', 'is not blank'];

function readRules_() {
  return sheet_('Rules').getDataRange().getValues().slice(1)
    .filter(function (r) { return /^yes$/i.test(String(r[0]).trim()) && String(r[7]).trim(); })
    .map(function (r) {
      return {
        conds: [[r[1], r[2], r[3]], [r[4], r[5], r[6]]].filter(function (c) { return String(c[0]).trim(); }),
        item: String(r[7]).trim(),
      };
    });
}

/** The Rules tab may name a field by its name (mhDx) or its label (Mental Health Diagnoses...). */
function ruleField_(ref) {
  const r = norm_(ref);
  for (let i = 0; i < INTAKE_FIELDS.length; i++) {
    const f = INTAKE_FIELDS[i];
    if (norm_(f.name) === r || norm_(f.label) === r) return f.name;
  }
  throw new Error('Rules tab: unknown field "' + ref + '"');
}

function applyRules_(record, rules) {
  const out = [];
  rules.forEach(function (rule) {
    const hit = rule.conds.every(function (c) { return test_(record, ruleField_(c[0]), c[1], c[2]); });
    if (!hit) return;
    const item = rule.item.replace(/\{(\w+)\}/g, function (_, f) { return show_(record[f]) || f; });
    if (out.indexOf(item) < 0) out.push(item);
  });
  return out;
}

function test_(record, field, op, value) {
  const raw = record[field];
  const vals = (Array.isArray(raw) ? raw : [raw]).map(norm_).filter(Boolean);
  const want = String(value == null ? '' : value).split(',').map(norm_).filter(Boolean);
  switch (norm_(op)) {
    case 'is blank': return vals.length === 0;
    case 'is not blank': return vals.length > 0;
    case 'is': return vals.length === 1 && vals[0] === want[0];
    case 'is not': return !(vals.length === 1 && vals[0] === want[0]);
    case 'is one of':
    case 'includes any of': return vals.some(function (v) { return want.indexOf(v) >= 0; });
    case 'contains': return vals.some(function (v) { return want.some(function (w) { return v.indexOf(w) >= 0; }); });
    default: throw new Error('Rules tab: unknown condition "' + op + '". Use one of: ' + RULE_OPS.join(', '));
  }
}
```

### 6.10 `Pdf.gs`

```js
/** Pdf.gs: the printable intake: header, checklist, still-needed, every section.
 *  SSN is masked on paper; the full number stays in Drive/HouseBoss. */
function buildPdf_(record, info, base) {
  const e = escHtml_;
  const name = [record.firstName, record.lastName].filter(Boolean).join(' ') || 'Unnamed intake';
  const list = function (xs, cls) {
    return xs.length ? '<ul class="' + cls + '">' + xs.map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul>' : '<p class="none">None.</p>';
  };
  let h = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#111;margin:28px}' +
    'h1{font-size:18pt;margin:0}.sub{color:#555;margin:3px 0 14px}' +
    'h2{font-size:12pt;border-bottom:2px solid #c9a84c;padding-bottom:3px;margin:18px 0 6px}' +
    'table{width:100%;border-collapse:collapse}td{padding:4px 6px;border-bottom:1px solid #e5e5e5;vertical-align:top}' +
    'td.l{width:36%;color:#444}.q{color:#777;font-size:8.5pt;font-style:italic;margin-top:2px}' +
    '.miss{color:#b00020;font-weight:bold}.dash{color:#aaa}.box{border:1px solid #c9a84c;background:#fbf7ea;padding:6px 12px;margin-top:6px}' +
    'ul{margin:4px 0 4px 18px;padding:0}li{margin:3px 0}ul.red li{color:#b00020}.none{color:#777;margin:4px 0}' +
    '.foot{color:#777;font-size:8.5pt;margin-top:22px}</style></head><body>';
  h += '<h1>' + e(info.org) + ' · Resident Intake</h1>';
  h += '<div class="sub"><b>' + e(name) + '</b>' +
    (record.moveInDate ? ' · Move-in ' + e(fmtDate_(record.moveInDate)) : '') +
    (record.prefLocation ? ' · ' + e(record.prefLocation) : '') +
    ' · Call ' + e(fmtTime_(info.call.when)) + ' with ' + e(info.staff) + '</div>';
  h += '<div class="box"><h2 style="margin-top:4px">Checklist</h2>' + list(info.checklist, '') +
    '<h2>Still needed</h2>' + list(info.stillNeed, 'red') + '</div>';

  INTAKE_SECTIONS.forEach(function (s) {
    h += '<h2>' + e(s.title) + '</h2><table>';
    s.fields.forEach(function (f) {
      let v = record[f.name];
      if (f.name === 'ssn' && v) v = '***-**-' + String(v).slice(-4);
      let cell;
      if (isBlank_(v)) cell = f.required ? '<span class="miss">NOT CAPTURED</span>' : '<span class="dash">—</span>';
      else cell = e(show_(v)).replace(/\n/g, '<br>');
      const q = info.sources[f.name];
      if (q && f.name !== 'ssn') cell += '<div class="q">“' + e(q) + '”</div>';
      h += '<tr><td class="l">' + e(f.label) + '</td><td>' + cell + '</td></tr>';
    });
    h += '</table>';
  });
  h += '<div class="foot">Filled automatically from a recorded phone call. Italic lines are the words said on the call. ' +
    'NOT CAPTURED means it was not said and must be collected. Edit this intake in HouseBoss → Intake.</div></body></html>';
  return Utilities.newBlob(h, 'text/html', base + '.html').getAs('application/pdf').setName(base + '.pdf');
}
```

### 6.11 `Actions.gs`: follow-ups from any call

```js
/** Actions.gs: emails (Gmail drafts) and reminders (Calendar) for what staff promised on the call. */
function runActions_(call, actions, ctx) {
  const done = [];
  actions.forEach(function (a, i) {
    const key = call.id + ':a' + i;
    if (stepDone_(key)) { done.push('(already done) ' + (a.subject || a.title || a.reason)); return; }
    if (!inTranscript_(a.quote, call.text)) { done.push('Skipped, not supported by the transcript: ' + a.reason); return; }
    if (a.kind === 'email') done.push(createEmail_(a, ctx));
    else if (a.kind === 'reminder') done.push(createReminder_(a, call));
    markStep_(key);
  });
  return done;
}

function createEmail_(a, ctx) {
  const to = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(a.to || '').trim()) ? String(a.to).trim() : '';
  const attachments = [];
  const missing = [];
  (a.documents || []).forEach(function (n) {
    const d = ctx.documents.filter(function (x) { return norm_(x.name) === norm_(n); })[0];
    if (d) attachments.push(DriveApp.getFileById(d.id).getBlob());
    else missing.push(n);
  });
  const subject = a.subject || 'Following up from our call';
  const html = escHtml_(a.body || '').replace(/\n/g, '<br>') + '<br><br>' + signature_(ctx);
  const draft = GmailApp.createDraft(to, subject, a.body || '', { htmlBody: html, attachments: attachments, name: ctx.settings.ORG_NAME });
  const auto = /^yes$/i.test(String(ctx.settings.AUTO_SEND_EMAILS || '')) && to;
  if (auto) draft.send();
  return (auto ? 'Email sent' : 'Email draft ready') + ': "' + subject + '" to ' + (to || '(no email heard on the call; add the recipient)') +
    (attachments.length ? ', ' + attachments.length + ' attachment(s)' : '') +
    (missing.length ? ' (not in the Documents tab: ' + missing.join(', ') + ')' : '');
}

/** Gmail drafts made by a script don't get the signature automatically. */
function signature_(ctx) {
  if (signature_.cache != null) return signature_.cache;
  try {
    signature_.cache = Gmail.Users.Settings.SendAs.get('me', ctx.settings.SENDER_EMAIL).signature || '';
  } catch (e) {
    console.warn('signature', e);
    signature_.cache = '';
  }
  return signature_.cache;
}

function createReminder_(a, call) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(a.when || ''))) throw new Error('Reminder time unreadable: ' + a.when);
  const start = Utilities.parseDate(a.when, TZ, "yyyy-MM-dd'T'HH:mm");
  const ev = CalendarApp.getDefaultCalendar().createEvent(a.title || a.reason, start, new Date(start.getTime() + 15 * 60000), {
    description: (a.notes ? a.notes + '\n\n' : '') + 'From the recorded call on ' + fmtTime_(call.when) + '.\nSaid on the call: "' + a.quote + '"',
  });
  ev.addPopupReminder(10);
  return 'Reminder set: ' + (a.title || a.reason) + ' (' + Utilities.formatDate(start, TZ, 'EEE M/d h:mm a') + ')';
}

/** One email to the staff member who took the call. */
function sendCallSummary_(call, out, ctx) {
  if (stepDone_(call.id + ':summary')) return;
  const to = call.owner || setting_('ALERT_EMAIL');
  const lines = [];
  if (out.client) {
    lines.push('Intake for ' + out.client + ': saved to HouseBoss → Intake, PDF emailed to the operations manager. HouseBoss: ' + out.houseboss + '.');
    if (out.stillNeed && out.stillNeed.length) lines.push('Still needed: ' + out.stillNeed.length + ' item(s), listed in the PDF.');
  }
  (out.actions || []).forEach(function (x) { lines.push(x); });
  if (!lines.length) return;
  GmailApp.sendEmail(to, 'From your call' + (out.otherParty ? ' with ' + out.otherParty : '') + ' (' + fmtTime_(call.when) + ')',
    lines.map(function (l) { return '• ' + l; }).join('\n') + '\n\nDrafts are in ' + ctx.settings.SENDER_EMAIL + ' → Drafts. Calls Log: ' + sheetUrl_(),
    { name: ctx.settings.ORG_NAME });
  markStep_(call.id + ':summary');
}
```

### 6.12 `Sheet.gs`: settings, staff, documents, rules, log

```js
/** Sheet.gs: the "HouseBoss Call Automation" spreadsheet (in info@'s Drive, not shared). */
const LOG_HEADERS = ['Call ID', 'Call time', 'Staff', 'Type', 'Other party', 'Client', 'Move-in', 'Home',
  'Result / actions', 'Intake file', 'PDF', 'Status', 'Attempts', 'Error', 'Processed at'];

function book_() { return SpreadsheetApp.openById(cfg('SHEET_ID')); }
function sheet_(name) {
  const s = book_().getSheetByName(name);
  if (!s) throw new Error('Missing tab "' + name + '" in the automation sheet');
  return s;
}
function sheetUrl_() { try { return book_().getUrl(); } catch (e) { return '(sheet not set up)'; } }

function readSettings_() {
  const out = {};
  sheet_('Settings').getDataRange().getValues().slice(1).forEach(function (r) {
    if (String(r[0]).trim()) out[String(r[0]).trim()] = String(r[1]).trim();
  });
  return out;
}
function setting_(key) { return readSettings_()[key] || ''; }

function readStaff_() {
  const out = {};
  sheet_('Staff').getDataRange().getValues().slice(1).forEach(function (r) {
    const email = String(r[0]).trim().toLowerCase();
    if (email) out[email] = { name: String(r[1]).trim() || email };
  });
  return out;
}

function readDocuments_() {
  return sheet_('Documents').getDataRange().getValues().slice(1)
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) {
      const link = String(r[1]).trim();
      const id = (link.match(/\/d\/([\w-]{20,})/) || link.match(/[?&]id=([\w-]{20,})/) || [null, link])[1];
      return { name: String(r[0]).trim(), id: id, use: String(r[2] || '').trim() };
    });
}

function loadLog_() {
  const s = sheet_('Calls Log');
  const rows = s.getDataRange().getValues();
  const index = {};
  for (let i = 1; i < rows.length; i++) index[rows[i][0]] = { row: i + 1, status: rows[i][11], attempts: Number(rows[i][12]) || 0 };
  return {
    isDone: function (id) { return !!index[id] && (index[id].status === 'done' || index[id].status === 'failed'); },
    attempts: function (id) { return index[id] ? index[id].attempts : 0; },
    write: function (call, r) {
      const staff = (readStaff_()[(call.owner || '').toLowerCase()] || {}).name || call.owner || '';
      const row = [call.id, fmtTime_(call.when), staff, r.type || '', r.otherParty || '', r.client || '',
        r.moveIn || '', r.home || '', [r.summary].concat(r.actions || []).filter(Boolean).join('\n'),
        r.intakeFileId ? 'https://drive.google.com/file/d/' + r.intakeFileId + '/view' : '', r.pdfUrl || '',
        r.status, r.attempts, r.error || '', fmtTime_(new Date())];
      if (index[call.id]) s.getRange(index[call.id].row, 1, 1, row.length).setValues([row]);
      else { s.appendRow(row); index[call.id] = { row: s.getLastRow(), status: r.status, attempts: r.attempts }; }
      index[call.id].status = r.status;
      index[call.id].attempts = r.attempts;
    },
  };
}
```

### 6.13 `Setup.gs`

```js
/** Setup.gs: run setup() once, then checkSetup(). */
function setup() {
  if (!P.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('HouseBoss Call Automation');
    P.setProperty('SHEET_ID', ss.getId());
    const first = ss.getSheets()[0];
    first.setName('Settings');
    first.getRange(1, 1, 7, 2).setValues([
      ['Setting', 'Value'],
      ['ORG_NAME', 'Bethel Residency'],
      ['ORG_DOMAIN', 'bethelresidency.com'],
      ['SENDER_EMAIL', 'info@bethelresidency.com'],
      ['OPS_MANAGER_EMAIL', ''],
      ['OPS_MANAGER_NAME', ''],
      ['ALERT_EMAIL', 'info@bethelresidency.com'],
    ]);
    first.appendRow(['AUTO_SEND_EMAILS', 'No']);
    ss.insertSheet('Staff').getRange(1, 1, 2, 2).setValues([['Staff email', 'Name'], ['info@bethelresidency.com', 'Kevin']]);
    ss.insertSheet('Documents').getRange(1, 1, 1, 3).setValues([['Name (what Gemini picks by)', 'Drive link', 'When to use']]);
    const rules = ss.insertSheet('Rules');
    rules.getRange(1, 1, 1, 8).setValues([['Active', 'If field', 'Condition', 'Value', 'And field', 'Condition', 'Value', 'Checklist item']]);
    rules.getRange(2, 1, STARTER_RULES.length, 8).setValues(STARTER_RULES);
    ss.insertSheet('Calls Log').getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
    ss.getSheets().forEach(function (s) { s.setFrozenRows(1); });
  }
  ensureMatter_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runPipeline') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runPipeline').timeBased().everyMinutes(30).create();
  if (!P.getProperty('WINDOW_START')) P.setProperty('WINDOW_START', new Date(Date.now() - 3600 * 1000).toISOString());
  console.log('Setup done. Sheet: ' + sheetUrl_());
}

function checkSetup() {
  const line = function (label, fn) {
    try { fn(); console.log('OK   ' + label); } catch (e) { console.log('FAIL ' + label + ': ' + e.message); }
  };
  line('Script properties', function () { ['GCP_PROJECT_ID', 'GEMINI_MODEL', 'HB_FUNCTION_URL', 'HB_SECRET', 'HB_USER_ID', 'SHEET_ID'].forEach(cfg); });
  line('Sheet + settings', function () { const s = readSettings_(); if (!s.OPS_MANAGER_EMAIL) throw new Error('OPS_MANAGER_EMAIL is empty'); });
  line('Rules parse', function () { const r = readRules_(); r.forEach(function (x) { x.conds.forEach(function (c) { ruleField_(c[0]); test_({}, ruleField_(c[0]), c[1], c[2]); }); }); });
  line('Documents open', function () { readDocuments_().forEach(function (d) { DriveApp.getFileById(d.id).getName(); }); });
  line('Vault matter', function () { vault_('get', '/matters/' + ensureMatter_()); });
  line('Gemini (Vertex)', function () { gemini_('Reply with JSON {"ok":true}.', 'ping', { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } }); });
  line('HouseBoss open + Drive pass', function () { const hb = hbCall_('open', {}); new HbDrive_(hb.access_token).folder(); });
  line('Intake fields loaded', function () { if (!INTAKE_FIELDS.length) throw new Error('IntakeFields.gs is empty'); });
}

/** STARTER rules, drafted by Claude from the intake form for Kev to review, edit or delete.
 *  Option values match lib/intake-form.js exactly. {field} inserts that answer. */
const STARTER_RULES = [
  ['Yes', 'mhDx', 'includes any of', 'Depression, Bipolar, Schizophrenia, PTSD, Anxiety, ADHD, TBI, Other MH', 'mhTreatment', 'is one of', 'No, Needs Referral', 'Connect to a local behavioral health provider (e.g., Jefferson Wellness) in the first week.'],
  ['Yes', 'medCompliant', 'is', 'No', '', '', '', 'Set up medication support: confirm med list and pharmacy; daily med check-ins with the house manager.'],
  ['Yes', 'onMedication', 'is one of', 'Yes – Psychiatric, Yes – Medical, Yes – Both', '', '', '', 'Collect current medication list and pharmacy at move-in; set up secure med storage.'],
  ['Yes', 'adlIndependent', 'is one of', 'No – Needs Some Help, No – Needs Significant Help', '', '', '', 'Confirm ADL support needs before move-in; consider an IHSS referral.'],
  ['Yes', 'substanceUse', 'includes any of', 'Alcohol, Marijuana, Meth, Opioids, Crack/Cocaine', 'substanceTreatment', 'is', 'No – Not in Treatment', 'Offer a substance-use treatment referral (outpatient / MAT).'],
  ['Yes', 'mediCalStatus', 'is one of', 'Pending, Lapsed / Needs Renewal, Never Had, Needs Assistance Applying', '', '', '', 'Help apply for or renew Medi-Cal.'],
  ['Yes', 'benefits', 'includes any of', 'Medi-Cal', 'mediCalId', 'is blank', '', 'Collect Medi-Cal BIC / ID number at move-in.'],
  ['Yes', 'ssiStatus', 'is one of', 'Never Applied, Needs Assistance Applying, Denied – Appealing', '', '', '', 'Start SSI/SSDI application or appeal assistance.'],
  ['Yes', 'income', 'includes any of', 'None', '', '', '', 'Build an income plan before first rent is due (General Relief, CalFresh, employment).'],
  ['Yes', 'repPayee', 'is', 'Needs One', '', '', '', 'Refer for a representative payee.'],
  ['Yes', 'probationParole', 'is one of', 'Yes – Probation, Yes – Parole, Yes – Both', '', '', '', 'Get PO name and phone; confirm the PO has approved the address.'],
  ['Yes', 'dischargingFrom', 'is not blank', '', '', '', '', 'Request discharge paperwork and medication list from {dischargingFrom}.'],
  ['Yes', 'recentHospital', 'is one of', 'Yes – Psychiatric, Yes – Medical, Yes – Both', '', '', '', 'Ask about follow-up appointments from the recent hospital stay; add them to the calendar.'],
];
```

---

## 7. The Google Sheet ("HouseBoss Call Automation")

| Tab | What it's for | Who edits |
|---|---|---|
| **Settings** | Org name, domain, sender (info@), **operations manager email + name**, alert email, `AUTO_SEND_EMAILS` (No/Yes) | Kev, once |
| **Staff** | Staff email → name (so summaries and PDFs say "Rodney", not an address) | When staff change |
| **Documents** | Send-able documents: name, Drive link, when to use (e.g., "Bethel Residency one-pager", "Referral form", "W-9"). Gemini can only attach what's listed here. | Kev, any time |
| **Rules** | Checklist rules. `Active` Yes/No · If field · Condition · Value · (optional) And field · Condition · Value · Checklist item | Kev, any time |
| **Calls Log** | One row per processed call: type, client, move-in, actions, links, status | Written by the script |

**Rule conditions:** `is`, `is not`, `is one of`, `includes any of`, `contains`, `is blank`, `is not blank`. Separate multiple values with commas. Fields can be named by field name (`mhTreatment`) or label. `{fieldName}` in a checklist item inserts that answer.

**Starter rules** (section 6.13): Claude drafted these from the intake form. They are Kev's to review, edit or delete; they are not his policy until he says so.

### 7.1 What to say on calls (makes extraction near-perfect)

- After screening passes: tap **Notes**, then go through the intake questions.
- **Spell** names, emails, and ID numbers out loud, and read them back.
- **Say the home and the move-in date out loud:** "So you're moving into Grand Ave on Thursday the 29th."
- For follow-ups, **name the document:** "I'll email you our one-pager and the referral form." Then Gemini attaches exactly those.
- English only (a Google Voice notes limit). For Spanish-speaking callers, fill the Intake tab directly.

### 7.2 Calls by other staff

Vault covers everyone, so Rodney's calls are processed with no forwarding. Email drafts land in **info@ Drafts**. Rodney gets the summary email telling him so. Drafts in each person's own mailbox would be a future upgrade (needs domain-wide delegation).

### 7.3 Auto-send

`AUTO_SEND_EMAILS = No` (default): emails wait in Drafts and the staff member taps Send. Switch it to `Yes` only when Kev decides the drafts are consistently right. Only emails with an address heard on the call are auto-sent.

---

## 8. First test (fake client only, never real client data while Claude is driving)

1. Kev calls Rodney's Voice number (or the reverse), taps **Notes**, and runs this fake intake:
   - "Test Client", spelled out. DOB 01/01/1980. Medi-Cal ID "TEST 1 2 3 4 5". Phone 909-555-0123.
   - Screening: med compliant yes, on psychiatric medication yes, schizophrenia, not in outpatient treatment.
   - "You're moving into **[a real home name]** on **[a date 3 days out]**."
   - Then, as if to a partner: "I'll email you our one-pager at **[Kev's own second address]**, and I'll call you back Tuesday at 2."
2. Run `runPipeline` from the editor (first run starts the export, later runs collect it). Wait until the export finishes.
3. **Confirm the transcript layout:** download the export (fake data only), open a call-log message, and adjust `callFromMessage_` / `MIN_TRANSCRIPT_CHARS` / owner detection as needed. If the export does **not** contain the full transcript, stop and tell Kev before building anything else.
4. **Acceptance checklist.** Every item must pass:
   - [ ] Calls Log row: type `intake`, status `done`.
   - [ ] HouseBoss → Intake tab lists "Client, Test — <date>". It opens, edits and saves normally, and the fields match the call.
   - [ ] Same folder: PDF + transcript. PDF shows the checklist (behavioral-health and medication items fire), red NOT CAPTURED for required fields not asked, and quotes under answers. SSN masked.
   - [ ] Operations manager got the email with the PDF.
   - [ ] House manager + ops manager + owner got the "New move-in/out" text. HouseBoss Reports shows the report with **no** roster buttons.
   - [ ] Day-before text arrives at the reminder hour (test with `daily-reminders` `{"now": ...}`).
   - [ ] Gmail draft to Kev's second address with the one-pager attached and the signature. Calendar event Tuesday 2:00 PM.
   - [ ] The staff member got the summary email.
   - [ ] Run `runPipeline` again: nothing is duplicated (same intake file, no second text, no second draft).
   - [ ] Break `HB_SECRET` on purpose: the row shows `retrying`, then `failed` on the third run, and the alert email + text arrive. Restore it.
5. Clean up the test data: trash the test intake/PDF/transcript, delete the draft and the calendar event, and ask Kev before removing the test report from HouseBoss.

## 9. Running it

- **Day to day:** nothing. Tap Notes on calls that matter.
- **Change the checklist:** edit the Rules tab (or ask Claude to).
- **Add a document Gemini can send:** upload to Drive, add a row to the Documents tab.
- **Intake form changes in HouseBoss:** run `node tools/export-intake-fields.mjs`, then `clasp push`.
- **Something failed:** the alert says so. Check the Calls Log `Error` column. The pipeline retries twice by itself.
- **Pause everything:** delete the `runPipeline` trigger in the Apps Script editor (Triggers).

## 10. Known limits

- Google Voice notes: English only, one language per call; started from the Voice app (web, Android, iOS).
- Vault publishes no export turnaround time. Fine here because move-ins are days out.
- Business Standard has no Vault. The upgrade (or a Vault add-on) is required.
- Exact transcript layout inside the Vault export is confirmed at the first test (section 8.3).

## 11. Future ideas (not in this build)

- Drafts in each staff member's own mailbox (domain-wide delegation).
- Auto-send for specific trusted email types only.
- A "Calls" view in HouseBoss that links to the Calls Log.
- Using the same pipeline for texts/voicemails (Vault already exports them).
