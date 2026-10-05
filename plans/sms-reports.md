# Plan: Text-In Reports, Report Buckets, Rent Tracker

## What we're building

Staff text a phone number in plain language. Claude reads the text, asks follow-up questions
until it has what it needs, confirms ("Reply YES"), and files a report on the dashboard.
Notifications go to the sender's supervisor. Move-ins and move-outs also update the bed roster.
Rent payments can be logged and checked by text too. The Profit Calculator can save a
projection into Reports.

Every login (account) gets this feature separately: its own team, reports and
notifications, isolated from every other account by RLS (`user_id = auth.uid()`), same as
`bethel_data` today.

## Why

House managers already know what happened; making them log into a dashboard and fill out
forms is the friction. A text is how they already communicate. The operator wants every
daily report, incident and maintenance request in one searchable place without anyone
learning a format.

## Decisions already made (don't re-litigate)

- **Storage is Supabase**: report rows plus photos in Supabase Storage. No Google Drive.
- **No HIPAA/BAA requirements for this feature.** Reports hold basic info (names, bed
  price, operational notes like "took Chris to the hospital"). PHI lives only in the
  intake form. **No health-detail filtering or warnings**: log texts as sent.
- **No required format.** We give staff a suggested format, but the AI must handle free text.
- **Text-first platform.** Every feature should have a texting path where it makes
  sense, not just reports. New features get designed with "how would this work by text?"
- **Per-account everything.** Built multi-tenant from day one; enabled for Bethel first.

## Report buckets (decided 2026-10-05; replaces the earlier 7-category list)

Every report lands in exactly one bucket. The AI classifies texts into these:

1. **Inventory**
2. **Incidents**: includes emergencies, conflicts, complaints, etc. Each incident gets a
   sub-type (emergency / conflict / complaint / other). Emergencies are still a flag that
   triggers the emergency handling in section 4; they just live in this bucket.
3. **Projections**: saved from the Profit Calculator (section 5b), named by the potential
   home's address. Not filed by text in v1.
4. **Maintenance**
5. **Cleanings**: includes the required daily report (e.g. times cleaned)
6. **Move-ins/outs**: one bucket, with a sub-type (move-in / move-out). Also updates the
   roster after approval (section 6).

More buckets can be added later; start with these six.

## Pieces

### 0. Organization profile
- New Profile settings: **Organization name** (e.g. "Bethel Residency"), required before
  texting is enabled.
- Shown in the dashboard header as a subheadline under "HouseBoss".
- Used in every outbound text, e.g. invite: "Kev at Bethel Residency added you to their
  HouseBoss team. Reply YES to join." Notifications: "[Bethel Residency] New maintenance
  request…" (replaces the short org tag in section 2).
- Invites always include the inviting person's name too, since org names aren't unique
  and someone could pick a look-alike name.

### 1. Team page (new tab)
- Table: name, phone, role, home(s), reports-to.
- Roles are user-editable (Owner, Operations Manager, House Manager, plus custom ones).
- Only numbers on this page can text in for this account; removal takes effect immediately.
- Role permissions: who can file reports vs. who can approve roster changes
  (default: House Manager files; Ops Manager+ approves move-ins/outs).
- A phone number may belong to more than one account (someone who works for two
  organizations). See "Which account?" below.

### 2. One shared number for all accounts (decided 2026-10-05)
- HouseBoss owns **one toll-free number**, verified once under HouseBoss / houseboss.ai.
  New customers are live the moment they add staff; no per-customer carrier paperwork.
- **The sender's phone number is the login.** Inbound text → find which account(s) list that
  number on their Team page → route to that account. Unknown number → no reply.
- **Which account?** If a number is on 2+ teams, the bot asks once ("Which org? 1) Bethel
  2) Acme") and remembers the choice. `SWITCH` changes it.
- **Joining:** the owner adds the person on the Team page. Optionally the dashboard shows a
  join code ("text JOIN BETHEL-4821") so staff can link themselves, pending owner approval.
