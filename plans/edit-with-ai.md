# Edit with AI

Operator asked 2026-10-05: a box (tried as a tab, then on every tab; settled on the top of Operations) where a user types what they want changed ("add these
expenses to 12 Maple", "raise Grant's rate to 800") instead of editing field by field.
Name chosen: **Edit with AI**.

## How it works

1. The user types a request. The browser sends it, the last few chat turns, and its
   current `homes` to the `ai-edit` edge function.
2. `ai-edit` checks the caller's login, holds them to a daily cap, and asks Claude for a
   reply plus a list of changes drawn from a **fixed set of change types** (below).
   It writes nothing.
3. The browser checks every change against the live `homes` and shows each one in plain
   words ("12 Maple: add expense Water, $90/mo"). Anything it can't match (a home or
   expense that doesn't exist) blocks the whole set, with the reason shown.
4. **Apply** re-runs the changes against `homes` as they are at that moment, then saves
   through `persistData()` — the same autosave path as a typed edit (conditional write,
   conflict banner, retry, offline queue). No second save path exists.
5. **Undo** puts back the snapshot taken just before Apply, through the same save. It is
   refused if anything changed after Apply (it would wipe that edit).

## Change types

add_expense, update_expense (amount / name / category), remove_expense, set_startup_cost,
add_home, rename_home, add_beds, update_bed (status / resident / rate / move-in),
remove_bed (vacant beds only). Deleting a whole home is not offered — that stays a
deliberate click on Operations.

Bed rules match the bed editor: an occupied bed at $3,000+ becomes recuperative care and
back. Removing beds renumbers the rest, as the Operations tab does.

## Safety

- Claude never touches the database. Worst case is a wrong preview the user declines.
- Apply is disabled until the roster has loaded (never applies to placeholder data).
- Cap: 100 requests per account per day (`ai_edit_usage`, migration 017).
- Chat history lives only in the open tab.

## Tests (tests/ai-edit.spec.js)

Server response is mocked in most tests, so they test the dashboard's side exactly and
cost nothing. One live test sends a real request to prove the function and model answer.
- preview shows the changes and changes nothing until Apply
- Apply saves to Supabase (asserted on the stored row, not the banner)
- Undo restores the stored row
- a change naming a missing home/expense blocks Apply
- removing an occupied bed is refused
- unauthenticated calls to the function are rejected
- fits a 375px phone
