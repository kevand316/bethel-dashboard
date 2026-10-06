# Plan: Outreach tab (find referral organizations)

## What we're building
A tab where the operator types what kind of organization they want ("probation offices",
"hospital discharge planners") and an area, like a chat box. Claude searches the web live
(server-side web_search tool) and returns organizations in a fixed format: name, address,
point-of-contact phone (with contact name/title when found), email, website, and the source
page. Each search is saved as a collapsible list; each organization has a call status and a
notes box that saves as you type, so the list doubles as a call sheet.

## Decisions
- Edge function `outreach-search`: inserts an `outreach_lists` row (status searching),
  answers at once, and does the search in the background (EdgeRuntime.waitUntil); results
  go into `outreach_orgs`. The dashboard polls while a list is searching.
- Model claude-opus-5-5, web_search_20260209 (max 8 searches), structured output (JSON
  schema), effort medium, server-side fallback. Handles pause_turn (up to 4 resumes).
- Never invent contact details: anything not found on a page is null, every org carries
  the URL its details came from.
- Cap: 25 searches per account per day (counted from outreach_lists).
- Tables per account with RLS (user_id = auth.uid()); the dashboard edits notes/status and
  deletes lists; only the server inserts.
- Guide: category chips that fill the box, plus keyword tips.

## Out of scope
- Emailing/calling from the dashboard, deduping across lists, exporting (Print works later).

## Tests (tests/outreach.spec.js)
- Lists show collapsed; open shows every field; notes and status save (survive reload).
- Notes show Saving → Saved; a failed save says so and retries.
- Delete asks first. Guide chip fills the box. Fits 375px.
- @isolation: B sees none of A's lists or orgs, and can't write to them.
- Daily cap refused with a clear message. Not signed in = 401.
- Live: a real search for hospital discharge planners comes back with real-looking rows,
  each with a name and an http source.