- Outbound texts always name the org ("[Bethel] New maintenance request…") because every
  customer shares the number.
- Trade-offs accepted: messages show "HouseBoss", not the customer's name; one customer's
  spam complaints could affect the shared number, so we rate-limit per account.
- Development and testing use Twilio's Virtual Phone (no verification needed).

### 3. Inbound text handling (Supabase Edge Function `sms-inbound`)
- Twilio webhook → verify Twilio signature → look up sender's *From* number across all
  Team pages → pick account (ask if more than one) → unknown sender: ignore, no reply.
- Conversation state is stored per (account, sender) in a `sms_conversations` table so
  multi-message back-and-forth works. A draft expires after ~2 hours of silence (sender is told).
- Claude (Claude API, latest Sonnet) with tool use: classify, extract fields, ask what's
  missing, produce a one-line summary, wait for YES / corrections.
- MMS photos: download from Twilio, store in Storage under `{user_id}/reports/{id}/`,
  then delete the copy held by Twilio.
- Every report records: time, date, sender, role, home, category, summary, original texts,
  photos.

### 4. Notifications
- On filing: text the sender's "reports to" person with a one-line summary.
- **Notification rules (settings page):** the owner picks extra numbers to notify, by
  bucket and by home. E.g. "Maintenance at any home → Ops Manager + handyman",
  "Incidents at Oak St → Kev". Numbers must be team members (same YES-to-join consent).
  Rules add to the chain of command; they don't replace it.
- **Every notification is recorded on the report:** who was notified, when, and whether
  Twilio reported it delivered. Visible when opening the report.
- **Emergencies:** first auto-reply is always "If anyone is in danger, call 911 now."
  Alerts go to everyone up the chain at once, not one level at a time.
- **Daily report reminders** (pg_cron): if no cleaning/daily report by a set time
  (default 9pm, per account), nudge the house manager; if still missing next morning,
  tell their supervisor.

### 4b. Announcements (the number as a relay)
- The CEO (or any role allowed to send announcements, set on the Team page) texts
  e.g. "Announce to all house managers: inspection Friday 10am."
- AI identifies the audience (everyone / a role / a home / named people), then confirms:
  "Send to 6 people (5 House Managers, 1 Ops Manager)? Reply YES." Nothing goes out
  without YES.
- Recipients get "[Bethel Residency] From Kev: inspection Friday 10am."
- **Replies are relayed back** to the sender ("[Bethel Residency] James replied: got it")
  and attached to the announcement.
- Can also be sent from the dashboard (compose box, pick audience).
- Logged in Reports in an **Announcements** bucket (7th bucket, added for this) with the
  message, recipients, delivery status and all replies.

### 5. Reports tab
- The existing "Reports" tab is snapshots. Rename it **Snapshots** and make the new
  tab **Reports**.
- The six buckets as sub-tabs/filters across the top, with counts. Also filter by home,
  person and date range.
- Open a report to see the full text thread and photos; edit, print and PDF.
- Realtime: new reports appear without refresh.

### 5b. Save Profit Calculator results to Reports (Projections bucket)
- The Profit Calculator gets a **Save to Reports** button next to the existing
  Save Projection PDF.
- It asks for the **address of the potential home**; that address is the report's name
  (e.g. "1420 Elm St"). Required.
- Saves a snapshot of every input and result: beds, bedrooms, occupancy, rate, expense
  categories, low/base/high range, monthly and annual cashflow, verdict, saved date and
  who saved it.
- Opening it in Reports shows the numbers read-only, with print/PDF, and a
  **Load into Profit Calculator** button to tweak and re-save (saves as a new version;
  never overwrites the old one silently).
- Saving the same address again: ask "Replace or keep both?"
- This reverses the Quick Calc plan's "no saving" rule (`plans/quick-calc.md`) by request.
  The calculator itself stays a scratch-pad; only an explicit Save writes anything, and
  the save must follow the autosave rule: show "Saved" only after Supabase confirms.

