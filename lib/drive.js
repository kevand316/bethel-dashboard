// lib/drive.js
// Google Drive connection for the Intake tab.
//
// WHY THIS EXISTS AT ALL
// The intake form collects SSN, date of birth, Medi-Cal ID, mental-health
// diagnoses and criminal history. That is PHI plus identity-theft-grade PII.
// Supabase is on the free tier with no BAA, so none of it may ever be written
// there — not one field, not even a name. The dashboard keeps Supabase for
// logins and nothing else, and every client answer lives in the operator's own
// Google Drive. Same rule as the Solid Ground packet.
//
// Consequences of that rule, all deliberate:
//   - Each dashboard user connects their OWN Google account. Their intakes go
//     to their Drive; nobody else's, and never ours.
//   - The dashboard cannot show a list of clients unless Drive is reachable,
//     because the list only exists in Drive.
//   - Signing out of Google means the intake tab has nowhere to save. It must
//     refuse to take input rather than collect answers it will drop.
//
// SCOPE: drive.file, and only drive.file. It grants access to files this app
// created and nothing else — we cannot see, list, or touch the rest of the
// user's Drive even by accident. It is also a non-sensitive scope, so the
// OAuth consent screen needs no Google verification review to go to production.
// Widening this scope would change both of those facts. Don't.
//
// Loaded after lib/auth.js. Exposes window.drive.

