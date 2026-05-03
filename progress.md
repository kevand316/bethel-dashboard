# Bethel Dashboard — Build Progress

Last updated: 2026-05-03

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

**Operations tab**
- Startup Cost input in a "Property Setup" card above the expense form
- CoC Return KPI cell: shows `—` when startup cost is 0, `X.X%` (green/red) when set
- Subheadline shows `Startup: $X,XXX` at all times

---

## Tests passing

**17 passing, 1 skipped** (`npx playwright test`)

| File | Tests | Tags |
|------|-------|------|
| `tests/auth.spec.js` | invalid credentials error, logout + redirect, session persistence, corrupted token redirect | `@smoke` |
| `tests/autosave.spec.js` | happy path, network drop + recovery, reload-while-pending, quota stress (1000 pushes), pagehide flush | `@autosave` |
| `tests/isolation.spec.js` | unauth redirect, two-user data isolation, unauthenticated API returns 0 rows | `@isolation` |
| `tests/login-page.spec.js` | 375px no scroll, tap targets ≥44px, short-PW validation, mismatch validation, forgot-password view | `@smoke` |

Skipped: cross-device conflict detection (`tests/autosave.spec.js` — deferred, see below).

---

## Pre-launch tasks remaining

1. **Manual phone test** — one session as operator, one as fresh signup, on real iPhone and Android. Full flow end to end. Can't be automated. Required before course launch.

2. **Delete test accounts** — remove `playwright-a@bethel.test` and `playwright-b@bethel.test` from Supabase Auth → Users immediately before announcing to course members.

3. **Cross-device conflict detection** — the skipped `@autosave` test. Required before telling users the dashboard supports multi-device editing. Planned as migration 002.

4. **Separate test Supabase project** — currently test accounts live in the production project. Low urgency but clean this up before user count grows.

See `plans/multi-user-migration.md` for the full checklist.

---

## Known limitations / future work

- **No conflict detection yet**: editing the same home on two devices simultaneously silently last-write-wins. No warning is shown. Deferred to migration 002.
- **Test accounts in production**: `playwright-a` and `playwright-b` exist in the same Supabase project as real users. They use `.test` domain emails and RLS keeps them isolated, but they should be deleted before launch.
- **iOS Safari private browsing**: localStorage is restricted in private mode. The autosave queue may not survive a page reload. Behavior is degraded but not silent — the save-failed banner will appear if Supabase is unreachable.
- **Session expiry mid-edit**: `onAuthStateChange` detects SIGNED_OUT and redirects to login. Any pending queue entries in localStorage are lost (they were written under the old user_id and won't drain on the next session). Accepted limitation; documented.
- **No admin panel**: operator creates accounts manually in Supabase dashboard. Fine for ≤100 users.
- **Snapshots feature (Reports tab)**: the existing JSON snapshot/comparison tool is already user-scoped via RLS. No visual screenshot/image capture feature — not needed.
