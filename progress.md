# Bethel Dashboard — Build Progress

Last updated: 2026-07-27 (Profit Calculator tab; conflict detection fixed)

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

**Profit Calculator tab** (internally still `view-quickcalc` / `qc-*` ids)
- Stateless profitability scratch-pad — no Supabase, no autosave, resets on reload
- Inputs: beds, bedrooms, occupancy %, monthly rate per bed, and five expense
  categories — rent/mortgage, utilities, supplies, staff, operations — which are
  summed. Operations is the catch-all (insurance, maintenance, admin, food), so the
  total stays honest rather than quietly omitting real costs.
- Home defaults: 12 beds across 6 bedrooms (two per room on average)
- Expense defaults are typical 12-bed starting figures — rent $5,000, utilities $600,
  supplies $175, staff $850, operations $100 — totalling $6,725
- Staff mirrors the bed rate (the house lead occupies a bed rent-free) and keeps
  following it until the operator types their own figure, after which it is left alone.
  The rate range does NOT vary staff — only the rate charged per bed changes.
- **Occupancy resolves to whole beds before any money math.** 85% of 12 beds is 10.2, and
  a fraction of a resident pays nothing, so revenue is `round(beds x occupancy) x rate`.
  Ordinary half-up rounding: 10.2 -> 10, 10.8 -> 11, exactly 8.5 -> 9. Flooring was tried
  first and rejected — it cost the home a nearly-full bed at 10.8.
  The occupancy line states which way it rounded, so the adjustment is never silent.
  Breakeven follows the same half-up rule, with one guard: with any expenses on the
  books it never reports 0 beds, since rounding alone would claim a home with $400 of
  costs breaks even standing empty.
- Outputs recalculate on every keystroke: monthly revenue, expenses, cashflow, annual
  cashflow, margin, breakeven occupancy, and a PROFITABLE / BREAKS EVEN / NOT PROFITABLE verdict
- Rate range strip: low / base / high rate side by side, so the operator can see the
  spread before testing a price in a market
- "Save Projection PDF" prints just this view via the browser print dialog, same
  approach as `printOverview()`. Nothing is stored server-side.
- Zero beds or zero rate renders "—" everywhere rather than NaN/Infinity; occupancy
  clamps to 100%, negatives clamp to 0
- Tests: `tests/quickcalc.spec.js`, 8 `@smoke` tests

**Cross-device conflict detection (migration 002)**
- `bethel_data` has an `updated_at` column; every write explicitly advances it
- Conditional UPDATE: `WHERE updated_at = <last_loaded_value>` — if another device wrote since your load, 0 rows are returned and the conflict state fires
- Amber banner appears: "CHANGED ELSEWHERE — RELOAD or OVERRIDE AND SAVE ANYWAY"
- Reload: discards local edits, reloads from server
- Override: unconditional upsert ignores server version, saves local data, resumes conditional writes
- Bug fixed: Override button used `onclick` which fired after `blur` → `change` → `push()` hid the banner mid-click; changed to `onmousedown` so override runs before the input loses focus

---

## Tests passing

**29 passing, 0 failing** (`npx playwright test`) — first fully green run; the two conflict
tests had been red since they were written.

| File | Tests | Tags |
|------|-------|------|
| `tests/auth.spec.js` | invalid credentials error, logout + redirect, session persistence, corrupted token redirect | `@smoke` |
| `tests/autosave.spec.js` | happy path, network drop + recovery, reload-while-pending, cross-device conflict detection, **stale write does not overwrite**, conflict override, quota stress (1000 pushes), pagehide flush | `@autosave` |
| `tests/isolation.spec.js` | unauth redirect, two-user data isolation, unauthenticated API returns 0 rows | `@isolation` |
| `tests/login-page.spec.js` | 375px no scroll, tap targets ≥44px, short-PW validation, mismatch validation, forgot-password view | `@smoke` |
| `tests/quickcalc.spec.js` | defaults + profitable verdict, live recalc flips verdict, zero-beds em-dash states, expense categories sum, staff follows bed rate, rate range low/base/high | `@smoke` |

`.env.test` is gitignored and does not travel with the repo. If the suite refuses to start with
"SUPABASE_URL is not set", recreate it from `.env.test.example`; the `playwright-*` account
passwords were rotated 2026-07-27 via the Supabase admin API and exist only in that local file.

---

## Pre-launch tasks remaining

1. **Manual two-device test** — one session as operator, one as fresh signup, on real iPhone and Android. Full flow end to end including the conflict banner (edit same home on two devices simultaneously). Can't be automated. Required before course launch.

