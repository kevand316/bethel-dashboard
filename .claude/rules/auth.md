---
paths:
  - login.html
  - lib/auth.js
  - lib/supabase.js
  - migrations/*.sql
  - tests/auth.spec.js
  - tests/isolation.spec.js
---

# Auth and data isolation rules

These rules apply to anything touching authentication, session management, RLS policies, or user-scoped data access. Read them every time you edit one of the files listed above.

## Hard rules

- **Every Supabase query must filter by the authenticated user.** Even though RLS enforces this at the database level, client code must construct queries with the user filter explicitly. RLS is the safety net, not the strategy. A query that "works" because RLS silently drops rows is a bug — it means the code's intent doesn't match the data model.

- **Never expose `auth.users` directly.** If user-facing UI needs a user's name or display info, store it in a `profiles` table that joins to `auth.users` via `id`. Apply RLS to `profiles` so users can read only their own row (or a public subset, never email or auth metadata).

- **The Supabase JS client is the only path to the database.** No raw `fetch()` calls to the REST API. The client handles session refresh and attaches the auth JWT to every request automatically. Bypassing it is how RLS gets bypassed accidentally.

- **Sessions persist in the SDK's default storage. Do not roll your own.** The Supabase JS SDK persists sessions in localStorage under its own keys. Do not store auth tokens, JWTs, or user IDs in custom localStorage keys. Read identity exclusively via `supabase.auth.getUser()` or `getSession()`.

- **Auth gate runs on every protected page.** `index.html` and any future protected page must, at the very top of its initialization, call `supabase.auth.getSession()` and redirect to `login.html` if there's no session. No flash of unauthenticated content.

- **Forgot-password flow must use Supabase's built-in `resetPasswordForEmail`.** Do not invent a custom token system. Configure the redirect URL in Supabase's auth settings to point at a `/reset-password.html` page on the production domain.

- **Email verification stays off** unless the operator explicitly enables it later. Document this in the migration that disables it so the trade-off is recorded.

## Required tests when modifying these files

If you touch any file in this scope, the following Playwright tests must exist and pass before declaring the change done:

1. **Two-user isolation test** (`tests/isolation.spec.js`): logs in as user A, writes data, logs out, logs in as user B in a fresh browser context, verifies user B sees no trace of user A's data — not in the dashboard view, not by guessing IDs in URLs, not in the screenshots tab, not in any API response.

2. **Unauthenticated access test** (`tests/auth.spec.js`): hits `index.html` directly without a session, verifies redirect to `login.html` happens before any data fetch fires (check the network tab in the test).

3. **Session-expired test**: with an expired or tampered JWT, verifies the user is redirected and the page does not render with stale data.

4. **Password reset round-trip**: requesting a reset for a real test account produces an email (use Supabase's local SMTP capture or a Mailtrap-style sink in tests), the link works, the password change persists.

These tests are blocking. If they fail, the change is not done.

## Migration discipline

- Migrations are append-only. Once a numbered SQL file has been applied to production, never edit it. Write a new one.
- Every migration that adds a table must include the RLS enable + policies in the same file. A table without RLS is a leak waiting to happen.
- Migrations that backfill `user_id` for existing rows (i.e., the cutover migration that takes the operator's existing data and assigns it to their auth user) must be idempotent — runnable twice with no harm.

## Things that look fine but aren't

- "Just for testing" disabling RLS — no. Use a service-role client in a server-side test fixture if you need to seed data. Never disable RLS in development if production has it on.
- Using the anon key from a server context — no. The anon key is for browsers. Server-side code (if any is ever added) uses the service-role key from a secret env var, never committed.
- Storing the user's ID in a global JS variable for "convenience" — no. Read it from the session every time. Sessions can refresh; user IDs cannot change but the source of truth is the session.