### 6. Roster changes by text
- Approved move-in/move-out updates the bed roster.
- **Key risk:** the roster lives inside the single `bethel_data.data` jsonb blob that the
  browser autosaves with `updated_at` conflict detection. A server write while a tab is
  open must not be silently overwritten by that tab, and must not overwrite the tab.
  Server writes use the same conditional update (`updated_at` match, retry on conflict),
  and the open tab must pick up the change via its existing conflict path. This needs
  TDD before shipping.

### 6b. Rent tracker (new tab + texting)
Replaces Kev's monthly phone-note checklist.

**Dashboard**
- **Its own tab: "Rent".**
- **Organized by month.** Opens on the current month; a month picker and prev/next arrows
  browse any past month. Past months stay fully viewable (who paid, amounts, balances,
  dates) and remain editable for corrections, with each change logged.
- A month list/history view shows each month's expected, collected and outstanding totals
  at a glance.
- Month view grouped by home. One row per resident from
  the bed roster: name, bed, amount due (= bed price), paid, balance owed, date paid,
  who logged it.
- Check off "Paid in full" with one tap; or enter a partial amount.
- Unpaid balance carries into the next month as "past due", shown separately.
- Totals per home and overall: expected, collected, outstanding.
- New month's checklist creates itself automatically from the current roster.
- Move-in/move-out mid-month: resident appears/disappears from that month on; amount due is
  editable per row (no automatic proration in v1).

**By text**
- "Grant paid his rent" → AI finds Grant on the roster and records full payment for the
  current month, dated when the text was sent. Confirms: "[Bethel Residency] Grant, Oak St,
  October rent $650 paid in full. Reply YES."
- "Grant paid 300" → partial; reply includes remaining balance.
- AI asks instead of guessing when: two residents match the name, the name isn't on the
  roster, the amount doesn't match the bed price, or it's near a month boundary
  (last 3 / first 5 days: "Is this for October or November?").
- "Who owes rent?" / "Who hasn't paid at Oak St?" → list of unpaid/partial with balances.
  (First text *question* feature; others follow the same pattern later.)
- Permission: which roles can log payments is set per role on the Team page
  (default: House Manager and up).
- Optional: owner gets a text when a payment is logged, and a monthly summary on the 5th.

**Data**
- `rent_payments` table (`user_id`, resident id, month, amount, paid_at, logged_by, source:
  dashboard|text). RLS like every other table.
- Needs stable resident ids on roster entries (the roster is inside the `bethel_data` blob;
  add an id to each bed/resident if missing, and keep it through autosave).
- Isolation tests: Joe texting "Grant paid" never touches Bethel's Grant.

### 7. Admin view (for the platform owner)
- All accounts: message counts and estimated monthly cost per account.

## Isolation guarantees (Joe can never touch Kev's data, and vice versa)

1. **Database wall.** Every new table and the photo bucket carry `user_id` with RLS, same as
   `bethel_data`. The photo bucket is private; photos are served by short-lived signed URLs.
2. **The texting server is the real risk.** It runs with the service_role key, which bypasses
   RLS. So: the account is decided once, by code, from the sender's phone number. Every
   later query goes through helpers that require that `user_id` and add it to the filter.
   No raw queries.
3. **The AI cannot choose the account.** Claude's tools receive the account fixed by code;
   no tool takes an account or user id as input. A text from Joe saying "add Marcus to
   Bethel's Oak St house" can only ever reach Joe's account, which has no Oak St.
