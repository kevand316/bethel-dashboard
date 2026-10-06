# Plan: Tickets (resolve reports from the dashboard or by text)

## What we're building
Every report gets a per-account number (#14). Maintenance, Incidents and Inventory
reports are tickets: they start Open and can be Resolved (and Reopened). Staff can
text "#14 resolved new hinge" or "#14 still pending waiting on parts"; the dashboard
has Resolve / Reopen / Add note buttons and an Open/Resolved filter.

## Decisions (proposed to Kev 2026-10-06; he hadn't objected)
- Numbers: `reports.ticket_no`, assigned by a DB trigger, per account, never edited by clients.
- Tickets = maintenance, incidents, inventory. Others get a number but `status` stays null.
- `status` open|resolved, `resolved_at`, `resolved_by`, `updates` jsonb [{at, by, action, note}].
- Text commands are handled by code before the AI (like APPROVE 4821). Anyone active on
  the team whose role can file reports may update a ticket in their own account.
- "still pending" keeps it open and logs the note; it texts nobody.
- Resolved by text: texts the original reporter + every-report roles, never the resolver.
- Resolved on the dashboard: texts the original reporter only (the owner clicked it).
- The ticket number appears in "Submitted ✓ #14 …" and in report notifications.

## Out of scope
- Assigning tickets to people, due dates, priorities.
- Texting updates for "still pending".

## Acceptance criteria / tests (tests/tickets.spec.js)
- [ ] Numbers count up per account; tickets start Open, other buckets have no status.
- [ ] The dashboard cannot change a ticket number.
- [ ] "#N resolved <note>" by text resolves it, logs it, texts reporter + every-report, not the resolver.
- [ ] "#N still pending <note>" keeps it open and logs it.
- [ ] A number from another account is "not found" and nothing changes (@isolation).
- [ ] Dashboard: card shows #N and Open; Resolve with note → Resolved; filter; Reopen.
- [ ] Fits 375px.
