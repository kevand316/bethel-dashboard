// lib/autosave.js
// Autosave queue with retry, offline detection, and flush-on-pagehide.
//
// Contract (from autosave.md):
//   1. "saving..."   — immediately on push(); Supabase not yet confirmed.
//   2. "saved ✓"    — only after Supabase responds with success.
//   3. "offline — will retry" — after first failure; retry timer running.
//   4. "save failed — please reload" — after MAX_ATTEMPTS exhausted.
//
// localStorage key "bethel_autosave_queue" holds an array of pending entries.
// De-duplication: upsertEntry() replaces any existing entry for the same row_id,
// so 1000 rapid push("homes", ...) calls = 1 queue entry, never 1000.
//
// Must be loaded AFTER lib/supabase.js (uses window._supabase for auth token).

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
  // Used for keepalive flush during pagehide (can't await in unload handlers).
  const SB_SESSION_KEY = "sb-yqgccykbdihsjqlapghr-auth-token";

  let _userId = null;
  let _debounceTimers = {}; // { [rowId]: timerId }
  let _retryTimers = {}; // { [rowId]: timerId }
  let _draining = false; // prevents concurrent drainQueueOnLoad calls

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

  // Add or replace the entry for this (userId, rowId) pair.
  // Returns the new/updated entry.
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
    const queue = readQueue().filter((e) => e.qid !== qid);
    writeQueue(queue);
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
    let banner = document.getElementById("save-fail-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "save-fail-banner";
      banner.className = "save-fail-banner";
      banner.textContent = "SAVE FAILED — PLEASE RELOAD";
      document.body.appendChild(banner);
    }
    banner.style.display = "block";
  }

  // ── Network write ──────────────────────────────────────────────────────────

  // Attempt a single Supabase upsert for the given entry.
  // Returns true on success, false on failure.
  async function tryWrite(entry) {
    try {
      const client = window._supabase;
      if (!client) return false;

      const {
        data: { user },
      } = await client.auth.getUser();
      if (!user || user.id !== entry.user_id) return false;

      const { error } = await client
        .from("bethel_data")
        .upsert(
          { id: entry.row_id, user_id: entry.user_id, data: entry.data },
          { onConflict: "id,user_id" }
        );

      if (error) {
        console.warn("[autosave] upsert error:", error.message);
        return false;
      }
      return true;
    } catch (e) {
      console.warn("[autosave] tryWrite unexpected error:", e);
      return false;
    }
  }

  // Execute a write for an entry, handling retry schedule on failure.
  // If all retries exhausted → showFailBanner().
  async function executeWrite(entry) {
    // Cancel any pending retry timer for this row (we're writing now)
    if (_retryTimers[entry.row_id]) {
      clearTimeout(_retryTimers[entry.row_id]);
      delete _retryTimers[entry.row_id];
    }

    const ok = await tryWrite(entry);

    if (ok) {
      removeEntry(entry.qid);
      // Only show "saved ✓" if no other entries are still pending
      if (readQueue().length === 0) {
        setStatus("saved", "SAVED ✓");
      }
      return;
    }

    // Write failed — increment attempt counter
    const attempts = incrementAttempts(entry.qid);

    if (attempts >= MAX_ATTEMPTS) {
      showFailBanner();
      setStatus("error", "SAVE FAILED");
      return;
    }

    // Schedule retry
    setStatus("offline", "OFFLINE — WILL RETRY");
    const delay = RETRY_DELAYS[attempts - 1] ?? 15000;

    // Re-read from queue before retry in case data was superseded by a newer push
    _retryTimers[entry.row_id] = setTimeout(async () => {
      delete _retryTimers[entry.row_id];
      const queue = readQueue();
      const current = queue.find((e) => e.qid === entry.qid);
      if (current) {
        // Show saving again while retrying
        setStatus("saving", "SAVING...");
        await executeWrite(current);
      }
    }, delay);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // init(userId): must be called before push() — stores the user ID for queue scoping.
  function init(userId) {
    _userId = userId;
  }

  // push(rowId, data): debounced write.
  //   1. Immediately writes to localStorage queue (synchronous — survives pagehide).
  //   2. Shows "saving..." indicator.
  //   3. After DEBOUNCE_MS, executes the network write.
  function push(rowId, data) {
    if (!_userId) {
      console.warn("[autosave] push() called before init()");
      return;
    }

    // 1. Sync write to queue — survives any page unload within this call
    const entry = upsertEntry(_userId, rowId, data);

    // 2. Show saving state immediately
    setStatus("saving", "SAVING...");

    // 3. Debounce the network write
    if (_debounceTimers[rowId]) {
      clearTimeout(_debounceTimers[rowId]);
    }
    _debounceTimers[rowId] = setTimeout(async () => {
      delete _debounceTimers[rowId];
      // Re-read the queue entry — it may have been superseded by a newer push
      const queue = readQueue();
      const current = queue.find((e) => e.user_id === _userId && e.row_id === rowId);
      if (current) {
        await executeWrite(current);
      }
    }, DEBOUNCE_MS);
  }

  // drainQueueOnLoad(): called at startup (before sbGet) to flush any pending
  // writes from a previous session that crashed during the debounce window.
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

  // flush(): cancel all pending debounce timers and fire a keepalive fetch for
  // every queue entry. Used on pagehide/beforeunload/visibilitychange.
  // Cannot use async/await in unload context — uses fetch with { keepalive: true }.
  function flush() {
    // Cancel debounce timers — the keepalive fetch is the flush
    Object.keys(_debounceTimers).forEach((rowId) => {
      clearTimeout(_debounceTimers[rowId]);
      delete _debounceTimers[rowId];
    });

    const queue = readQueue().filter((e) => e.user_id === _userId);
    if (queue.length === 0) return;

    // Read the session token synchronously from localStorage.
    // The Supabase JS SDK stores it here under its own key.
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
        }).catch(() => {
          // Best-effort — if keepalive fails, the queue entry is still in
          // localStorage and will be replayed by drainQueueOnLoad() next load.
        });
      } catch (e) {
        // Synchronous errors from fetch() itself (e.g., body too large for keepalive)
        console.warn("[autosave] flush: keepalive fetch failed synchronously:", e);
      }
    }
  }

  window.autosave = { init, push, flush, drainQueueOnLoad };
})();
