// lib/autosave.js
// Autosave queue with retry, offline detection, flush-on-pagehide, and
// cross-device conflict detection (migration 002: updated_at column).
//
// Save state contract (autosave.md):
//   1. "saving..."             — immediately on push(); Supabase not yet confirmed.
//   2. "saved ✓"              — only after Supabase responds with success.
//   3. "offline — will retry"  — after first failure; retry timer running.
//   4. "save failed — reload"  — after MAX_ATTEMPTS exhausted.
//
// Conflict state (migration 002):
//   When a conditional UPDATE returns 0 rows (another device wrote since our load),
//   a non-blocking amber banner appears: "Changed elsewhere — Reload or Override".
//   Retries are suspended until the user acts.
//
// localStorage key "bethel_autosave_queue" holds pending entries.
// De-duplication: upsertEntry() replaces any existing entry for the same row_id.
//
// Must be loaded AFTER lib/supabase.js.

(function () {
  const QUEUE_KEY = "bethel_autosave_queue";
  const DEBOUNCE_MS = 800;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS = [5000, 15000]; // ms after attempt 1, attempt 2
  const SB_URL = "https://yqgccykbdihsjqlapghr.supabase.co";
  const SB_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlxZ2NjeWtiZGloc2pxbGFwZ2hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzNDAyMTksImV4cCI6MjA4NzkxNjIxOX0." +
    "XHgok8xbYDKekprYI2htAZL622P7YcycTsQ5HuP-VUs";
  // localStorage key where the Supabase JS SDK stores the session.
  const SB_SESSION_KEY = "sb-yqgccykbdihsjqlapghr-auth-token";

  let _userId = null;
  let _loadedAt = null; // updated_at from the last confirmed load or save (migration 002)
  let _debounceTimers = {}; // { [rowId]: timerId }
  let _retryTimers = {}; // { [rowId]: timerId }
  let _draining = false;
  let _conflictPending = false; // true while user hasn't resolved a conflict
  // Every updated_at value THIS session has written. A conditional UPDATE that
  // matches 0 rows means the server's timestamp isn't the one we last saw — but
  // that happens both when another device wrote and when we advanced it
  // ourselves (concurrent in-page write, or a keepalive whose response we never
  // read). Keeping our own timestamps lets us tell those two apart instead of
  // guessing. Bounded so a long session can't grow it without limit.
  let _ourTimestamps = [];
  const OUR_TS_LIMIT = 50;

  // Which tab wrote last (migration 009: bethel_data.writer). The trigger rewrites
  // updated_at on every UPDATE, so a fire-and-forget keepalive's timestamp can never
  // be known; its writer can. Kept in sessionStorage so it survives a reload of the
  // same tab, which is exactly when a page-hide keepalive needs to be recognised.
  const DEVICE_ID = (() => {
    try {
      let id = sessionStorage.getItem("houseboss_device_id");
      if (!id) {
        id = "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem("houseboss_device_id", id);
      }
      return id;
    } catch (e) {
      return "tab-" + Math.random().toString(36).slice(2, 10);
    }
  })();

  // ── Queue helpers ──────────────────────────────────────────────────────────

  function readQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeQueue(queue) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {
      console.warn("[autosave] localStorage write failed:", e);
    }
  }

  function upsertEntry(userId, rowId, data) {
    const queue = readQueue();
    const idx = queue.findIndex((e) => e.user_id === userId && e.row_id === rowId);
    const entry = {
      qid: idx >= 0 ? queue[idx].qid : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      user_id: userId,
      row_id: rowId,
      data: data,
      timestamp: Date.now(),
      attempts: 0,
      // The server version this edit was made on top of. Lets a write made after a
      // reload (drain) stay conditional instead of blindly overwriting.
      base: _loadedAt,
      conflicted: false,
    };
    if (idx >= 0) {
      queue[idx] = entry;
    } else {
      queue.push(entry);
    }
    writeQueue(queue);
    return entry;
  }

  function removeEntry(qid) {
    writeQueue(readQueue().filter((e) => e.qid !== qid));
  }

  function patchEntry(qid, fields) {
    writeQueue(readQueue().map((e) => (e.qid === qid ? { ...e, ...fields } : e)));
  }

  function incrementAttempts(qid) {
    const queue = readQueue();
    const entry = queue.find((e) => e.qid === qid);
    if (entry) {
      entry.attempts += 1;
      writeQueue(queue);
      return entry.attempts;
    }
    return 0;
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function setStatus(cls, text) {
    const el = document.getElementById("save-status");
    if (!el) return;
    el.className = cls;
    el.textContent = text;
  }

  function showFailBanner() {
    const banner = document.getElementById("save-fail-banner");
    if (banner) banner.style.display = "block";
  }

  function showConflictBanner() {
    const banner = document.getElementById("conflict-banner");
    if (banner) banner.style.display = "flex";
  }

  function hideConflictBanner() {
    const banner = document.getElementById("conflict-banner");
    if (banner) banner.style.display = "none";
  }

  // ── Conflict attribution ───────────────────────────────────────────────────

  function rememberOurTimestamp(ts) {
    if (!ts) return;
    _ourTimestamps.push(ts);
    if (_ourTimestamps.length > OUR_TS_LIMIT) {
      _ourTimestamps = _ourTimestamps.slice(-OUR_TS_LIMIT);
    }
  }

  function wroteItOurselves(ts) {
    return ts != null && _ourTimestamps.indexOf(ts) !== -1;
  }

  // Read the row's current updated_at straight from the server.
  // Returns { ok: true, ts } — ts may be null when the row no longer exists.
  // Returns { ok: false } when the read itself failed; the caller must treat
  // "we could not find out" as a conflict, never as permission to overwrite.
  async function fetchServerTimestamp(entry) {
    try {
      const client = window._supabase;
      if (!client) return { ok: false };
      const { data, error } = await client
        .from("bethel_data")
        .select("updated_at, writer")
        .eq("id", entry.row_id)
        .eq("user_id", entry.user_id)
        .maybeSingle();
      if (error) {
        console.warn("[autosave] conflict check read failed:", error.message);
        return { ok: false };
      }
      return { ok: true, ts: data ? data.updated_at : null, writer: data ? data.writer : null };
    } catch (e) {
      console.warn("[autosave] conflict check threw:", e);
      return { ok: false };
    }
  }

  // ── Network write ──────────────────────────────────────────────────────────

  // Attempt a single Supabase write for the given entry.
  // Returns: 'ok' | 'conflict' | 'fail'
  //
  // When _loadedAt is set (migration 002 applied): uses a conditional UPDATE
  // filtered on updated_at. Zero-rows-affected → 'conflict'.
  // When _loadedAt is null (pre-migration or override path): unconditional upsert.
  async function tryWrite(entry) {
    try {
      const client = window._supabase;
      if (!client) return "fail";

      const {
        data: { user },
      } = await client.auth.getUser();
      if (!user || user.id !== entry.user_id) return "fail";

      if (_loadedAt) {
        // Conditional UPDATE: only succeeds if updated_at still matches what we loaded.
        // We explicitly set updated_at to a fresh client timestamp so the value is
        // guaranteed to change on every write — the server-side trigger may or may not
        // override it with now(), but either way _loadedAt will advance after a successful
        // save and a stale second writer will see 0 rows → conflict.
        const newTs = new Date().toISOString();
        rememberOurTimestamp(newTs);
        const { data: rows, error } = await client
          .from("bethel_data")
          .update({ data: entry.data, updated_at: newTs, writer: DEVICE_ID })
          .eq("id", entry.row_id)
          .eq("user_id", entry.user_id)
          .eq("updated_at", _loadedAt)
          .select("updated_at");

        if (error) {
          console.warn("[autosave] update error:", error.message);
          return "fail";
        }

        if (!rows || rows.length === 0) {
          // Server timestamp changed — another device wrote since our load.
          return "conflict";
        }

        // Update our reference timestamp so the next write is also conditional.
        _loadedAt = rows[0].updated_at;
        rememberOurTimestamp(_loadedAt);
        return "ok";
      }

      // Unconditional upsert (pre-migration _loadedAt is null, or override path).
      // Explicit updated_at ensures the timestamp advances even if the trigger is absent.
      const newTs = new Date().toISOString();
      rememberOurTimestamp(newTs);
      const { data: rows, error } = await client
        .from("bethel_data")
        .upsert(
          { id: entry.row_id, user_id: entry.user_id, data: entry.data, updated_at: newTs, writer: DEVICE_ID },
          { onConflict: "id,user_id" }
        )
        .select("updated_at");

      if (error) {
        console.warn("[autosave] upsert error:", error.message);
        return "fail";
      }

      // If migration is applied and the row returns a timestamp, start tracking it.
      if (rows && rows[0] && rows[0].updated_at) {
        _loadedAt = rows[0].updated_at;
        rememberOurTimestamp(_loadedAt);
      }

      return "ok";
    } catch (e) {
      console.warn("[autosave] tryWrite unexpected error:", e);
      return "fail";
    }
  }

  // Execute a write for an entry, handling the retry and conflict state machines.
  async function executeWrite(entry) {
    if (_retryTimers[entry.row_id]) {
      clearTimeout(_retryTimers[entry.row_id]);
      delete _retryTimers[entry.row_id];
    }

    const result = await tryWrite(entry);

    if (result === "ok") {
      removeEntry(entry.qid);
      _conflictPending = false;
      hideConflictBanner();
      if (readQueue().length === 0) {
        setStatus("saved", "SAVED ✓");
      }
      return;
    }

    if (result === "conflict") {
      // The conditional UPDATE matched 0 rows, so the server's updated_at is not
      // the one we last saw. Two very different situations produce that, and they
      // must NOT be treated the same:
      //
      //   (a) We advanced it ourselves — a concurrent in-page write, or a
      //       keepalive flush whose response we never read. Nobody else's work is
      //       at stake; we just lost track. Resync and carry on.
      //   (b) Another device wrote. The user has two versions and only they can
      //       decide which survives.
      //
      // Ask the server which timestamp is actually stored and check it against the
      // ones we know we wrote. Anything we cannot positively attribute to
      // ourselves is treated as (b) — when in doubt, warn rather than overwrite.
      //
      // This previously retried with an unconditional upsert, which always
      // succeeds. That turned every (b) into a silent overwrite of the other
      // device's work while showing the user "SAVED ✓".
      const server = await fetchServerTimestamp(entry);

      // Ours if: the row is gone, we saw ourselves write that timestamp, or the
      // last writer is this tab (or the tab that fired this entry's keepalive).
      const ours =
        server.ts === null ||
        wroteItOurselves(server.ts) ||
        server.writer === DEVICE_ID ||
        (entry.flushed_by && server.writer === entry.flushed_by);
      if (server.ok && ours) {
        // (a) Our own write, or the row is gone entirely. Adopt the server's
        // position and retry once — still conditional, so if another device
        // slips in between these two calls we come straight back here.
        _loadedAt = server.ts;
        const retryResult = await tryWrite(entry);
        if (retryResult === "ok") {
          removeEntry(entry.qid);
          _conflictPending = false;
          hideConflictBanner();
          if (readQueue().length === 0) setStatus("saved", "SAVED ✓");
          return;
        }
      }

      // (b) Another device wrote, or we could not establish who did. Leave the
      // entry queued and the server untouched; the user resolves it via the
      // banner (Reload discards ours, Override deliberately wins).
      _conflictPending = true;
      // Remember it across reloads: a conflicted entry is never flushed or
      // written blindly, and the next load shows the server's version.
      patchEntry(entry.qid, { conflicted: true });
      setStatus("offline", "CHANGED ELSEWHERE");
      showConflictBanner();
      return;
    }

    // result === 'fail'
    const attempts = incrementAttempts(entry.qid);

    if (attempts >= MAX_ATTEMPTS) {
      showFailBanner();
      setStatus("error", "SAVE FAILED");
      return;
    }

    setStatus("offline", "OFFLINE — WILL RETRY");
    const delay = RETRY_DELAYS[attempts - 1] ?? 15000;

    _retryTimers[entry.row_id] = setTimeout(async () => {
      delete _retryTimers[entry.row_id];
      const current = readQueue().find((e) => e.qid === entry.qid);
      if (current) {
        setStatus("saving", "SAVING...");
        await executeWrite(current);
      }
    }, delay);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // init(userId, loadedAt): must be called before push().
  // loadedAt: the updated_at timestamp from the initial sbGetWithTs call (may be null
  // if migration 002 hasn't been applied yet — falls back to unconditional upsert).
  function init(userId, loadedAt = null) {
    _userId = userId;
    _loadedAt = loadedAt;
  }

  // setLoadedAt(ts): update the reference timestamp after a fresh load.
  // Called from initData() after sbGetWithTs() returns, so future writes are
  // conditional on this timestamp.
  function setLoadedAt(ts) {
    _loadedAt = ts;
  }

  // push(rowId, data): debounced write.
  function push(rowId, data) {
    if (!_userId) {
      console.warn("[autosave] push() called before init()");
      return;
    }

    // If a conflict is pending, a new edit clears the banner (user is actively editing —
    // they've implicitly chosen to keep their local version).
    if (_conflictPending) {
      _conflictPending = false;
      hideConflictBanner();
    }

    const entry = upsertEntry(_userId, rowId, data);
    setStatus("saving", "SAVING...");

    if (_debounceTimers[rowId]) clearTimeout(_debounceTimers[rowId]);

    _debounceTimers[rowId] = setTimeout(async () => {
      delete _debounceTimers[rowId];
      const current = readQueue().find((e) => e.user_id === _userId && e.row_id === rowId);
      if (current) await executeWrite(current);
    }, DEBOUNCE_MS);
  }

  // drainQueueOnLoad(): flush pending writes from a previous session.
  // Called before sbGetWithTs so we don't load stale data.
  // Uses unconditional upsert (no _loadedAt yet at drain time).
  async function drainQueueOnLoad() {
    if (_draining) return;
    _draining = true;

    const queue = readQueue().filter((e) => e.user_id === _userId);
    if (queue.length === 0) {
      _draining = false;
      return;
    }

    setStatus("saving", "SAVING...");

    for (const entry of queue) {
      if (entry.base) {
        // Write it on top of the version it was edited from; if someone else has
        // saved since, this lands in the conflict path instead of overwriting.
        _loadedAt = entry.base;
      } else if (entry.conflicted) {
        // Conflicted with nothing to compare against: never write it blindly.
        _conflictPending = true;
        setStatus("offline", "CHANGED ELSEWHERE");
        showConflictBanner();
        continue;
      }
      await executeWrite(entry);
    }

    _draining = false;
  }

  // overrideAndSave(): user clicked "Override and save anyway" on the conflict banner.
  // Clears _loadedAt so the next write uses unconditional upsert (ignores server version).
  // After the write succeeds, _loadedAt is updated from the server response.
  async function overrideAndSave() {
    _loadedAt = null;
    _conflictPending = false;
    hideConflictBanner();
    setStatus("saving", "SAVING...");

    const queue = readQueue().filter((e) => e.user_id === _userId);
    for (const entry of queue) {
      await executeWrite(entry);
    }
  }

  // flush(): cancel pending debounce timers and fire keepalive fetches for every
  // queued entry. Used on pagehide/beforeunload/visibilitychange.
  // Cannot use async/await in unload context — uses fetch with { keepalive: true }.
  // NOTE: keepalive always uses unconditional upsert (can't do conditional UPDATE
  // in a synchronous unload handler). The queue entry stays in localStorage as a
  // safety net and is drained on next load.
  function flush() {
    Object.keys(_debounceTimers).forEach((rowId) => {
      clearTimeout(_debounceTimers[rowId]);
      delete _debounceTimers[rowId];
    });

    const queue = readQueue().filter((e) => e.user_id === _userId);
    if (queue.length === 0) return;

    // Keepalive is fire-and-forget: we never see the response, so we cannot know
    // whether it landed or what the row's updated_at became. Clear _loadedAt so the
    // next in-page executeWrite uses an unconditional upsert rather than a
    // conditional UPDATE against a timestamp we are only guessing at.
    //
    // Tried and reverted: choosing the timestamp here, sending it explicitly and
    // keeping the next write conditional. When a keepalive does not land — routine
    // during tests and on flaky networks — _loadedAt diverges from the server and
    // every subsequent save reports a conflict. The narrow overwrite window this
    // leaves open is documented in progress.md under "Known limitations".
    // Entries with a known base are sent conditionally (below) and tagged with this
    // tab's writer id, so _loadedAt can stay: if the keepalive lands, the next
    // conditional write misses, finds writer === us, and resyncs. Only an entry with
    // no base (legacy, or after Override) still forces the old unconditional path.
    if (queue.some((e) => !e.base && !e.conflicted)) _loadedAt = null;

    let token = null;
    try {
      const raw = localStorage.getItem(SB_SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        token = parsed?.access_token ?? parsed?.currentSession?.access_token ?? null;
      }
    } catch (e) {
      console.warn("[autosave] flush: could not read session token:", e);
    }

    if (!token) {
      console.warn("[autosave] flush: no token available, skipping keepalive");
      return;
    }

    for (const entry of queue) {
      // Never push a version the user has been told is out of date.
      if (entry.conflicted) continue;
      const headers = {
        "Content-Type": "application/json",
        apikey: SB_ANON_KEY,
        Authorization: `Bearer ${token}`,
      };
      let url;
      let method;
      let body;
      if (entry.base) {
        const q = new URLSearchParams({
          id: `eq.${entry.row_id}`,
          user_id: `eq.${entry.user_id}`,
          updated_at: `eq.${entry.base}`,
        });
        url = `${SB_URL}/rest/v1/bethel_data?${q}`;
        method = "PATCH";
        body = JSON.stringify({ data: entry.data, updated_at: new Date().toISOString(), writer: DEVICE_ID });
        patchEntry(entry.qid, { flushed_by: DEVICE_ID });
      } else {
        url = `${SB_URL}/rest/v1/bethel_data`;
        method = "POST";
        headers.Prefer = "resolution=merge-duplicates";
        body = JSON.stringify({ id: entry.row_id, user_id: entry.user_id, data: entry.data, writer: DEVICE_ID });
      }

      try {
        fetch(url, { method, keepalive: true, headers, body }).catch(() => {});
      } catch (e) {
        console.warn("[autosave] flush: keepalive fetch failed synchronously:", e);
      }
    }
  }

  // retryPending(): make a real, confirmed write for anything still queued.
  //
  // This is the in-page counterpart to flush(). flush() runs when the page is
  // going away and can only fire a keepalive it will never hear back from, so it
  // leaves the entry in the queue as a safety net. Nothing was picking that net
  // back up while the page stayed open: the entry sat there with no timer
  // against it, the indicator stayed on SAVING, and the write only actually
  // happened on the next page load via drainQueueOnLoad(). If the operator kept
  // working and never reloaded, it did not happen at all.
  //
  // Entries with a live debounce or retry timer are left alone — those are
  // already on their way, and cancelling them is what caused the problem.
  async function retryPending() {
    if (!_userId || _draining || _conflictPending) return;

    const queue = readQueue().filter((e) => e.user_id === _userId);
    if (queue.length === 0) return;

    for (const entry of queue) {
      if (_debounceTimers[entry.row_id] || _retryTimers[entry.row_id]) continue;
      setStatus("saving", "SAVING...");
      await executeWrite(entry);
    }
  }

  // getPendingData(rowId, userId): returns the data payload from the queue entry
  // for the given row, or null if none exists. Used by initData() to detect
  // unsaved writes that survived a drain failure and prefer them over stale
  // Supabase data, preventing new edits from overwriting unsynced changes.
  // The whole queued entry (data, base, conflicted), for initData's load decision.
  function getPendingEntry(rowId, userId) {
    return readQueue().find((e) => e.user_id === userId && e.row_id === rowId) || null;
  }

  // "Reload" on the conflict banner: drop this user's queued (out-of-date) edits so
  // the reload shows, and keeps, the other device's version.
  function discardPending() {
    writeQueue(readQueue().filter((e) => e.user_id !== _userId));
    _conflictPending = false;
    hideConflictBanner();
  }

  function getPendingData(rowId, userId) {
    const queue = readQueue();
    const entry = queue.find((e) => e.user_id === userId && e.row_id === rowId);
    return entry ? entry.data : null;
  }

  window.autosave = {
    init,
    push,
    flush,
    retryPending,
    drainQueueOnLoad,
    setLoadedAt,
    overrideAndSave,
    getPendingData,
    getPendingEntry,
    discardPending,
  };
})();
