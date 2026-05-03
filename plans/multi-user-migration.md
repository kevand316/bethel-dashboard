# Plan: Multi-user authentication and data isolation

> This is the day-one plan. The dashboard exists today as a single-tenant tool for the operator
> (kevand316). This plan converts it into a multi-tenant tool supporting up to 100 isolated users.

## What we're building

A login layer in front of the existing dashboard, with each user seeing only their own numbers,
screenshots, and reports. Brand-new users start with an empty dashboard. The operator's existing
data continues to belong to the operator and is invisible to all other users. A clean, branded
login page handles sign-in, forgot-password, and a support contact link.

## Terminology (read before touching any file in this repo)

Two features share similar names. They are completely separate:

- **Snapshots** — the existing Reports tab feature. A user clicks "Save Snapshot" to record a
  point-in-time summary of their portfolio numbers (revenue, cashflow, occupancy, etc.). Stored as
  `id='snapshots'` in `bethel_data`. Text-only data. Pre-existing.
- **Screenshots** — a new feature being added in this migration. An html2canvas capture of the
  visual dashboard, uploaded as a PNG to Supabase Storage. Stored in its own `screenshots` table
  with per-user RLS. New.

Whenever you see "snapshot" in this codebase, it refers to a portfolio summary report. Whenever
you see "screenshot" it refers to an image capture. These words are never interchangeable.

## Why

The dashboard is being opened to outside users. The current architecture has no authentication, no
user identity, and no data isolation — everyone hitting the URL sees the same single bucket of
data. This is fine for one user; catastrophic for many. The success criterion is: two users can
use the dashboard simultaneously, each with their own numbers, and there is no possible action
either can take to see the other's data.

## Out of scope

- Email verification (operator confirmed: skip unless required for password reset to work).
- User self-signup. Accounts are created by the operator via Supabase dashboard. Public signup can
  come later.
- Roles / permissions / sharing between users. Each user is a sealed island for now.
- Billing, subscriptions, payment integration.
- Admin panel for the operator to manage users (manual creation in Supabase is fine for 100
  users).
- Migration of any data other than the operator's existing rows. New users start empty.
- Email customization beyond the default Supabase template (can revisit later).

## Acceptance criteria

- [ ] Visiting `dashboard.bethelresidency.com` while logged out redirects to the login page before
      any data fetch fires.
- [ ] Login page accepts email + password, signs the user in via Supabase Auth, and lands them on
      the dashboard with their own data.
- [ ] Login page has a "Forgot password?" link prominently displayed. Clicking it triggers
      Supabase's reset-password email flow. The reset link works end-to-end and lets the user set a
      new password.
- [ ] Login page has a "Contact support" link / button that opens a `mailto:info@bethelresidency.com`
      link.
- [ ] Login page is mobile-friendly (tested at 375px width) and matches existing brand colors and
      fonts.
- [ ] Logged-in users see only rows in `bethel_data` where `user_id = auth.uid()`. Verified by RLS
      policy AND by client query.
- [ ] User A cannot, by any means tested (URL guessing, direct API calls with their own JWT,
      modifying browser storage), retrieve any of user B's data.
- [ ] Two different users can each hold an `id='homes'` and `id='snapshots'` row simultaneously in
      `bethel_data` without either overwriting the other. Verified by Playwright test and by the
      composite primary key constraint `(id, user_id)`.
- [ ] Auto-save indicator shows correct state at all times: "saving..." while in-flight, "saved ✓"
      only after Supabase confirms, "offline — will retry" if queued, "save failed" only after
      retries exhausted.
- [ ] An edit made and not yet confirmed survives a page reload (queued in localStorage, replayed
      on next load).
- [ ] Screenshot feature works: capture, list in reports tab, download — all scoped to the
      logged-in user.
- [ ] Operator's existing data is preserved and visible only to the operator after migration.
- [ ] Logout button signs the user out and redirects to login.
- [ ] Session persistence: closing the tab and reopening within session lifetime keeps the user
      logged in.

## Test plan

