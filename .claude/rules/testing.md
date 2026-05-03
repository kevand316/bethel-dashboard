---
paths:
  - tests/**/*.spec.js
  - playwright.config.js
---

# Testing rules

Playwright is the test runner. All tests are E2E against a real local dev server hitting a real Supabase test project (NOT production). See `tests/README.md` for setup.

## Test taxonomy

Tag tests with Playwright tags so the hooks can run subsets:

- `@smoke` — fast, runs after every edit (target: full suite under 30s). Smoke tests cover: app loads, login page renders, auth gate redirects, basic save round-trip.
- `@isolation` — the two-user data isolation suite. Critical. Runs in CI and before every deploy.
- `@autosave` — autosave queue behavior, network failure simulation, queue drain.
- `@screenshots` — screenshot capture, storage, isolation.
- (untagged) — full suite, runs on demand.

## Required patterns

- **Two-user tests use Playwright's browser contexts.** Each user gets their own
  `context = await browser.newContext()` so cookies and localStorage are fully isolated. Never
  share a context between users.

- **Test users live in Supabase Auth as `playwright-a@bethel.test`, `playwright-b@bethel.test`.**
  Pre-created accounts — do not attempt to create them via service role during tests. Never use
  real user emails in tests.

- **Network simulation uses Playwright's `route` API.** To test save failures, intercept
  `**/rest/v1/bethel_data*` and respond with 500 or abort. To test offline, set
  `context.setOffline(true)`.

- **Every test that writes data cleans up after itself.** Use `afterEach` to delete rows the test
  created. If a test fails mid-way, the next run should still start clean — use `beforeEach` to
  truncate the test users' data.

- **Don't test the framework, test the behavior.** A test like "calling sbSet writes a row" is
  testing Supabase. A test like "after editing field X, refreshing the page shows the new value"
  is testing the behavior the user cares about. Write the second kind.

- **Test fixture URL guard.** `tests/fixtures/users.js` must check `process.env.SUPABASE_URL`
  against an explicit allowlist of known project URLs before executing any setup or teardown. If
  the URL isn't on the list, the fixture throws immediately with a descriptive error. This prevents
  a misconfigured `.env.test` from silently pointing tests at the wrong project. Tests currently
  run against `yqgccykbdihsjqlapghr.supabase.co`. When a separate test project is created later,
  update the allowlist — do not remove the guard.

## TDD discipline

For any feature change:

1. Write a test describing the new behavior. It must fail.
2. Run it. Confirm it fails for the right reason (assertion, not setup error).
3. Commit the failing test.
4. Implement until it passes.
5. Do not modify the test to make it pass. If the test is wrong, that's a separate decision; revert and rewrite, don't drift.

## Anti-patterns to refuse

- **Skipping or `.only`-ing tests to "fix later"** — fix now, or delete the test.
- **Sleeping with `page.waitForTimeout`** — wait for actual conditions: `waitForResponse`, `waitForSelector`, `waitForFunction`. Time-based waits are flaky.
- **Testing against production Supabase** — never. Tests use a separate Supabase project with its own URL and keys, configured via `.env.test`.
- **Tests that pass locally but the suite "is sometimes flaky in CI"** — flaky tests are broken tests. Fix the race condition; don't retry until green.
