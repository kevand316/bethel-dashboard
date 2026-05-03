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
        // The set_updated_at trigger automatically sets updated_at = now() on the row.
        const { data: rows, error } = await client
          .from("bethel_data")
          .update({ data: entry.data })
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
        return "ok";
      }

      // Unconditional upsert (pre-migration _loadedAt is null, or override path).
      const { data: rows, error } = await client
        .from("bethel_data")
        .upsert(
          { id: entry.row_id, user_id: entry.user_id, data: entry.data },
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
      // Stop retrying. Banner asks the user to Reload or Override.
      _conflictPending = true;
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
      const url = `${SB_URL}/rest/v1/bethel_data`;
      const body = JSON.stringify({
        id: entry.row_id,
        user_id: entry.user_id,
        data: entry.data,
      });

      try {
        fetch(url, {
          method: "POST",
          keepalive: true,
          headers: {
            "Content-Type": "application/json",
            apikey: SB_ANON_KEY,
            Authorization: `Bearer ${token}`,
            Prefer: "resolution=merge-duplicates",
          },
          body,
        }).catch(() => {});
      } catch (e) {
        console.warn("[autosave] flush: keepalive fetch failed synchronously:", e);
      }
    }
  }

  window.autosave = { init, push, flush, drainQueueOnLoad, setLoadedAt, overrideAndSave };
})();