Playwright suite. Each bullet becomes one or more `*.spec.js` tests, written FIRST.

- `tests/auth.spec.js @smoke`: unauthenticated visit to dashboard redirects to login before any
  `bethel_data` fetch. Verified by inspecting network in the test.
- `tests/auth.spec.js @smoke`: valid credentials log in and land on dashboard with the user's own
  data displayed.
- `tests/auth.spec.js`: invalid credentials show a clear error message, do not navigate.
- `tests/auth.spec.js`: forgot-password flow: enter email, follow link, set new password, confirm
  new password works for login.
- `tests/auth.spec.js @smoke`: logout button clears session and redirects to login.
- `tests/auth.spec.js`: session persists across tab close + reopen within session lifetime.
- `tests/auth.spec.js`: expired/tampered JWT triggers redirect to login, no stale data renders.
- `tests/isolation.spec.js @isolation`: two-user write/read isolation. User A logs in, writes data
  X. User B logs in (separate browser context), dashboard shows empty / B's own data only. B
  cannot see X.
- `tests/isolation.spec.js @isolation`: direct API attempt by user B to fetch user A's row by
  guessing ID returns empty (RLS blocks).
- `tests/isolation.spec.js @isolation`: user B cannot list, view, or download user A's screenshots.
- `tests/isolation.spec.js @isolation`: two-user upsert collision test. User A saves `id='homes'`.
  User B saves `id='homes'`. Both reload. Each sees only their own data and neither write
  overwrote the other. Confirms composite primary key `(id, user_id)` is working.
- `tests/autosave.spec.js @autosave @smoke`: edit a numeric field, see "saving...", wait, see
  "saved ✓", reload, value persists.
- `tests/autosave.spec.js @autosave`: with network failed (Playwright route abort), edit a field,
  indicator goes to "offline — will retry", queue persists in localStorage, network restored,
  queue drains, indicator reaches "saved ✓".
- `tests/autosave.spec.js @autosave`: edit during pending save, reload page, queue replays, value
  reaches Supabase.
- `tests/autosave.spec.js @autosave`: `pagehide` event triggers immediate flush.
- `tests/screenshots.spec.js @screenshots`: capture screenshot, appears in reports, persists
  across reload, downloads correctly.
- `tests/screenshots.spec.js @screenshots @isolation`: user B cannot access user A's screenshots
  by direct path.
- `tests/login-page.spec.js @smoke`: login page renders at 375px without horizontal scroll, all
  interactive elements tappable, branding colors and fonts match.

## Implementation outline

1. **Supabase setup (manual, operator-driven)**: Tests run against the existing Supabase project
   (`yqgccykbdihsjqlapghr.supabase.co`) using pre-created isolated test accounts
   (`playwright-a@bethel.test`, `playwright-b@bethel.test`). No separate test project is needed at
   this stage. **Risk:** test data lives in the same project as real data — test fixtures must
   clean up after every run, and the pre-launch checklist must confirm no test data remains before
   go-live. Known UIDs for reference: operator `a2d76e85-effe-4146-b967-07fbf9fad6f4`,
   playwright-a `cd46c4c8-0a83-48bc-8b22-16dbdb139849`,
   playwright-b `d90cb8c5-62f1-4f04-b19c-5a2712a8e147`. Service-role key is not required —
   fixtures authenticate via email/password using pre-created accounts.

2. **Migration `001_enable_auth_and_rls.sql`**:
   - (a) Drop the existing single-column primary key on `bethel_data.id`
   - (b) Add `user_id uuid references auth.users(id)`
   - (c) Backfill **both** existing rows (`id='homes'` and `id='snapshots'`) with the operator's
     auth user ID `a2d76e85-effe-4146-b967-07fbf9fad6f4`. These hold distinct features —
     `id='homes'` is property/bed/expense data; `id='snapshots'` is saved portfolio summary
     reports — but both belong to the operator and receive identical treatment here.
   - (d) Make `user_id` NOT NULL after backfill
   - (e) Add composite primary key on `(id, user_id)`
   - (f) Enable RLS. Add policies: `select`, `insert`, `update`, `delete` all gated on
     `user_id = auth.uid()`
   - (g) Idempotent — safe to run twice with no harm
   - Note: the upsert in `lib/supabase.js` must use `on_conflict=id,user_id` so that saves
     correctly update the user's existing row rather than failing on the composite key constraint.

