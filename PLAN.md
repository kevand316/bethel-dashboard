# Plan: <FEATURE NAME>

> Fill this out BEFORE writing code. Copy this file to `plans/<feature-name-kebab>.md` and check it in.
> Claude Code reads this in plan mode before implementation. Quality of the plan determines quality of the code.

## What we're building

One paragraph. What does this feature do, and from whose perspective?

## Why

What problem does this solve? Who's the user? What's the success criterion?

## Out of scope

List what we are explicitly NOT doing. This is as important as the in-scope list — it prevents the feature from sprawling.

- ...
- ...

## Acceptance criteria

The behaviors that must be true when this is done. Each one should be testable.

- [ ] ...
- [ ] ...
- [ ] ...

## Test plan

For each acceptance criterion above, what's the Playwright test? List them. These get written FIRST (TDD). Tag them appropriately (@smoke, @isolation, @autosave, @screenshots).

- ...
- ...

## Implementation outline

Rough steps, not code. Just enough that we agree on the shape before writing.

1. ...
2. ...
3. ...

## Edge cases and failure modes

What can go wrong? What inputs break this? What happens when the network fails / the DB is down / the user double-clicks / two devices edit at once / the session expires mid-edit?

- ...
- ...

## Files we expect to touch

Anticipated, not exhaustive. If implementation diverges from this list, that's a signal to pause and revisit the plan.

- `path/to/file.ext` — what changes here
- `path/to/test.ext` — new tests
- `migrations/NNN_description.sql` — schema change (if any)

## Migration safety (if schema changes)

- [ ] Migration is idempotent (safe to run twice)
- [ ] Migration includes RLS policies for any new table
- [ ] Migration backfills user_id (or equivalent) for any existing rows
- [ ] Rollback plan documented if migration is destructive

## Review checklist (before merging)

- [ ] All acceptance criteria have a passing test
- [ ] Hooks (prettier, smoke tests) all green
- [ ] Full Playwright suite (`npx playwright test`) green, including @isolation
- [ ] No new TODO comments left in the code without a follow-up task
- [ ] CLAUDE.md or `.claude/rules/*.md` updated if any new convention was introduced
- [ ] No secrets, credentials, or `.env` content committed
- [ ] Manual smoke test: log in as two different test users, confirm isolation by eye
