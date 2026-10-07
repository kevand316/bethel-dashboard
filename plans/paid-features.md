# Paid features (texting, Outreach, Edit with AI)

Date: 2026-10-06. Kev: turn the costly features off for everyone except info@bethelresidency.com
until there is a paywall. Everything else stays free.

## Outcome
- An account is "paid" if it has a row in `paid_accounts` (migration 022). Seeded: info@bethelresidency.com,
  plus the two Playwright robot accounts so the existing suite keeps exercising these features.
- Free accounts: no Edit-with-AI box, no Outreach tab, no Team tab, no texting number in the header,
  no Texts/Announce buttons on Reports. Everything else unchanged.
- Server is the real gate (hiding buttons is only cosmetic):
  - `ai-edit`, `outreach-search`, `team-invite`, `announce` answer 403 "not on your plan" for free accounts.
  - `sendSms` refuses to send for a free account (logs the text as `not_sent_free`), covering
    reminders, notifications, join replies and ticket texts.
  - `sms-inbound` ignores texts from people whose only team is a free account (no AI call, no report),
    and treats a free account's JOIN code as invalid.
- Turning someone on later = insert their user_id into `paid_accounts` (the paywall will do this).

## Tests (tests/paid.spec.js)
A third robot, playwright-c@bethel.test, pre-created 2026-10-06 with no paid row; password only in .env.test.
- Free account sees none of the paid UI; paid account A still does.
- Free account's token gets 403 from ai-edit, outreach-search, team-invite, announce.
- A team member of the free account texts in: ignored, no report, no reply.