4. **Nobody can be added to a team without their consent.** Adding a number on the Team
   page sends that phone "Acme added you to their HouseBoss team. Reply YES to join." Until
   that phone replies YES, it is not on the team. This stops Joe from adding Kev's number
   (or Kev's staff) to his team to intercept or spam them.
   - Reply NO declines; reply BLOCK permanently blocks invites from that account.
   - Invites are rate-limited per account (no repeat-inviting the same number).
   - The Team page never reveals whether a number is on another account ("Invite sent" is
     shown either way).
   - Any member can text LEAVE to drop off a team instantly.
5. **Notifications only go to the same account's team.** The recipient is looked up within
   the account; there is no path to another account's people.
6. **Audit log.** Every text, AI action and data change is logged per account with time and
   sender.
7. **Tests block deploy.** A two-account test suite (extends `tests/isolation.spec.js`):
   - Joe's phone texting a report → appears only in Joe's dashboard.
   - Joe texting about Bethel's homes or residents → nothing changes in Bethel.
   - Joe adding Kev's number → no access until Kev's phone replies YES.
   - Joe's dashboard cannot list, open or load Bethel's reports or photos (direct URL too).
   - A number on both teams → asked which org; filed only where chosen.
   - Unknown number → no reply, nothing stored.

## Intake by text: approved approach (approved by Kev 2026-10-05)
Full intake *over text* is technically possible but ruled out: intake collects SSN and
health information, and taking it by text would put that data through Twilio, Anthropic and
the Supabase texting server, which brings back the BAA chain this feature deliberately
avoids, and sends SSNs as plain, unencrypted SMS.

**Instead:** texting "intake" (optionally "intake for Marcus, Oak St") replies with a
**secure one-time link** to the intake form. It opens on the phone and saves to Google Drive
exactly as intake works today. The text only carries the link, never the answers.
Links expire (e.g. 24 hours) and only go to team members whose role allows intake.
Details to work out when built: staff don't have dashboard logins, so the link must work
without one while still saving to the account owner's Drive folder.

## Already done (2026-10-05, not yet pushed)
- **Projections tab removed.** Its home-by-home table (beds, occupancy, revenue, expenses,
  cashflow, annual) now sits on the Overview page under a **Property Projections** section
  title, between the KPI boxes and Property Overview. Kev may want it moved below
  Property Overview; it's a quick swap.
- Not to be confused with the **Projections bucket** in Reports (Profit Calculator saves).

## New database objects (migration 003+)
`team_members`, `team_roles`, `notification_rules`, `notifications`,
`announcements`, `announcement_replies`, `sms_conversations`, `reports`,
`report_photos`, `rent_payments`, (projection saves are `reports` rows in the
projections bucket, with inputs/results in a jsonb column), and the Storage bucket `report-photos`. All tables carry `user_id` with RLS.
Edge functions use the service_role key from Supabase secrets, never from the repo.

## Step 1 detailed spec: Organization profile + Team page (status: DONE, live 2026-10-05)

Done so far:
- [x] Migration `003_org_profile_and_team.sql` applied 2026-10-05: `org_profiles`,
      `team_roles`, `team_members`, RLS on all three, cross-account references blocked,
      dashboard can never set a person "active".
- [x] Failing tests committed: `tests/team.spec.js` (8 tests).
- [x] `lib/team.js` wired in; Team tab live; 8/8 team tests + full suite green
      (only the untracked, pre-existing `tests/contrast.spec.js` failures remain).

What the operator will see:
- Header reads **HOUSEBOSS** with the organization name underneath ("Operations Dashboard"
  until a name is set). Browser tab title follows. Print headers use the org name.
- New **Team** tab, four sections, top to bottom:
  1. **Organization**: name field + Save. Shows "Saved ✓" only after Supabase confirms.
  2. **Add a person**: name, phone (any format; stored +1XXXXXXXXXX), role, homes
     ("All homes" or pick specific ones), reports to. Bad phone or a duplicate number on
     the same team is refused with a plain-English message.
  3. **Team**: one card per person: name, phone, status, role, homes, reports to, with
     Edit and Remove (Remove asks "Yes, remove / Keep" first).
     Status is **Pending: waiting for their YES** until texting is live (step 2).
  4. **Roles**: Owner, Operations Manager, House Manager created automatically. Each has
     on/off switches: file reports, approve move-ins/outs, log rent, send announcements,
     request intake links. Add custom roles; remove a role only if no one has it.
- Works at 375px phone width with no sideways scrolling.

Not in step 1: sending invite texts (step 2), login.html rebrand (with the domain move).

Done when: all 8 team tests pass, the full suite passes, Kev has seen it, then push.

## Step 2 detailed spec: Inbound texting + AI conversation + filing reports (status: DONE, live 2026-10-05)

Done: migrations 004 + 005 (`sms_blocks`) applied; Edge Functions `sms-inbound` and
`team-invite` deployed; Twilio number 1-888-BOSS-502 points at `sms-inbound`; Team page
sends invites + Resend button; `tests/sms.spec.js` (7) + `tests/team.spec.js` (9) green.
Real texts will flow once toll-free verification is approved; until then Twilio accepts
the send but carriers don't deliver.


**Database (migration 004)**
- `reports`: id, user_id, bucket (inventory | incidents | projections | maintenance |
  cleanings | move_ins_outs | announcements), subtype, urgent, home_id, home_name, title,
  summary, details (jsonb), sender_member_id, sender_name, sender_phone, source
  (text | dashboard | calculator), created_at. RLS per account.
- `report_photos`: report_id, storage_path, content_type. RLS per account.
- Private Storage bucket `report-photos`, paths `{user_id}/...`; a user can read only
  their own folder.
- `sms_messages`: audit log of every inbound and outbound text (account, phone, body,
  photo count, Twilio id, delivery status). Owner can read their own; only the server writes.
- `sms_conversations`: the in-progress chat per (account, phone): message history and
  the current draft report. Server-only.
- `sms_phone_prefs`: for a phone on 2+ accounts, which account it's currently texting.
  Server-only.
- `org_profiles.timezone`: captured from the browser when the org name is saved (used
  for "today", "this month", and dating reports).

**Edge Function `sms-inbound`** (Twilio webhook for 1-888-BOSS-502)
1. Verify Twilio's signature; reject anything unsigned.
2. Answer Twilio immediately; do the work in the background, then reply via the Twilio API
   (the AI can take longer than Twilio's 15-second webhook limit).
3. Log the inbound text.
4. Keywords first, no AI: **YES** to a pending invite activates it; **NO** declines;
   **BLOCK** blocks that account's invites; **LEAVE** drops off the team; **SWITCH**
   changes account; **HELP** lists what you can text. STOP/START are handled by Twilio.
5. Find the account from the sender's phone (active memberships only). None means no
   reply. 2+ accounts with no saved choice gets "Which org? 1) … 2) …".
6. Conversation: Claude (`claude-opus-5-5`, low effort, structured JSON output) gets
   the org, sender, role, homes, local date/time, the conversation so far, the current
   draft, and the new text. It returns the reply to send plus the updated draft. It asks
   follow-ups until bucket, home and the essentials are known, then ends with a
   one-line summary and "Reply YES to submit, or tell me what to change."
7. **YES with a complete draft is handled by code, not the AI:** the report is filed
   and the reply is "Submitted ✓". Conversation closes. A draft expires after 2 hours
   of silence.
8. Photos (MMS): downloaded from Twilio into `report-photos/{user_id}/...`, attached to
   the draft, then deleted from Twilio.
9. The AI has no way to choose the account: code fixes it before the AI runs, and the AI
   only returns text and a draft. It cannot read or write anything itself.

**Edge Function `team-invite`**: the dashboard calls it after adding a person
(signed-in user's token). It checks the person belongs to the caller's account, and
texts: "{Name} at {Org} added you to their HouseBoss team. Reply YES to join, NO to
decline." Team cards get a **Resend invite** button for pending people.

**Testing**: real outbound texts can't reach phones until toll-free verification is
approved. Phone numbers in the fictional 555-01xx range never get a real send; their
replies are only logged, which the tests read. `tests/sms.spec.js` sends signed fake
webhooks to the deployed function and checks:
- unsigned requests are rejected
- unknown numbers get no reply
- YES activates an invite
- a clear report gets filed in the right bucket
- an account can't receive another account's texts

## Step 3 detailed spec: Reports tab + Profit Calculator saves (status: DONE, live 2026-10-05)

Note: "projection" here always means a Profit Calculator result saved to Reports, named by the
potential home's address. Unrelated to the Overview page's Property Projections table.

- The old "Reports" tab (saved snapshots) is renamed **Snapshots**. The new **Reports**
  tab sits before it.
- **Bucket chips** across the top, with counts: All, Incidents, Maintenance, Cleanings,
  Move-ins/outs, Inventory, Projections, Announcements. Urgent incidents are marked.
- **Filters:** home, person, from-date and to-date.
- **Report cards,** newest first: title, bucket, urgent flag, home, who sent it, local
  date/time, summary, photo count.
- **Opening a card shows:**
  - all details, the full text conversation, and photos (private, short-lived links)
  - **Edit** (title, summary, bucket, home), **Delete** (asks first), and **Print / PDF**
  - for projections, the saved numbers and **Load into Profit Calculator**
- **New report** button for entries typed on the dashboard (bucket, home, title, details).
- **Live:** a texted report appears without refreshing (Supabase Realtime on `reports`).
- **Profit Calculator → Save to Reports:** asks for the potential home's address
  (required), then saves every input and result as a Projections report titled with
  that address. If one with that address already exists: **Replace** or **Keep both**.
  "Saved ✓" shows only after Supabase confirms.

## Step 4 detailed spec: Notifications, emergencies, daily reminders (status: DONE, live 2026-10-05)

- **Who gets notified when a report is filed** (by text or on the dashboard):
  - the sender's "reports to" person, plus everyone matching a **notification rule**
    for that bucket and home
  - **urgent** reports go to the sender's whole chain of command (supervisor, their
    supervisor, and so on) plus the rules
  - only active team members; never the sender; each person once
- **Message:** "[Org] New maintenance report from James (Oak St): Upstairs toilet
  leaking." Urgent: "[Org] URGENT incident from James (Oak St): …".
- **Recorded on the report:** a `notifications` row per person (who, phone, Twilio id,
  status). Twilio delivery callbacks (Edge Function `sms-status`) update the status:
  queued, sent, delivered or failed. The report detail lists "Notified: Dana (delivered)".
- **Notification rules** on the Team tab, in a new "Notifications" section: pick a bucket
  (or any), a home (or any), and a person, then Add. Each rule is listed with Remove.
- **Daily report reminders:**
  - a new role switch, **Must send a daily report** (on by default for House Manager)
  - org settings: reminder time (default 9pm) and escalation time (default 8am),
    local to the org's timezone
  - at reminder time, anyone with that switch who has filed no Cleanings report today
    gets "Reminder: today's daily report hasn't come in yet. Text it here."
  - at escalation time the next morning, if still nothing for yesterday, their
    supervisor gets "James didn't send yesterday's daily report (Oak St)."
  - each reminder goes out at most once per person per day (`reminder_log`)
  - runs via `pg_cron` every 15 minutes, calling Edge Function `daily-reminders` with a
    shared secret
- Emergencies keep the "call 911" first reply from step 2.

## Step 4b detailed spec: Announcements relay (status: DONE, live 2026-10-05)

**By text** (sender's role must allow "Send announcements"):
- A text starting with *announce*, *announcement*, *broadcast*, or *tell everyone / all /
  the team* starts an announcement. Anyone without permission is told so; nothing is sent.
- Claude extracts the message, **word for word** as written, and the audience: everyone,
  roles, homes, or named people. Code turns that into actual people (active members of
  the same account, never the sender).
- Confirmation first: "Send to 6 people (5 House Managers, 1 Operations Manager):
  'Inspection Friday 10am'? Reply YES." Nothing goes out without YES.
- Each recipient gets "[Org] From Dana: Inspection Friday 10am".
- The sender gets "Sent to 6 ✓".

**From the dashboard**: a **Send announcement** button on the Reports tab.
- Type the message and pick the audience: everyone, roles, homes, or people.
- It shows the count, then asks "Send to N people?" before sending.
- Uses the Edge Function `announce`, signed in as the caller.

**Logged**: every announcement is a report in the **Announcements** bucket. It shows the
message, the recipients with delivery status, and all replies.

**Replies are relayed**: when a recipient texts within 24 hours of an announcement and
it is a reply to it (Claude decides; a new report is still a report), the reply is
forwarded to the announcer: "[Org] James replied: got it". It's also added to the
announcement's replies, and James gets "Passed along to Dana ✓".

## Step 5 detailed spec: Move-ins/outs update the roster (status: DONE, live 2026-10-05)

**What the AI captures**: for Move-ins/outs it also fills a structured `roster` part of the
draft: move-in or move-out, the resident's name, the bed price (move-ins), and the date.

**Who can change the roster**: the sender's role switch **Approve move-ins/outs**.
- If the sender has it: on YES the report is filed **and** the roster updates at once.
  Reply: "Submitted ✓ … Roster updated: Marcus moved into Bed 4 at Oak St ($650)."
- If not: the report is filed as **Pending approval**. Everyone whose role can approve
  gets "[Org] James reports a move-in: Marcus, Oak St, $650. Reply APPROVE 4821 to
  update the roster." The first approver to reply APPROVE 4821 (or REJECT 4821)
  decides. The sender is told the outcome.
- On the dashboard, a pending move-in/out report shows **Apply to roster** and
  **Reject** buttons (Edge Function `roster-apply`, signed-in owner only).

**How the roster changes** (server, `_shared/roster.ts`):
- Move-in: the first vacant bed in that home (or the bed number if they said one)
  becomes occupied with the name, the price (or the bed's existing price), and the
  move-in date. A price of $3,000 or more becomes Recuperative Care, the same rule as
  the dashboard.
- Move-out: the occupied bed with that resident's name becomes vacant (name and
  move-in date cleared; the bed keeps its price). No match, or two matches, means
  nothing changes and the approver is told why.
- **Safe with an open dashboard**: the write is a conditional update on `updated_at`
  (the same check autosave uses), retried on a race. An open dashboard tab that later
  saves sees the newer version and shows its existing "changed elsewhere, RELOAD"
  banner instead of overwriting. Tested both ways.
- The report records what was applied, by whom, and when.

## Step 6 detailed spec: Rent tracker (status: DONE, live 2026-10-05)

**Data (migration 010)**
- `rent_charges`: one row per resident per month: month, home, bed, resident name, and
  amount due (from the bed price when created, editable).
- `rent_payments`: payments against a charge (amount, date, who logged it, dashboard or
  text, note). Deleting a payment is allowed and logged.
- `rent_events`: the change log (due edited, payment added or removed: who and when).

**Dashboard: new "Rent" tab**
- Opens on the current month; month picker plus ◀ ▶ arrows browse any month.
- **The current month's checklist builds itself from the roster**: every occupied or
  Recuperative Care bed with a name gets a row (due = bed price). Opening the current
  month again adds anyone who moved in since; it never deletes rows. Past months stay
  frozen as they were; an empty past month offers "Create from current roster".
- **Rows are grouped by home**: resident, bed, due (editable), paid, balance, status
  (Paid / Partial / Unpaid), last paid date, who logged it, and **past due** (unpaid
  balance from earlier months for the same resident at the same home).
- **On each row:** **Paid in full** pays the remaining balance in one tap; a partial
  amount box plus **Add**; and a payments list with **Remove**.
- **Totals** per home and overall: expected, collected, outstanding, past due.
- **History**: a list of months with expected, collected and outstanding; click one to
  open it.

**By text** (role switch "Log rent"):
- "Grant paid his rent" → finds Grant on this month's checklist and confirms:
  "[Org] Grant Smith, Oak St, October rent: $650 paid in full. Reply YES." YES records it.
- "Grant paid 300" → partial; the reply includes the remaining balance.
- **Asks instead of guessing** when:
  - two residents match
  - no one matches
  - it's within the first 5 or last 3 days of a month and no month was said
    ("Is this for October or November?")
- **The amount doesn't match**: an amount above what's owed is refused with what's owed.
- "Who owes rent?" / "Who hasn't paid at Oak St?" → a list of unpaid and partial
  residents with balances. No YES needed.
- The AI only extracts (payment or question, name, amount, month, home). Matching,
  amounts and recording are code.

## Step 6b detailed spec: Intake link by text (status: interim version DONE, live 2026-10-05; full version blocked on Kev)

**Interim, building now:**
- Team tab → Organization: an **Intake form link** field (https only).
- A text starting with "intake" from a role with "Request intake links" gets
  "[Org] Intake form: <link>". Without permission: refused. No link set: told to ask the owner.
- Only the link is ever texted; no intake answers pass through texting or the AI.

**Full version: blocked on Kev (morning list).** A one-time, expiring link that opens the
intake form without a login and saves straight to the account owner's Google Drive.
Proposed design that keeps SSNs off our servers:
- The browser uploads directly to Google.
- Our server only hands that page a short-lived Drive token (`drive.file` scope), minted
  from the owner's stored Google refresh token.

Needs from Kev:
1. a Google Cloud OAuth **client secret** with offline access (only Kev can create it)
2. his OK on this design

## Step 7 detailed spec: Join codes (status: DONE, live 2026-10-05)

(Multi-account handling, meaning "Which org?" and SWITCH, already shipped in step 2.)

- **Team tab → Join code panel:**
  - **Turn on** creates a code from the org name plus 4 digits, e.g. `BETHEL-4821`.
  - Shows "Staff text JOIN BETHEL-4821 Their Name to 1-888-BOSS-502".
  - **New code** replaces it (the old one stops working); **Turn off** disables joining.
- **By text:** "JOIN BETHEL-4821 Maria Lopez" creates a **join request** (status `requested`)
  on that account only. The reply is "Thanks Maria, your request to join Bethel Residency
  was sent."
  - **No name given:** "Text JOIN BETHEL-4821 followed by your name."
  - **Wrong or disabled code:** "That join code isn't valid."
  - **Already on the team, or blocked:** told so, or ignored if blocked.
  - **Rate limit:** at most 5 JOIN attempts per phone per day, so codes can't be guessed.
- **Team tab → Join requests:** each request shows name and phone, with a role picker,
  **Approve** and **Decline**.
  - **Approve** makes them active right away (they asked and the owner agreed, so both
    sides consented) and texts "You're on Bethel Residency's HouseBoss team…".
  - **Decline** removes the request quietly.
- Approve runs on the server (Edge Function `join-decide`), since the dashboard can never
  set anyone active by itself.

## Build order
1. Organization profile + Team page
2. Inbound texting plus AI conversation, filing reports (Virtual Phone)
3. Reports tab with the six buckets (with Snapshots rename)
3b. Profit Calculator "Save to Reports" (Projections bucket)
4b. Notification rules and Announcements relay
4. Notifications, emergencies and daily reminders
5. Move-in/out roster updates (TDD on the blob-conflict risk)
6. Rent tracker (dashboard first, then texting payments, then "who owes" questions)
6b. "intake" by text sends the secure intake link
7. Join codes and multi-account sender handling
8. Admin view

## Out of scope (for now)
- Asking general questions by text ("what's occupancy at Oak St?"). Next phase, except
  rent questions, which ship with the rent tracker.
- Profit calculator by text, and filing projections by text.
- Residents texting in.
- Staff dashboard logins (staff only text; the account owner logs in).

## Open items for Kev
- New domain: **houseboss.ai** (decided 2026-10-05). Use it on the toll-free verification form.
  Carriers' reviewers visit the site, so before submitting it needs a basic page naming
  HouseBoss, explaining staff texting, plus a privacy policy and SMS terms page.
- Twilio account: done. Number bought: **1-888-BOSS-502** (+1 888 267 7502).
- Toll-free verification: needs legal business name, address, EIN, contact name/email/phone, and houseboss.ai live (plus privacy policy and SMS terms pages).
- Anthropic API key: done (saved privately, loaded into Edge Function secrets).
