# Tests

Playwright E2E tests for the Bethel Residency dashboard. Tests run against a real local dev
server connected to the live Supabase project using isolated test user accounts.

## One-time setup

1. Copy `.env.test.example` to `.env.test` and fill in the values (ask the operator for
   credentials if you don't have them).
2. Install dependencies: `npm install`
3. Install Playwright browsers: `npx playwright install chromium`

## Running tests

```bash
# Full suite
npm test

# Smoke tests only — fast, run after every edit
npm run test:smoke

# Isolation tests only — must be green before every deploy
npm run test:isolation

# Interactive UI (good for debugging a failing test)
npx playwright test --ui

# Record a new test by clicking through the live app
npx playwright codegen http://localhost:3000
```

## Test accounts

Two accounts are pre-created in Supabase and used only by automated tests:

| Account | Email                      | Notes                                  |
| ------- | -------------------------- | -------------------------------------- |
| User A  | `playwright-a@bethel.test` | Isolation test — writes data           |
| User B  | `playwright-b@bethel.test` | Isolation test — must not see A's data |

Credentials live in `.env.test`. These accounts exist in the same Supabase project as
production. Fixtures must clean up all data after every test run.

## URL guard

`tests/fixtures/users.js` checks `SUPABASE_URL` against an allowlist before doing anything.
If the URL doesn't match, the test suite exits immediately with an error. Do not remove this
guard — update the allowlist if you add a new project.

## Test tags

| Tag            | When it runs                     | What it covers                              |
| -------------- | -------------------------------- | ------------------------------------------- |
| `@smoke`       | After every file edit (via hook) | App loads, auth gate, basic save round-trip |
| `@isolation`   | CI + before every deploy         | Two-user data isolation, RLS verification   |
| `@autosave`    | On demand                        | Save queue, retry, network failure, flush   |
| `@screenshots` | On demand                        | Capture, storage, per-user isolation        |

## TDD discipline

Every test is written BEFORE its feature exists. The expected workflow:

1. Write a test. Run it. Confirm it **fails** for the right reason (assertion, not setup error).
2. Commit the failing test.
3. Implement the feature until the test passes.
4. Do not modify the test to make it pass — revert and rewrite if the test was wrong.
