# Intake Tab — one-time setup

The Intake tab saves client intake forms into **each user's own Google Drive**.
Nothing a client tells you is ever stored on the dashboard or in Supabase.

That design needs one thing that cannot live in the code: a **Google OAuth client
ID**, which is what lets a user click "Connect Google Drive" and grant this
dashboard permission to create files in their Drive.

Until that ID is filled in, the Intake tab shows "Google Drive is not set up yet"
and the form stays locked. Everything else in the dashboard works normally.

---

## Part 1 — Create the Google OAuth client (about 10 minutes, done once)

You need a Google account. Use the Bethel Google Workspace account if you have
one, since this project will belong to whoever owns it long-term.

### 1. Make a Google Cloud project

1. Go to <https://console.cloud.google.com/>
2. Top bar → project dropdown → **New Project**
3. Name it `bethel-dashboard` → **Create**
4. Make sure the new project is selected in the top bar before continuing

### 2. Turn on the Drive API

1. Left menu → **APIs & Services** → **Library**
2. Search for **Google Drive API** → click it → **Enable**

### 3. Configure the consent screen

1. **APIs & Services** → **OAuth consent screen**
2. User type: **External** → **Create**
   - "External" only means "not restricted to one Workspace domain". It is what
     lets other operators sign in with their own Google accounts.
3. Fill in:
   - App name: `Bethel Residency Dashboard`
   - User support email: your email
   - Developer contact email: your email
4. **Save and Continue**
5. **Scopes** page → **Add or Remove Scopes** → filter for `drive.file` and tick:

   ```
   https://www.googleapis.com/auth/drive.file
   ```

   Add **only** this one. See "Why only drive.file" below.

6. **Save and Continue** through the remaining pages → **Back to Dashboard**
7. On the OAuth consent screen page, click **Publish App** → confirm.

   While the app is in "Testing" it is capped at 100 users and every one has to
   be added by hand. Publishing removes that cap. Because `drive.file` is a
   non-sensitive scope, publishing does **not** put you through Google's
   verification review.

### 4. Create the client ID

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Name: `Bethel Dashboard Web`
4. Under **Authorized JavaScript origins**, click _Add URI_ for each of these —
   exactly as written, no trailing slash:

   ```
   https://dashboard.bethelresidency.com
   http://localhost:3000
   ```

   The localhost entry is what lets the tests and local development work. Drop it
   later if you would rather it not be there.

5. Leave **Authorized redirect URIs** empty. This dashboard uses the browser token
   flow, which does not redirect.
6. **Create**, then copy the **Client ID**. It looks like:

   ```
   1234567890-abcdefghijklmnop.apps.googleusercontent.com
   ```

---

## Part 2 — Put the client ID in the dashboard

Open `lib/drive.js` and set `CONFIGURED_CLIENT_ID` near the top:

```js
const CONFIGURED_CLIENT_ID = "1234567890-abcdefghijklmnop.apps.googleusercontent.com";
```

**Leave `PLACEHOLDER_CLIENT_ID` exactly as it is.** It is the "not set up yet"
sentinel: `isConfigured()` decides whether the Intake tab works by checking the
live ID against it. Putting a real value there would make that check compare the
ID to itself, and the tab would report itself unconfigured forever.

Commit and push. GitHub Pages will redeploy in a minute or two.

**This ID is safe to commit.** It is public by design, the same as the Supabase
anon key already in `lib/supabase.js`. It identifies the app; it grants nothing
on its own. There is no client _secret_ anywhere in this setup, which is why the
whole thing can run on a static site with no server.

---

## Part 3 — Check it works

1. Open the dashboard, sign in, go to **Intake**.
2. You should see "Connect Google Drive to start taking intakes".
3. Click **Connect Google Drive**. Google asks which account, then asks to let
   the app "see, edit, create and delete only the specific Google Drive files you
   use with this app". Approve it.
4. You land on the intake list. Click **+ New Intake** and type a name.
5. Watch the indicator go `SAVING...` then `SAVED TO DRIVE ✓`.
6. Open Google Drive in another tab. There is now a folder called
   **Bethel Intake Forms** with a file named after the client.

If you see an "unverified app" warning during step 3, the app was not published
in Part 1 step 3.7. Go back and publish it.

---

## How this works, and why

### Why only `drive.file`

`drive.file` grants access to files **this app created** and nothing else. Even
with a valid token, the dashboard cannot list, read or touch anything else in
anyone's Drive — not their tax returns, not their photos. That is a real
technical boundary, not a promise.

It also happens to be classed by Google as a _non-sensitive_ scope, which is why
publishing the app needs no verification review. A broader scope like
`drive.readonly` would need review, would take weeks, and would hand the app
access it has no business having. Do not widen the scope.

### Where client data actually lives

| Thing                                     | Where it lives                  | Why                                                |
| ----------------------------------------- | ------------------------------- | -------------------------------------------------- |
| Logins, passwords                         | Supabase                        | No client data, so no BAA needed                   |
| Dashboard numbers (beds, rents, expenses) | Supabase                        | Business data, not client data                     |
| **Every intake answer**                   | **The operator's Google Drive** | SSN, DOB, Medi-Cal ID, diagnoses, criminal history |

The intake form collects protected health information. The dashboard's Supabase
project is on the free tier with no Business Associate Agreement, so none of it
may be stored there — not a diagnosis, not a name, not the fact that a named
person applied. Google Workspace can be covered by Google's free HIPAA BAA, which
is what makes Drive an appropriate home for it.

This is the same reasoning as the Solid Ground packet, and the constraint drives
several visible behaviours:

- **The form will not open until Drive is connected.** There is nowhere else for
  the answers to go, so there must be nothing to type into.
- **There is no local draft.** Parking a half-typed SSN in the browser's storage
  would quietly recreate the problem. If a save cannot complete, the work is held
  in the open form and the operator is told — it is never written elsewhere.
- **Each user connects their own account.** Their clients' records go to their
  Drive. You never see them and neither does the dashboard.

### The Workspace vs personal Gmail question

The connect screen says a Google Workspace account is best, and it means it.
Google's HIPAA BAA is only available on Workspace. A personal `@gmail.com`
account is not covered by it. Any operator is free to connect a personal Gmail —
the tool allows it — but that is their decision to make knowingly, which is why
it is stated plainly on screen rather than buried here.

### Tokens expire after about an hour

Google's browser token flow issues no refresh token, by design. When a token
expires the dashboard asks Google for a new one silently, which works as long as
the user still has a live Google session. If it does not, the Intake tab shows
**"GOOGLE DRIVE DISCONNECTED — your typing is held, nothing is lost"** with a
Reconnect button. The form stays on screen with everything in it, and the pending
save completes once they reconnect.

---

## Running the tests

```bash
npm test                         # everything
npx playwright test tests/intake.spec.js
```

The intake tests need **no Google account** and touch **no real Drive**. They
replace `window.fetch` and `window.google` in the browser
(`tests/fixtures/fake-drive.js`), so all of `lib/drive.js` runs for real against
a fake far end, and the real Google script is blocked at the network layer.

They still need `.env.test` for Supabase sign-in, same as the rest of the suite.
