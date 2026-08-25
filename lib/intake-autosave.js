// lib/intake-autosave.js
// Autosave for a single open intake form, writing to Google Drive.
//
// This is a sibling of lib/autosave.js, not a reuse of it. That one queues row
// writes to Supabase and survives reloads via localStorage. This one cannot do
// the same trick: the whole point of the intake design is that client answers
// never rest anywhere but the operator's Drive, and localStorage is on the
// dashboard. Parking a half-typed SSN in localStorage to survive a reload would
// quietly reintroduce exactly the thing the architecture exists to prevent.
//
// So the rules here are different, and stricter:
//   - Nothing is ever persisted locally. Not a draft, not a queue.
//   - "SAVED" is never shown optimistically. It appears after Drive confirms
//     the write and returns a new version, and at no other time.
//   - When the Google token dies mid-session the work is HELD in memory and the
//     operator is told to reconnect. It is not dropped, and it is not written
//     anywhere else in the meantime.
//   - If there is unsaved work and the page is closing, we interrupt. Losing a
//     40-field intake silently is worse than a nagging dialog.
//
// Loaded after lib/drive.js. Exposes window.intakeSave.

(function () {
  // Long enough that ordinary typing does not fire a save per keystroke, short
  // enough that an operator who types a line and looks up sees it save.
  const DEBOUNCE_MS = 1500;

  // Drive fails transiently more often than Supabase does — rate limits, brief
  // 5xx. Retry a few times before admitting defeat, backing off each time.
  const RETRY_DELAYS_MS = [2000, 5000, 15000];

  let session = null; // { fileId, version, getRecord }
  let statusCb = null;

  let state = "idle";
  let dirty = false;
  let saving = false;
  let debounceTimer = null;
  let retryTimer = null;
  let retryIndex = 0;
  let lastError = "";

  const STATUS_TEXT = {
    idle: ["", ""],
    dirty: ["saving", "UNSAVED"],
    saving: ["saving", "SAVING..."],
    saved: ["saved", "SAVED TO DRIVE ✓"],
    held: ["offline", "WAITING FOR GOOGLE"],
    conflict: ["offline", "CHANGED ELSEWHERE"],
    error: ["error", "SAVE FAILED"],
  };

  function setState(next, detail) {
    state = next;
    lastError = detail || "";
    if (statusCb) {
      const [cls, text] = STATUS_TEXT[next] || ["", ""];
      statusCb({ state: next, cls, text, detail: lastError });
    }
  }

  function clearTimers() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    debounceTimer = null;
    retryTimer = null;
  }

  // ── the save itself ────────────────────────────────────────────────────────
  async function doSave() {
    if (!session || saving) return;

    // Read the record at save time, not at schedule time, so what lands in Drive
    // is what is on screen right now — including anything typed while a previous
    // save was still in flight.
    const record = session.getRecord();

    // Clearing `dirty` before the await is what makes concurrent edits work: a
    // keystroke during the request sets it back to true, and the tail of this
    // function notices and saves again. Clearing it after would swallow that edit.
    dirty = false;
    saving = true;
    setState("saving");

    try {
      const { version } = await window.drive.saveIntake(session.fileId, record, session.version);
      session.version = version;
      saving = false;
      retryIndex = 0;

      // Something changed while we were saving — go straight round again rather
      // than reporting a "saved" state that is already stale.
      if (dirty) return schedule(0);
      setState("saved");
    } catch (e) {
      saving = false;
      // The edit never made it to Drive, so it is still outstanding no matter
      // which way this failed.
      dirty = true;

      if (e.code === "needs_reconnect") {
        // Hold. The record stays in memory and in the form; nothing is discarded
        // and nothing is written elsewhere. resumeAfterReconnect() picks it up.
        setState("held", "Reconnect Google Drive to save this intake.");
        return;
      }

      if (e.code === "conflict") {
        // Another tab or device wrote this file. Refuse rather than overwrite —
        // the operator decides whose version wins.
        setState("conflict", "This intake was changed somewhere else.");
        return;
      }

      if (retryIndex < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[retryIndex++];
        setState("saving", `Retrying in ${Math.round(delay / 1000)}s...`);
        retryTimer = setTimeout(doSave, delay);
        return;
      }

      setState("error", e.message || "Google Drive would not accept the save.");
    }
  }

  function schedule(delay) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSave, delay === undefined ? DEBOUNCE_MS : delay);
  }

  // ── public surface ─────────────────────────────────────────────────────────
  function attach({ fileId, version, getRecord, onStatus }) {
    clearTimers();
    session = { fileId, version, getRecord };
    statusCb = onStatus || null;
    dirty = false;
    saving = false;
    retryIndex = 0;
    // A freshly opened intake is in step with Drive by definition. Say "saved"
    // because it genuinely is — this is the one case where it is not optimistic.
    setState("saved");
  }

  function detach() {
    clearTimers();
    session = null;
    statusCb = null;
    dirty = false;
    saving = false;
    retryIndex = 0;
    setState("idle");
  }

  function markDirty() {
    if (!session) return;
    dirty = true;
    // Don't paint over a held or conflicted state with a cheerful "UNSAVED" —
    // those need the operator to act, and the reason must stay on screen.
    if (state !== "held" && state !== "conflict") setState("dirty");
    if (state === "held" || state === "conflict") return;
    schedule();
  }

  // Force a save now and wait for it — used when closing an intake or switching
  // away from the tab, so the operator does not walk away from unsaved work.
  async function flush() {
    if (!session) return;
    clearTimers();
    if (dirty || saving) await doSave();
  }

  // Called after the operator reconnects Google. Whatever was held is still in
  // the form, so just try again.
  function resumeAfterReconnect() {
    if (!session) return;
    if (state === "held") {
      retryIndex = 0;
      schedule(0);
    }
  }

  // The operator chose to overwrite whatever is in Drive. Drop the version check
  // for one save, then resume normal conflict detection with the new version.
  function overrideConflict() {
    if (!session) return;
    session.version = null;
    retryIndex = 0;
    schedule(0);
  }

  function hasUnsavedWork() {
    return (
      !!session &&
      (dirty || saving || state === "held" || state === "conflict" || state === "error")
    );
  }

  // Last line of defence. A browser will only show its generic dialog, but a
  // generic warning beats losing a completed intake to a closed tab.
  window.addEventListener("beforeunload", (e) => {
    if (!hasUnsavedWork()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  window.intakeSave = {
    attach,
    detach,
    markDirty,
    flush,
    resumeAfterReconnect,
    overrideConflict,
    hasUnsavedWork,
    getState: () => state,
    getDetail: () => lastError,
  };
})();