(function () {
  // Public OAuth client ID — safe to commit, same as the Supabase anon key.
  // A Web application client whose authorized JavaScript origins must list both
  // https://dashboard.bethelresidency.com and http://localhost:3000.
  // See INTAKE-SETUP.md for how to mint one.
  //
  // window.BETHEL_GOOGLE_CLIENT_ID wins when set, so a fork or a test run can
  // point at a different OAuth client without editing this file.
  const PLACEHOLDER_CLIENT_ID = "PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID";
  const GOOGLE_CLIENT_ID = window.BETHEL_GOOGLE_CLIENT_ID || PLACEHOLDER_CLIENT_ID;

  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const ROOT_FOLDER_NAME = "Bethel Intake Forms";
  const FOLDER_MIME = "application/vnd.google-apps.folder";

  // Treat a token as spent slightly before Google does. A token that expires
  // mid-flight surfaces as a 401 on a save, which is the one moment we least
  // want to be guessing.
  const EXPIRY_SKEW_MS = 5 * 60 * 1000;

  // ── state ──────────────────────────────────────────────────────────────────
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let account = null; // { email } of the connected Google account
  let rootFolderId = null;
  let storageKey = null; // per-dashboard-user, so two logins on one machine
  // never inherit each other's connection hint
  let needsReconnectCb = null;

  // Tests swap this out to run the whole tab without a Google account.
  // Production path is plain fetch.
  let transport = (url, opts) => fetch(url, opts);

  // ── connection hint ────────────────────────────────────────────────────────
  // We cannot persist an access token — the browser token flow issues no refresh
  // token, by design. What we persist is only the fact that this dashboard user
  // has granted consent before, plus which Google account they used. That lets
  // us ask Google for a fresh token silently on page load instead of making them
  // click Connect every hour. It is the operator's own email, never client data.
  function readHint() {
    if (!storageKey) return null;
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch {
      return null;
    }
  }

  function writeHint(value) {
    if (!storageKey) return;
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch {
      // Private browsing with storage disabled. The tab still works for this
      // session; the user just re-clicks Connect next time.
    }
  }

  // ── Google Identity Services ───────────────────────────────────────────────
  // The GSI script is loaded async in the page head, so it may not be ready when
  // a user clicks Connect on a cold, slow load.
  function waitForGis(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function poll() {
        if (window.google?.accounts?.oauth2) return resolve();
        if (Date.now() - started > timeoutMs) {
          return reject(
            err("gis_unavailable", "Could not reach Google. Check your connection and try again.")
          );
        }
        setTimeout(poll, 100);
      })();
    });
  }

  function err(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  async function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    await waitForGis();
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: () => {}, // replaced per request below
    });
    return tokenClient;
  }

  // Asks Google for an access token.
  //   interactive: true  → shows the account chooser / consent screen
  //   interactive: false → silent; succeeds only if the user still has a live
  //                        Google session and has already consented
  function requestToken(interactive) {
    return new Promise(async (resolve, reject) => {
      let client;
      try {
        client = await ensureTokenClient();
      } catch (e) {
        return reject(e);
      }

      client.callback = (resp) => {
        if (resp.error) {
          return reject(err(resp.error, resp.error_description || "Google declined the request."));
        }
        accessToken = resp.access_token;
        // expires_in is seconds; treat a missing value as the documented hour.
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        resolve(accessToken);
      };
      client.error_callback = (e) => {
        // Popup blocked, or the user closed it. Not an app failure — say so plainly.
        reject(err(e?.type || "popup_failed", "Google sign-in was closed before it finished."));
      };

      try {
        client.requestAccessToken({ prompt: interactive ? "consent" : "" });
      } catch (e) {
        reject(err("request_failed", e?.message || "Could not start Google sign-in."));
      }
    });
  }

  function tokenIsFresh() {
    return !!accessToken && Date.now() < tokenExpiresAt - EXPIRY_SKEW_MS;
  }

  // Every Drive call goes through here. If the token has aged out we try once,
  // silently, to get another. If that fails the caller gets a needs_reconnect
  // error — which the Intake tab turns into a Reconnect button while HOLDING
  // whatever the operator was typing. Work in progress is never dropped on the
  // floor because a token expired.
  async function freshToken() {
    if (tokenIsFresh()) return accessToken;
    try {
      return await requestToken(false);
    } catch {
      accessToken = null;
      tokenExpiresAt = 0;
      if (needsReconnectCb) needsReconnectCb();
      throw err("needs_reconnect", "Google Drive needs to be reconnected.");
    }
  }

  // ── Drive REST ─────────────────────────────────────────────────────────────
  async function api(path, { method = "GET", query, body, contentType, base } = {}) {
    const token = await freshToken();
    const root = base || "https://www.googleapis.com/drive/v3";
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const headers = { Authorization: "Bearer " + token };
    if (contentType) headers["Content-Type"] = contentType;

    const res = await transport(root + path + qs, { method, headers, body });

    if (res.status === 401 || res.status === 403) {
      // The token was revoked, or consent was withdrawn from the Google account
      // page. Same handling as expiry: stop, ask for reconnect, hold the work.
      accessToken = null;
      tokenExpiresAt = 0;
      if (needsReconnectCb) needsReconnectCb();
      throw err("needs_reconnect", "Google Drive access was revoked. Reconnect to keep saving.");
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.error?.message || "";
      } catch {
        // Drive occasionally returns a bare HTML error page; body is unusable.
      }
      throw err("drive_error", detail || `Google Drive returned ${res.status}.`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // Drive query strings are single-quoted, so an apostrophe in a name would end
  // the literal early and produce a malformed query. O'Brien is a real surname.
  const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  // ── connection ─────────────────────────────────────────────────────────────
  function isConfigured() {
    return !!GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== PLACEHOLDER_CLIENT_ID;
  }

  async function whoami() {
    // about.get is available under drive.file and tells us which account the
    // token belongs to — no extra email/profile scope needed for a display name.
    const about = await api("/about", { query: { fields: "user(emailAddress,displayName)" } });
    return {
      email: about?.user?.emailAddress || "",
      name: about?.user?.displayName || "",
    };
  }

  // Finds the app's folder or makes it. Under drive.file the list only ever sees
  // folders this app created, so there is no risk of adopting some unrelated
  // folder of the user's that happens to share the name.
  async function ensureRootFolder() {
    if (rootFolderId) return rootFolderId;

    const found = await api("/files", {
      query: {
        q: `name='${q(ROOT_FOLDER_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
        fields: "files(id,name)",
        pageSize: "1",
      },
    });

    if (found?.files?.length) {
      rootFolderId = found.files[0].id;
      return rootFolderId;
    }

    const created = await api("/files", {
      method: "POST",
      contentType: "application/json",
      query: { fields: "id" },
      body: JSON.stringify({ name: ROOT_FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    rootFolderId = created.id;
    return rootFolderId;
  }

  // Interactive connect — only ever called from a real click, because browsers
  // block the popup otherwise.
  async function connect() {
    if (!isConfigured()) {
      throw err(
        "not_configured",
        "Google Drive is not set up for this dashboard yet. See INTAKE-SETUP.md."
      );
    }
    await requestToken(true);
    account = await whoami();
    await ensureRootFolder();
    writeHint({ email: account.email, name: account.name });
    return account;
  }

  // Silent reconnect on page load. Returns the account on success, null if the
  // user has to click Connect again. Never throws — a failed silent attempt is
  // an ordinary outcome, not an error worth interrupting the page for.
  async function resume() {
    if (!isConfigured()) return null;
    const hint = readHint();
    if (!hint) return null;
    try {
      await requestToken(false);
      account = await whoami();
      await ensureRootFolder();
      writeHint({ email: account.email, name: account.name });
      return account;
    } catch {
      // Consent still on file, but no live Google session right now. Show the
      // remembered email next to a Reconnect button rather than a bare Connect —
      // the user knows which account they used.
      account = null;
      return null;
    }
  }

  function disconnect() {
    // Revoke so the grant does not linger on the Google account after the user
    // has told us to forget it.
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      try {
        window.google.accounts.oauth2.revoke(accessToken, () => {});
      } catch {
        // Revocation is best-effort; local state is cleared either way.
      }
    }
    accessToken = null;
    tokenExpiresAt = 0;
    account = null;
    rootFolderId = null;
    writeHint(null);
  }

  // ── intake files ───────────────────────────────────────────────────────────
  // One JSON file per intake, all in the app folder. The Drive file name carries
  // the client name and intake date so the folder is readable in Drive itself,
  // not just through this dashboard — if the operator ever stops using the tool,
  // their records are still theirs and still legible.
  function fileNameFor(record) {
    const last = (record?.lastName || "").trim();
    const first = (record?.firstName || "").trim();
    const who = [last, first].filter(Boolean).join(", ") || "Unnamed intake";
    const when = (record?.intakeDate || "").trim();
    return `${who}${when ? " — " + when : ""}.json`;
  }

  async function listIntakes() {
    const folder = await ensureRootFolder();
    const out = [];
    let pageToken;
    // Paginate properly. An operator with 200 clients would otherwise silently
    // see only the first page and believe the rest were gone.
    do {
      const query = {
        q: `'${q(folder)}' in parents and trashed=false and mimeType='application/json'`,
        fields: "nextPageToken, files(id,name,modifiedTime,appProperties)",
        orderBy: "modifiedTime desc",
        pageSize: "100",
      };
      if (pageToken) query.pageToken = pageToken;
      const page = await api("/files", { query });
      out.push(...(page?.files || []));
      pageToken = page?.nextPageToken;
    } while (pageToken);

    return out.map((f) => ({
      fileId: f.id,
      fileName: f.name,
      modifiedTime: f.modifiedTime,
      clientName: f.appProperties?.clientName || f.name.replace(/\.json$/, ""),
      status: f.appProperties?.status || "",
    }));
  }

  // The version is our conflict token. It is ALWAYS read from files.get and
  // never from an upload response — an earlier version of this pattern in the
  // Solid Ground packet trusted the number the upload handed back, which does
  // not agree with what files.get reports, so every save after the first was
  // rejected as somebody else's edit. One endpoint, one source of truth.
  async function readVersion(fileId) {
    const meta = await api("/files/" + fileId, { query: { fields: "version" } });
    return meta?.version || null;
  }

  // Metadata Drive is allowed to see for listing purposes. Deliberately just the
  // name and the placement decision — enough to render a useful list without
  // duplicating the medical or criminal answers into file metadata.
  function appPropsFor(record) {
    const name = [record?.firstName, record?.lastName].filter(Boolean).join(" ").trim();
    return {
      clientName: name || "Unnamed intake",
      status: record?.placementDecision || "",
      intakeDate: record?.intakeDate || "",
    };
  }

  async function createIntake(record) {
    const folder = await ensureRootFolder();
    const created = await api("/files", {
      method: "POST",
      contentType: "application/json",
      query: { fields: "id" },
      body: JSON.stringify({
        name: fileNameFor(record),
        parents: [folder],
        mimeType: "application/json",
        appProperties: appPropsFor(record),
      }),
    });
    const fileId = created.id;
    await writeContent(fileId, record);
    return { fileId, version: await readVersion(fileId) };
  }

  async function writeContent(fileId, record) {
    await api("/files/" + fileId, {
      method: "PATCH",
      base: "https://www.googleapis.com/upload/drive/v3",
      query: { uploadType: "media" },
      contentType: "application/json",
      body: JSON.stringify(record, null, 2),
    });
  }

  async function readIntake(fileId) {
    const record = await api("/files/" + fileId, { query: { alt: "media" } });
    return { record, version: await readVersion(fileId) };
  }

  // Saves content, then metadata, then returns the new version.
  // expectedVersion is what the caller last saw. If Drive disagrees, someone
  // else — another tab, another device — has written since, and we refuse
  // rather than overwrite their work. Pass null to save unconditionally.
  async function saveIntake(fileId, record, expectedVersion) {
    if (expectedVersion != null) {
      const current = await readVersion(fileId);
      if (current != null && String(current) !== String(expectedVersion)) {
        throw err("conflict", "This intake was changed somewhere else.");
      }
    }

    await writeContent(fileId, record);

    // Keep the Drive file name and metadata in step with the name fields, so the
    // folder stays readable as the operator fills the form in.
    await api("/files/" + fileId, {
      method: "PATCH",
      contentType: "application/json",
      query: { fields: "id" },
      body: JSON.stringify({
        name: fileNameFor(record),
        appProperties: appPropsFor(record),
      }),
    });

    return { version: await readVersion(fileId) };
  }

  async function trashIntake(fileId) {
    // Trash, never delete. An operator who removes the wrong client can get it
    // back out of their own Drive trash for 30 days; a hard delete is gone.
    await api("/files/" + fileId, {
      method: "PATCH",
      contentType: "application/json",
      query: { fields: "id" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  // ── public surface ─────────────────────────────────────────────────────────
  window.drive = {
    // Scope the connection hint to the dashboard user, so two accounts sharing a
    // laptop never pick up each other's Google connection.
    init(userId) {
      storageKey = "bethel.drive." + userId;
      const hint = readHint();
      return hint ? { remembered: hint } : { remembered: null };
    },
    isConfigured,
    isConnected: () => !!account && tokenIsFresh(),
    getAccount: () => account,
    getRemembered: () => readHint(),
    onNeedsReconnect(cb) {
      needsReconnectCb = cb;
    },
    connect,
    resume,
    disconnect,
    listIntakes,
    createIntake,
    readIntake,
    saveIntake,
    trashIntake,
    readVersion,
    fileNameFor,

    // Test seam: lets the Playwright suite drive the whole Intake tab against a
    // fake Drive, so the tests need no Google account and write nothing real.
    _setTransport(fn) {
      transport = fn;
    },
    _setAuthForTest(tok, expiresInMs, acct) {
      accessToken = tok;
      tokenExpiresAt = Date.now() + expiresInMs;
      account = acct;
    },
  };
})();
