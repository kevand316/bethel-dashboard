# bethel-dashboard

Internal numbers dashboard for Bethel Residency, opening up to multi-user access.

This is a single-file vanilla HTML/CSS/JS dashboard backed by Supabase. It started as a personal tool for the operator (kevand316) and is being upgraded to support up to 100 isolated user accounts. Each user sees ONLY their own numbers, ever. There is no shared data between users.

## Commands

- `npx serve .` — start the local dev server on http://localhost:3000
- `npx playwright test` — run the full E2E test suite (auth, isolation, autosave, screenshots)
- `npx playwright test --grep @smoke` — run the fast smoke subset (used by hooks)
- `npx prettier --write .` — format the code
- `npx prettier --check .` — verify formatting (used by hooks)
- `npx playwright test --ui` — open Playwright in interactive mode for debugging
- `npx playwright codegen http://localhost:3000` — record new tests by clicking through the app

## Architecture

- `index.html` — the dashboard itself, post-login. Single file, ~2400 lines.
- `login.html` — login + forgot-password page. Branded, mobile-first.
- `lib/supabase.js` — thin wrapper around the Supabase JS SDK. ALL database calls go through here. Never bypass it with raw fetch.
- `lib/autosave.js` — autosave queue: writes go to Supabase, fall back to localStorage on failure, retry until confirmed, surface state as "saving... / saved ✓ / offline" indicator.
- `lib/auth.js` — auth gate: every page except login.html checks for a valid session on load and redirects to login.html if missing.
- `migrations/` — SQL files for Supabase schema changes. Numbered. Never edit a migration after it's run in production — write a new one.
- `tests/` — Playwright E2E tests. See `.claude/rules/testing.md` for required test patterns.

The dashboard is hosted on GitHub Pages at dashboard.bethelresidency.com (CNAME). Supabase project URL and anon key are public (safe to commit). The Supabase service_role key is NOT public — it must never appear in client code or commits.

## Standards

- Every database read and write MUST be scoped to the authenticated user. Row Level Security policies enforce this at the database level — but client code must also never construct a query that omits the user filter, because that's a code smell even when RLS catches it.
- Auto-save is sacred. A user's edit is not "saved" until Supabase confirms it. The UI must reflect actual state: "saving..." while in-flight, "saved ✓" only after confirmation, "offline — will retry" if queued. Never show "saved" optimistically.
- Use TDD for any new feature touching auth, data, or autosave. Write a failing Playwright test first. Confirm it fails. Commit it. Then implement until it passes. Do not modify the test to make it pass.
- Plan before coding for any non-trivial change. Use Plan Mode (Shift+Tab) and produce a `plans/<feature>.md` from `PLAN.md` before writing code.
- Mobile-first. The dashboard runs on phones too. Test layouts at 375px width.
- Branding: existing color CSS variables in index.html are the source of truth. Match them in login.html. Bebas Neue / IBM Plex Mono / IBM Plex Sans, already loaded via Google Fonts.

## Guardrails

NEVER do any of the following without explicit user confirmation in the same chat message:

- Disable or weaken Row Level Security policies on any Supabase table or storage bucket. RLS is the wall that keeps user A from seeing user B's data. It does not come down.
- Commit, log, or expose the Supabase service_role key, JWT secrets, SMTP credentials, or any secret from `.env`. The anon key is public and safe; nothing else is.
- Run destructive SQL: `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `DELETE` without a `WHERE`, or any `ALTER TABLE` that drops columns containing user data.
- Run `git push --force`, `git reset --hard`, `rm -rf`, or anything that rewrites or destroys local or remote history.
- Edit a migration file that has already been applied to production. Write a new migration instead.
- Change the autosave fallback to a strategy that can silently lose a write. Any code path that catches a save error must either retry or surface "save failed" to the user. Never both swallow and discard.
- Deploy to production (push to main / promote in Vercel / Pages) with failing tests, or without running the full Playwright suite at least once on the change.
- Send password reset emails to real user addresses during testing. Use throwaway accounts only.

When making a change that touches auth, data isolation, or autosave: write a Playwright test that proves the change works AND a test that proves the previous broken behavior is no longer possible. Both must pass.

## Workflow

1. Read this file and any `plans/<feature>.md` relevant to the current task.
2. If no plan exists for a non-trivial change, enter Plan Mode and create one before coding.
3. Write a failing test before any new behavior is implemented.
4. After every edit, the hooks in `.claude/settings.json` run prettier and the smoke test suite. Wait for them. If anything fails, fix it before moving on — do not ask the user to test.
5. Before declaring a task done: run the full Playwright suite (`npx playwright test`) and confirm green.
6. Before any deploy: re-run the full suite. The two-user isolation test (`tests/isolation.spec.js`) must be green or deploy is blocked.
7. When you make a mistake the user has to correct, suggest the user add a line to CLAUDE.md (or `.claude/rules/`) so the same mistake does not happen next session.

## Notes

- This file is the project's source of truth for Claude Code. Keep it under 200 lines. Detailed rules that apply to specific paths live in `.claude/rules/*.md` with `paths:` frontmatter so they lazy-load only when relevant files are touched.
- Use the `#` shortcut in Claude Code to add new instructions here as friction emerges.
- The operator (kevand316) is non-technical. Explain trade-offs in plain language. Propose technical decisions; do not ask the operator to make them.
