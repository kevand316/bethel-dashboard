---
paths:
  - lib/autosave.js
  - lib/supabase.js
  - index.html
  - tests/autosave.spec.js
---

# Autosave rules

The operator described the disaster scenario in their own words: "someone goes in there and spends an hour getting their numbers together and they log back in tomorrow and none of their data saved — that is evil." Read that line again before changing anything in this scope.

## The autosave contract

Every user edit goes through this lifecycle, and the UI MUST reflect the actual stage:

1. **`saving...`** — the edit has been observed in the UI but Supabase has not yet confirmed the write. Show this immediately on every keystroke / change event (debounced ~500ms is fine, but the indicator appears the moment input is detected).
2. **`saved ✓`** — Supabase responded with success. Only show this AFTER confirmation. Never optimistically.
3. **`offline — will retry`** — the write failed (network, 5xx, timeout). The edit is queued in localStorage and a retry timer is running. The user can keep working; new edits stack onto the queue.
4. **`save failed — please reload`** — only after retries have been exhausted AND the queue cannot be drained. This is the "we're sorry" state. It must be loud (banner, not a tiny indicator).

## Hard rules

- **No silent catches.** Every `try/catch` around a save must either retry or surface an error state. A `catch` that swallows the error and lets the UI continue showing "saved" is the bug we are explicitly preventing.

- **localStorage is a queue, not a fallback.** The old behavior was: "Supabase failed → write to localStorage → done." That loses data when the browser is cleared, when the user switches devices, when the localStorage quota is exceeded. New behavior: localStorage holds *pending* writes that have not yet been confirmed by Supabase. A retry loop drains the queue. Once Supabase confirms, the corresponding queue entry is removed.

- **Queue entries must include enough context to retry independently.** Each entry: `{id, user_id, table, row_id, column, new_value, timestamp, attempts}`. On retry, the entry is self-sufficient — it does not depend on other queued entries or on UI state.

- **Last-write-wins, but the user must know.** If a user edits the same field on two devices, the later write wins. Don't try to merge. But if a save's response indicates the row was modified by a newer write (use Supabase's `updated_at` or a version column), surface "this was changed elsewhere — refresh to see latest" rather than silently overwriting.

- **Debounce, but flush on blur and on page-hide.** Typing into a numeric field should debounce so we're not hammering Supabase per-keystroke. But the moment the user blurs the field, switches tabs, or closes the page (`visibilitychange` / `pagehide` events), flush the queue immediately. The user might not be coming back.

- **Never trust the network. Never assume success.** A 200 response means Supabase received the write. A failed `fetch()` means nothing was received. A timeout means we don't know — treat as failure and retry.

## Required tests when modifying these files

`tests/autosave.spec.js` must contain and pass these scenarios:

1. **Happy path**: edit a field, see "saving...", wait, see "saved ✓", reload the page, value persists.
2. **Network drops mid-save**: use Playwright's route interception to fail the save request. Edit a field. Verify the indicator goes to "offline — will retry" and NOT "saved ✓". Restore the network. Verify the queue drains and indicator reaches "saved ✓".
3. **Page reload while pending**: edit a field, intercept the save to delay it 5 seconds, reload the page during the pending window. After reload, the queue (in localStorage) replays the pending write. The value is eventually persisted to Supabase.
4. **Cross-device edit detection**: simulate two browser contexts editing the same row. Verify the second write does not silently clobber without warning.
5. **Quota stress**: queue 1000 pending writes, verify localStorage doesn't blow up and the queue still drains.
6. **`pagehide` flush**: edit a field, immediately trigger `pagehide`. Verify the write is flushed before the page unloads (use `navigator.sendBeacon` or a synchronous flush for this).

## Things that look fine but aren't

- "I added retry logic" — show me the test that proves it works. The fix is the test, not the code.
- "It saves on blur" — what about when the user closes the laptop lid mid-edit? Cover `visibilitychange`.
- "We can just refresh from Supabase if there's a conflict" — not without warning the user. Refreshing silently is how we lose their last 5 minutes of work.
