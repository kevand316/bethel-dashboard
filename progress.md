# Bethel Dashboard — Build Progress

Last updated: 2026-07-27 (Quick Calc tab added)

---

## What's working in production now

**Authentication**
- Login page (`login.html`) — email/password sign-in, signup with email verification, forgot password, password reset via email link (`reset-password.html`)
- Auth gate on every page — visiting the dashboard while logged out redirects to login before any data loads
- Session persists across tab close and page reload (Supabase SDK, localStorage)
- Logout clears session and redirects
- Email verification is ON — new users must confirm email before first login

**Data isolation**
- Every user's data is completely separate — RLS on `bethel_data` enforces `user_id = auth.uid()` at the database level and in client code
- Composite primary key `(id, user_id)` means no upsert collision between users
- New users start with a blank starter home template; the operator's existing data is untouched

**Autosave**
- Every edit writes to a localStorage queue immediately (survives page close)
- Debounced Supabase upsert (800ms) with 3-attempt retry (5s, 15s backoff)
- Save indicator: `SAVING...` → `SAVED ✓` → `OFFLINE — WILL RETRY` → `SAVE FAILED` banner
- `pagehide`/`visibilitychange`/`beforeunload` flush the queue via keepalive fetch
- On next page load, any pending queue entries are drained before reading Supabase state

**Email infrastructure**
- Custom SMTP configured in Supabase Auth — sender `noreply@bethelresidency.com`, port 465, via Resend (verified 2026-05-03)
- All auth emails (signup confirmation, password reset) arrive from the branded address
- Supabase's default rate limit (30/hour) no longer applies — not a launch blocker

**Operations tab**
- Startup Cost input in a "Property Setup" card above the expense form
- CoC Return KPI cell: shows `—` when startup cost is 0, `X.X%` (green/red) when set
- Subheadline shows `Startup: $X,XXX` at all times

**Quick Calc tab**
- Stateless profitability scratch-pad — no Supabase, no autosave, resets on reload
- Inputs: beds, bedrooms, occupancy %, monthly rate per bed, flat monthly expenses
- Outputs recalculate on every keystroke: monthly revenue, expenses, cashflow, annual
  cashflow, margin, breakeven occupancy, and a PROFITABLE / NOT PROFITABLE verdict
- Rate range strip: low / base / high rate side by side, so the operator can see the
  spread before testing a price in a market
- "Save Projection PDF" prints just this view via the browser print dialog, same
  approach as `printOverview()`. Nothing is stored server-side.
- Zero beds or zero rate renders "—" everywhere rather than NaN/Infinity; occupancy
  clamps to 100%, negatives clamp to 0
- Tests: `tests/quickcalc.spec.js`, 4 `@smoke` tests

**Cross-device conflict detection (migration 002)**
- `bethel_data` has an `updated_at` column; every write explicitly advances it
- Conditional UPDATE: `WHERE updated_at = <last_loaded_value>` — if another device wrote since your load, 0 rows are returned and the conflict state fires
- Amber banner appears: "CHANGED ELSEWHERE — RELOAD or OVERRIDE AND SAVE ANYWAY"
- Reload: discards local edits, reloads from server
- Override: unconditional upsert ignores server version, saves local data, resumes conditional writes
- Bug fixed: Override button used `onclick` which fired after `blur` → `change` → `push()` hid the banner mid-click; changed to `onmousedown` so override runs before the input loses focus

---

## Tests passing

**21 passing, 2 failing** of 23 (`npx playwright test`) — see the conflict-detection bug below.

| File | Tests | Tags |
|------|-------|------|
| `tests/auth.spec.js` | invalid credentials error, logout + redirect, session persistence, corrupted token redirect | `@smoke` |
| `tests/autosave.spec.js` | happy path, network drop + recovery, reload-while-pending, cross-device conflict detection ❌, conflict override ❌, quota stress (1000 pushes), pagehide flush | `@autosave` |
| `tests/isolation.spec.js` | unauth redirect, two-user data isolation, unauthenticated API returns 0 rows | `@isolation` |
| `tests/login-page.spec.js` | 375px no scroll, tap targets ≥44px, short-PW validation, mismatch validation, forgot-password view | `@smoke` |
| `tests/quickcalc.spec.js` | defaults + profitable verdict, live recalc flips verdict, zero-beds em-dash states, rate range low/base/high | `@smoke` |

`.env.test` is gitignored and does not travel with the repo. If the suite refuses to start with
"SUPABASE_URL is not set", recreate it from `.env.test.example`; the `playwright-*` account
passwords were rotated 2026-07-27 via the Supabase admin API and exist only in that local file.

---

## Pre-launch tasks remaining

1. **Manual two-device test** — one session as operator, one as fresh signup, on real iPhone and Android. Full flow end to end including the conflict banner (edit same home on two devices simultaneously). Can't be automated. Required before course launch.

2. **Delete test accounts** — remove `playwright-a@bethel.test` and `playwright-b@bethel.test` from Supabase Auth → Users immediately before announcing to course members. Passwords were rotated 2026-07-27; they live only in the local gitignored `.env.test`.

3. **Separate test Supabase project** — currently test accounts live in the production project. Low urgency but clean this up before user count grows.

---

## Known bugs

- **Cross-device conflict detection does not fire (found 2026-07-27).** `lib/autosave.js`
  `executeWrite()` treats every conflict as a possible false positive: it sets `_loadedAt = null`
  and retries once. With `_loadedAt` null, `tryWrite()` takes the *unconditional upsert* branch,
  which always succeeds — so the retry returns `'ok'`, the banner is hidden, and the stale write
  silently overwrites the newer one. The "CHANGED ELSEWHERE" banner can effectively never appear.
  Both conflict tests in `tests/autosave.spec.js` fail because of this, and they fail on a clean
  checkout with no other changes present.
  Impact: one user editing the same home on two devices (phone + laptop) can lose the older
  device's edits with no warning. This does NOT cross user boundaries — RLS still isolates every
  account, so no user can affect another user's data.
  Fix needs its own TDD cycle: distinguish "our own keepalive advanced the timestamp" from
  "another device wrote" instead of collapsing both into an unconditional upsert.

## Known limitations / future work

- **Test accounts in production**: `playwright-a` and `playwright-b` exist in the same Supabase project as real users. They use `.test` domain emails and RLS keeps them isolated, but they should be deleted before launch.
- **iOS Safari private browsing**: localStorage is restricted in private mode. The autosave queue may not survive a page reload. Behavior is degraded but not silent — the save-failed banner will appear if Supabase is unreachable.
- **Session expiry mid-edit**: `onAuthStateChange` detects SIGNED_OUT and redirects to login. Any pending queue entries in localStorage are lost (they were written under the old user_id and won't drain on the next session). Accepted limitation; documented.
- **No admin panel**: operator creates accounts manually in Supabase dashboard. Fine for ≤100 users.
- **Snapshots feature (Reports tab)**: the existing JSON snapshot/comparison tool is already user-scoped via RLS. No visual screenshot/image capture feature — not needed.