2. **Delete test accounts** — remove `playwright-a@bethel.test` and `playwright-b@bethel.test` from Supabase Auth → Users immediately before announcing to course members. Passwords were rotated 2026-07-27; they live only in the local gitignored `.env.test`.

3. **Separate test Supabase project** — currently test accounts live in the production project. Low urgency but clean this up before user count grows.

---

## Fixed 2026-07-27: cross-device conflict detection never fired

**The bug.** `executeWrite()` treated every conflict as a possible false positive: it set
`_loadedAt = null` and retried once. With `_loadedAt` null, `tryWrite()` takes the
*unconditional upsert* branch, which always succeeds — so the retry returned `'ok'`, the banner
was hidden, and the stale write silently overwrote the newer one. The "CHANGED ELSEWHERE" banner
could effectively never appear. Editing the same home on a phone and a laptop lost the older
device's work with no warning, while showing "SAVED ✓". It never crossed user boundaries — RLS
isolates every account regardless.

**The fix.** A conflict is now *attributed* before it is acted on. `lib/autosave.js` keeps
`_ourTimestamps`, the `updated_at` values this session wrote. On a conflict it reads the row's
current timestamp from the server:

- Ours (a concurrent in-page write) or the row is gone → resync `_loadedAt` and retry, still
  conditional. No banner; nobody else's work was at stake.
- Anyone else's, **or the read failed** → leave the server untouched, queue the entry, show the
  banner. Anything we cannot positively attribute to ourselves is treated as another device.

**Tried and reverted.** Making `flush()` choose its own timestamp and keeping the next write
conditional. Keepalive is fire-and-forget, so when one does not land `_loadedAt` diverges from
the server and *every* later save reports a conflict — it took the suite from 2 failures to 6.
`flush()` still clears `_loadedAt`; the residual window is under Known limitations.

**Proof.** `tests/autosave.spec.js` gained "stale write does not overwrite the newer value on the
server", which asserts on the stored data rather than the banner: device A saves 31111, stale
device B tries 32222, and Supabase must still hold 31111.

## Fixed 2026-07-28: a failed initial load bricked the session (and caused a flaky test)

`initData()` gave up after one failed read of the `homes` row: it showed a toast and
returned *before* the line that sets the save indicator. The indicator stayed blank
forever — not "offline", not "failed", blank, which reads as "everything is fine" —
with no data loaded and no retry. The only way out was for the operator to guess that a
reload was needed.

This was also the intermittent suite failure: `signInAndWaitForLoad` timing out with
`Received: ""`. Not a slow load — nothing was ever going to change that value.

Worth recording for the next person who chases it: an aborted connection does **not**
reproduce this. The Supabase client retries a dropped socket itself, so the abort never
reaches `initData` as a failure and the load recovers on its own. A 500 response is
passed straight through, and that is the case that was mishandled. The regression test
uses a 500 for that reason.

Fix: retry the initial read twice (1s, then 2s) before falling back to local copies, and
never leave the indicator blank — `LOADING...` while working, `RETRYING...` between
attempts, `LOAD FAILED` if it genuinely cannot load.

## Known limitations / future work

- **Test accounts in production**: `playwright-a` and `playwright-b` exist in the same Supabase project as real users. They use `.test` domain emails and RLS keeps them isolated, but they should be deleted before launch.
- **Overwrite window after a page-hide flush**: `flush()` fires keepalive writes and clears
  `_loadedAt`, so the next in-page save is an unconditional upsert. If another device writes in
  that gap, its change is overwritten without a banner. Narrow — it needs the tab backgrounded
  mid-edit *and* a second device writing in the same window — but real. Closing it properly needs
  a device id or a last-writer column rather than timestamp guessing; see the reverted attempt
  above for why the obvious fix does not work.
- **iOS Safari private browsing**: localStorage is restricted in private mode. The autosave queue may not survive a page reload. Behavior is degraded but not silent — the save-failed banner will appear if Supabase is unreachable.
- **Session expiry mid-edit**: `onAuthStateChange` detects SIGNED_OUT and redirects to login. Any pending queue entries in localStorage are lost (they were written under the old user_id and won't drain on the next session). Accepted limitation; documented.
- **No admin panel**: operator creates accounts manually in Supabase dashboard. Fine for ≤100 users.
- **Snapshots feature (Reports tab)**: the existing JSON snapshot/comparison tool is already user-scoped via RLS. No visual screenshot/image capture feature — not needed.
