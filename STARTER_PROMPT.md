# Day-one starter prompt for Claude Code

Copy everything between the lines below and paste it into Claude Code as your first message after dropping these files into your repo.

---

I've just bootstrapped this project with a new structure. Read these files in order before responding:

1. `CLAUDE.md` — project context, commands, standards, guardrails, workflow.
2. `.claude/settings.json` — the hooks that run automatically on every edit.
3. `.claude/rules/auth.md`, `.claude/rules/autosave.md`, `.claude/rules/screenshots.md`, `.claude/rules/testing.md` — scoped rules that apply when you touch matching files.
4. `plans/multi-user-migration.md` — the full plan for the work we're about to do. This is the day-one feature.

After you've read all of those, do NOT start coding yet. Instead:

**Phase 1: Audit the existing dashboard.** Walk through `index.html` and report back, in plain language:
- What does it currently do? (Confirm my understanding from the plan.)
- What's the actual data model in Supabase right now? List the tables, columns, and any existing RLS policies.
- What concrete bugs, fragile spots, or risks do you see *in the existing code* — separate from the multi-user migration? Things like: race conditions in the autosave, missing error handling, accessibility issues, brittle DOM selectors, anything else.
- Rank what you find by severity (would-lose-data > would-confuse-user > cosmetic).

Just report. Don't fix anything yet.

**Phase 2: Confirm the plan.** After the audit, tell me whether `plans/multi-user-migration.md` still looks right given what you found, or whether anything in the plan needs to change before we start. If anything in the plan is wrong or missing, say so explicitly. Don't be polite about it — if I missed something, I want to know now, not after we've written half the code.

**Phase 3: Set up the test infrastructure.** Once I've approved the plan, before any feature code: install Playwright and Prettier, create `playwright.config.js`, write `tests/fixtures/users.js` to create/clean test users, and write the FIRST failing test (the two-user isolation test from `plans/multi-user-migration.md`). Run it. Confirm it fails for the right reason (auth doesn't exist yet, not because of a setup error). Show me the failure output.

Then we proceed feature by feature, TDD-style, per the plan. After every change, the hooks will run prettier and the smoke tests automatically — wait for them, fix anything red before moving on.

Important reminders:
- I am the operator (kevand316). I'm non-technical. Explain things in plain language. Decide on technical specifics yourself; don't quiz me.
- Never disable RLS, never expose the service-role key, never run destructive SQL without explicit confirmation in chat.
- Production Supabase is sacred — for tests, we use a separate test Supabase project (I'll create it; you tell me when to).
- The disaster I am most afraid of: a user spends an hour entering their numbers, comes back tomorrow, the data is gone. The autosave rules in `.claude/rules/autosave.md` exist to prevent exactly this. Treat them as inviolable.

Begin with Phase 1. Take your time. The audit is the most valuable thing you can do today.

---
