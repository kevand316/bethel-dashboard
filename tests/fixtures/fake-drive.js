// tests/fixtures/fake-drive.js
//
// An in-browser stand-in for Google Drive and Google Identity Services, injected
// with page.addInitScript before any app code runs.
//
// Deliberately built with NO test hooks in production code: it replaces
// window.fetch and window.google, both of which lib/drive.js already goes
// through. That means these tests exercise the real request-building, real token
// handling and real error paths in lib/drive.js — only the far end is fake.
//
// It also means the suite needs no Google account and writes nothing to anyone's
// real Drive, which matters more than usual here: every record this code path
// touches in production is client PHI.

// Returns a function suitable for page.addInitScript.
function installFakeDrive() {
  // ── auth ─────────────────────────────────────────────────────────────────
  window.BETHEL_GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";

  const auth = (window.__auth = {
    grantSilently: false, // no prior consent: the first silent attempt must fail
    expiresIn: 3600,
    interactiveFails: null, // set to an error string to simulate a closed popup
    email: "operator@example.org",
    revokedCount: 0,
  });

  window.google = {
    accounts: {
      oauth2: {
        initTokenClient() {
          const client = {
            callback: () => {},
            error_callback: null,
            requestAccessToken(opts) {
              const interactive = opts && opts.prompt === "consent";
              setTimeout(() => {
                if (interactive && auth.interactiveFails) {
                  return client.callback({ error: auth.interactiveFails });
                }
                if (!interactive && !auth.grantSilently) {
                  return client.callback({ error: "interaction_required" });
                }
                // Consenting once means later silent requests succeed, exactly
                // like a real Google session.
                if (interactive) auth.grantSilently = true;
                client.callback({
                  access_token: "fake-token-" + Math.random().toString(36).slice(2),
                  expires_in: auth.expiresIn,
                });
              }, 0);
            },
          };
          return client;
        },
        revoke(_token, done) {
          auth.revokedCount++;
          if (done) done();
        },
      },
    },
  };

  // ── the fake Drive ───────────────────────────────────────────────────────
  const store = (window.__drive = {
    files: new Map(),
    nextId: 1,
    // Test controls
    failNext: null, // { status } applied to the next request
    delayMs: 0, // slows every request, for racing the UI
    unauthorized: false, // every request 401s, as Google does once a grant is
    // revoked or a token dies — the realistic way to test
    // expiry, since the live token lives in a closure the
    // test cannot reach into
    requests: [], // every request, for asserting what was actually sent
    // Lets a test simulate another device writing the file.
    bumpVersion(id) {
      const f = store.files.get(id);
      if (f) f.version = String(Number(f.version) + 1);
    },
    contentOf(id) {
      const f = store.files.get(id);
      return f ? JSON.parse(f.content || "null") : null;
    },
    named(name) {
      return [...store.files.values()].find((f) => f.name === name);
    },
    intakeFiles() {
      return [...store.files.values()].filter(
        (f) => f.mimeType === "application/json" && !f.trashed
      );
    },
  });

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // Pulls values out of the Drive query language we actually use. Not a general
  // parser — just enough for the two shapes lib/drive.js builds.
  function matchQuery(q, file) {
    if (!q) return true;
    if (/trashed=false/.test(q) && file.trashed) return false;

    const name = q.match(/name='((?:[^'\\]|\\.)*)'/);
    if (name && file.name !== name[1].replace(/\\(.)/g, "$1")) return false;

    const mime = q.match(/mimeType='([^']*)'/);
    if (mime && file.mimeType !== mime[1]) return false;

    const parent = q.match(/'([^']*)' in parents/);
    if (parent && !(file.parents || []).includes(parent[1])) return false;

    return true;
  }

  // Everything that is not Google goes to the real network. Supabase auth runs
  // over fetch too, and swallowing it here would break sign-in for every test.
  const realFetch = window.fetch.bind(window);

  window.fetch = async function (url, opts = {}) {
    const u = String(url);
    if (!u.includes("googleapis.com")) return realFetch(url, opts);

    store.requests.push({ url: u, method: opts.method || "GET", body: opts.body });

    if (store.delayMs) await new Promise((r) => setTimeout(r, store.delayMs));

    if (store.unauthorized) {
      return json({ error: { message: "Invalid Credentials" } }, 401);
    }

    if (store.failNext) {
      const { status } = store.failNext;
      store.failNext = null;
      return json({ error: { message: "Simulated Drive failure" } }, status);
    }

    const parsed = new URL(u);
    const path = parsed.pathname;
    const qp = parsed.searchParams;
    const method = (opts.method || "GET").toUpperCase();

    // about.get — which account is this token for
    if (path.endsWith("/drive/v3/about")) {
      return json({ user: { emailAddress: auth.email, displayName: "Test Operator" } });
    }

    // Content upload
    const upload = path.match(/\/upload\/drive\/v3\/files\/(.+)$/);
    if (upload && method === "PATCH") {
      const file = store.files.get(upload[1]);
      if (!file) return json({ error: { message: "Not found" } }, 404);
      file.content = opts.body;
      file.version = String(Number(file.version) + 1);
      file.modifiedTime = new Date().toISOString();
      return json({ id: file.id });
    }

    // Collection
    if (path.endsWith("/drive/v3/files")) {
      if (method === "POST") {
        const meta = JSON.parse(opts.body || "{}");
        const id = "file-" + store.nextId++;
        store.files.set(id, {
          id,
          name: meta.name || "",
          mimeType: meta.mimeType || "application/octet-stream",
          parents: meta.parents || [],
          appProperties: meta.appProperties || {},
          trashed: false,
          content: "",
          version: "1",
          modifiedTime: new Date().toISOString(),
        });
        return json({ id });
      }
      if (method === "GET") {
        const q = qp.get("q");
        const files = [...store.files.values()]
          .filter((f) => matchQuery(q, f))
          .map((f) => ({
            id: f.id,
            name: f.name,
            modifiedTime: f.modifiedTime,
            appProperties: f.appProperties,
          }));
        return json({ files });
      }
    }

    // Single file
    const single = path.match(/\/drive\/v3\/files\/(.+)$/);
    if (single) {
      const file = store.files.get(single[1]);
      if (!file) return json({ error: { message: "Not found" } }, 404);

      if (method === "GET") {
        if (qp.get("alt") === "media") {
          return new Response(file.content || "null", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return json({ id: file.id, name: file.name, version: file.version });
      }
      if (method === "PATCH") {
        const meta = JSON.parse(opts.body || "{}");
        if (meta.name !== undefined) file.name = meta.name;
        if (meta.appProperties !== undefined) file.appProperties = meta.appProperties;
        if (meta.trashed !== undefined) file.trashed = meta.trashed;
        // Real Drive bumps `version` on ANY server-side change, metadata
        // included. Modelling that faithfully is the point: lib/drive.js renames
        // the file after writing content, so if it read its new version before
        // that rename it would be one behind and reject its own next save as
        // somebody else's edit. That is the exact bug the Solid Ground packet
        // shipped, and test 9 only catches it if this bumps here too.
        file.version = String(Number(file.version) + 1);
        return json({ id: file.id });
      }
    }

    return json({ error: { message: "Unhandled: " + method + " " + path } }, 400);
  };
}

module.exports = { installFakeDrive };
