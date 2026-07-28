# Plan: Quick Calc

## What we're building

A new "Quick Calc" tab in the dashboard: a stateless scratch-pad that answers "is this
home even profitable, and what could it generate?" from five numbers the operator can
type in twenty seconds — beds, bedrooms, occupancy, monthly rate per bed, and a flat
monthly expense total. Everything recalculates live as you type. No itemized expenses,
no home record, nothing saved.

On top of the single-point estimate it shows a **rate range**: enter a low rate and a
high rate and see Low / Base / High side by side, so the operator can see what the same
home generates if they test pricing at the bottom and the top of the market.

## Why

Today the only way to see what a home produces is to create it in Operations and enter
every bed and every expense line. That's the right tool for a home you actually own; it's
far too slow for "should I even look at this deal?" The operator wants a number before
committing any data entry, and a range rather than a single point, because the rate is
the variable they actually control when testing a market.

Success: the operator can price a hypothetical home, see PROFITABLE / NOT PROFITABLE and
an annual cashflow figure, and see the spread between a conservative and an aggressive
rate — all without touching their real numbers.

## Out of scope

- No database reads or writes. No Supabase calls, no autosave, no `user_id`, no rows.
  Values reset on reload and that is intentional.
- No changes to the existing Projections tab, Operations, auth, or autosave.
- No saving a Quick Calc result as a home, snapshot, or PDF.
- Bedrooms does not affect the money math — it's a sanity display only (beds per room).
- The range varies the **rate** only, not occupancy or expenses. One variable is what
  makes the comparison readable.

## Acceptance criteria

- [ ] A "Quick Calc" tab appears between Projections and Reports and opens its own view.
- [ ] Inputs: beds (12), bedrooms (4), occupancy % (90), rate/bed (850), monthly
      expenses (1200), low rate (750), high rate (1000) — each with those defaults.
- [ ] At defaults the verdict reads PROFITABLE and outputs are non-zero and finite.
- [ ] Outputs recalculate on input, with no button press.
- [ ] Setting expenses above revenue flips the verdict to NOT PROFITABLE.
- [ ] Zero beds (or zero rate) shows "—" in every derived output and the verdict —
      never NaN, Infinity, or $NaN.
- [ ] The range strip shows Low / Base / High columns, each with rate, monthly revenue,
      monthly cashflow and annual cashflow.
- [ ] Breakeven occupancy is shown, and is flagged when it exceeds 100% (unachievable).
- [ ] Layout matches the existing visual language and stacks cleanly at 375px.
- [ ] No inline styles — all styling via classes in the existing `<style>` block.

## Test plan

`tests/quickcalc.spec.js`, all tagged `@smoke` (fast, no data writes):

1. **Defaults + profitable verdict** — open the tab, assert the default input values and
   that the verdict reads PROFITABLE with a non-zero annual cashflow.
2. **Live recalculation flips the verdict** — set expenses above revenue, assert without
   any button press that the verdict becomes NOT PROFITABLE and cashflow renders negative.
3. **Zero beds shows "—", never NaN** — set beds to 0, assert the derived outputs are all
   "—" and that the view's text contains no "NaN" or "Infinity".
4. **Rate range** — assert Low / Base / High columns render, and that High annual cashflow
   is greater than Base, which is greater than Low.

These need a signed-in dashboard, so they use the existing `signIn` fixture like the other
dashboard specs. They write nothing, so no `afterEach` cleanup is required.

## Implementation outline

1. Add a `.qc-*` block to the existing `<style>` block: input card, results grid reusing
   the `cashflow-item` visual language, verdict element, range table, and the 768/480px
   stacking rules.
2. Add the tab button between Projections and Reports.
3. Add `<div class="view" id="view-quickcalc">` with the input card, the results grid, the
   verdict, and the range strip. Static markup; ids only, no inline styles.
4. Add `renderQuickCalc()` — reads the inputs, clamps them, computes, writes the outputs.
   Wire it to `oninput` on every field and to `switchTab('quickcalc')`, and call it once at
   load so the defaults are populated.
5. Reuse `fmt()` for currency; add a local percent formatter.

## Edge cases and failure modes

- **Zero or blank beds / rate** — revenue basis is 0, so revenue, cashflow, annual, margin,
  breakeven and the verdict all render "—" rather than a misleading $0 / NaN / Infinity.
- **Negative input** — a user can type "-5"; clamp every input at 0 before computing.
- **Non-numeric / blank input** — `parseFloat` yields NaN; coerce to 0 via `|| 0`.
- **Occupancy over 100** — clamp to 100 so revenue can't exceed full occupancy.
- **Breakeven over 100%** — mathematically valid but operationally impossible; show the
  figure in red with an "over capacity" note rather than hiding it.
- **Low rate higher than high rate** — allowed, not corrected. The columns are labeled by
  which input they came from, so the display stays honest.
- **No network / Supabase down** — irrelevant by design; this tab never touches the network.

## Files we expect to touch

- `index.html` — style block, tab bar, new view, `renderQuickCalc()`, `switchTab` hook
- `tests/quickcalc.spec.js` — new tests
- `plans/quick-calc.md` — this plan
- `progress.md` — note the feature once it's green

No migration. No schema change. No new library.

## Review checklist (before merging)

- [ ] All acceptance criteria have a passing test
- [ ] Hooks (prettier, smoke tests) all green
- [ ] Full Playwright suite green, including @isolation
- [ ] No new TODO comments left without a follow-up task
- [ ] No secrets, credentials, or `.env` content committed
- [ ] Eyeball at 375px and at desktop width