3. **Migration `002_screenshots_table.sql`**: Creates the **screenshots** table — this is a new
   feature, entirely distinct from the existing **snapshots** feature (already handled in migration
   001 above). Screenshots are html2canvas captures of the dashboard view saved as PNG files to
   Supabase Storage. The snapshots feature (saved portfolio summary reports) continues to live in
   `bethel_data`. Create `screenshots` table (`id`, `user_id`, `created_at`, `storage_path`,
   `label`). RLS policies. Create Storage bucket `screenshots` with per-user-folder RLS.

4. **Migration `003_profiles_table.sql`** (if needed): minimal `profiles` table for any
   user-facing display data. RLS: read own row only.

5. **`lib/supabase.js`**: replace raw fetch wrapper with Supabase JS client (loaded via CDN script
   tag in HTML). Single shared instance. All reads/writes go through it.

6. **`lib/auth.js`**: session check on page load. Redirect to login if missing. Logout function.
   Listen for `onAuthStateChange` to handle session expiry mid-session.

7. **`lib/autosave.js`**: **This is the largest single implementation task in the plan.** It is
   not a simple file — it is a complete queue-based autosave system as specified in
   `.claude/rules/autosave.md`, including: a write queue with per-entry context
   `{id, user_id, table, row_id, column, new_value, timestamp, attempts}`, a retry loop,
   localStorage as a pending-writes queue (not a permanent fallback), cross-device conflict
   detection via `updated_at`, `pagehide`/`visibilitychange` flush, and a four-state status
   indicator ("saving...", "saved ✓", "offline — will retry", "save failed — please reload"). It
   also requires six Playwright test scenarios before it can be declared done. **This should be
   its own focused work session, not bundled with other items.**

8. **`login.html`**: clean, sleek, mobile-first. Email input, password input, "Sign in" button,
   "Forgot password?" link, "Contact support" mailto link. Match brand colors from `index.html`'s
   CSS variables.

9. **`reset-password.html`**: receives the user from the reset email link, lets them set a new
   password.

10. **`index.html` updates**: add auth gate at top. Replace raw fetch calls with `lib/supabase.js`.
    Add autosave indicator. Add logout button.

11. **`lib/screenshots.js`**: capture via html2canvas, upload to Storage, insert row, list in
    reports, signed-URL download.

12. **Playwright setup**: `playwright.config.js`, test fixtures for the two test users, `.env.test`
    for test credentials, `tests/README.md` documenting setup.

13. **Write all tests first** (TDD). Confirm they fail. Then implement.

## Edge cases and failure modes

- User opens dashboard in two tabs, edits in both. Last write wins; user sees "this was changed
  elsewhere" warning.
- Session expires mid-edit. Auth state listener detects it, surfaces a re-auth prompt without
  losing the in-progress edit (queue holds it; replay after re-login).
- localStorage full or disabled. Surface a banner: "your browser is blocking storage; saves may
  not retry on failure."
- User clears cookies / localStorage mid-session. Next save attempt finds no session, redirects
  to login. The pending queue is gone — accept this loss; document in known limitations.
- Supabase outage. Queue holds writes indefinitely. Surface "service offline" banner. Drain on
  recovery.
- Operator's data backfill collision: if the operator's auth user doesn't exist yet at migration
  time, the migration fails loudly (not silently leaving rows orphaned).
- User on iOS Safari with private browsing — localStorage limited. Test this; document if
  degraded.
- Reset-password email lands in spam. Document in support contact response template.
- Rate-limiting on Supabase auth (default 30 reset emails per hour). Document, surface as
  friendly error if hit.

## Files we expect to touch

- `migrations/001_enable_auth_and_rls.sql` — new
- `migrations/002_screenshots_table.sql` — new
- `migrations/003_profiles_table.sql` — new (if needed)
- `lib/supabase.js` — new
- `lib/auth.js` — new
- `lib/autosave.js` — new
- `lib/screenshots.js` — new
- `login.html` — new
- `reset-password.html` — new
- `index.html` — modified (auth gate, autosave indicator, logout, swap fetch for SDK)
- `playwright.config.js` — new
- `tests/auth.spec.js`, `tests/isolation.spec.js`, `tests/autosave.spec.js`,
  `tests/screenshots.spec.js`, `tests/login-page.spec.js` — new
- `tests/fixtures/users.js` — new (sign-in helpers + URL guard)
- `tests/README.md` — new
- `package.json` — new (devDependencies: playwright, prettier, serve, dotenv)
- `.env.example`, `.env.test.example` — updated
- `.gitignore` — already correct
- `.prettierrc` — already in place

## Migration safety

- [x] Migrations are idempotent (use `if not exists`, conditional backfills)
- [x] Every new table includes RLS enable + policies in the same migration file
- [x] Operator's existing rows (`id='homes'` and `id='snapshots'`) are backfilled with their
      `user_id` before NOT NULL is enforced
- [x] Rollback plan: each migration has a documented manual rollback path in a comment at the top
      of the SQL file
- [x] Composite primary key `(id, user_id)` replaces the single-column PK — prevents multi-user
      upsert collisions

## Pre-launch checklist

Complete before the app goes live to any real user other than the operator.

- [ ] Operator auth user confirmed in Supabase — email `info@bethelresidency.com`,
      auto-confirmed, UID `a2d76e85-effe-4146-b967-07fbf9fad6f4`
- [ ] Migration 001 applied: operator's `homes` and `snapshots` rows visible in Supabase Table
      Editor under the operator's `user_id`, correct data, nothing lost
- [ ] RLS confirmed on in Supabase — `bethel_data` shows "RLS enabled" in Table Editor
- [ ] Password-reset redirect URL `https://dashboard.bethelresidency.com/reset-password.html`
      added in Supabase Auth → URL Configuration
- [ ] Default Supabase reset email template reviewed — subject line and body acceptable for
      real users
- [ ] Manual two-user test on real phones: one session as operator (existing data), one as a
      fresh signup (blank slate) — on actual iPhone AND Android devices. Full flow: sign up →
      verify email → log in → edit numbers → see SAVED ✓ → log out. Confirm neither session
      can see the other's data. This test cannot be automated — do it before any course launch.
- [ ] Full Playwright suite green including `@isolation`
- [ ] Delete `playwright-a@bethel.test` and `playwright-b@bethel.test` from Supabase Auth →
      Users immediately before announcing the dashboard to course members. These accounts live
      in the production project and must not exist when real users are active.
- [ ] When moving to a separate Supabase test project (future): create new playwright-a and
      playwright-b accounts there, update `ALLOWED_SUPABASE_URLS` in `tests/fixtures/users.js`,
      and update `.env.test.example` with the new project URL and anon key.
- [ ] Cross-device conflict detection implemented and the skipped `@autosave` test passing
      before announcing that the dashboard supports multi-device editing. The test is in
      `tests/autosave.spec.js` marked `test.skip` with comment "deferred to migration 002".
- [ ] No residual test data visible in the operator's account after final cleanup run

## Review checklist (before merging)

- [ ] All acceptance criteria have a passing Playwright test
- [ ] `npx prettier --check .` clean
- [ ] `npx playwright test` full suite green (including `@isolation`)
- [ ] Manual two-user test by operator: two browsers, two test accounts, edit in each, confirm
      isolation by eye
- [ ] Manual mobile test by operator: open login + dashboard on phone, complete a full edit +
      screenshot flow
- [ ] CLAUDE.md and `.claude/rules/*.md` reflect any new conventions discovered during build
- [ ] No secrets, no service-role key, no `.env` content committed
- [ ] Production Supabase migrations applied in order, backfill verified by spot-checking
      operator's data is intact and visible
