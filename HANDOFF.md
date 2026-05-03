# How to actually use this — for Kev

You're not a developer and you don't need to become one. This guide is the minimum you need to know to drive Claude Code productively. Read it once before you start.

## 1. The setup, one time only

You already have Claude Code installed (you're using it). To start using this new structure:

1. Open Terminal (Mac: Cmd+Space, type "terminal", hit Enter).
2. Navigate to your bethel-dashboard repo. If you don't remember how: `cd ~/path/to/bethel-dashboard` — replace `path/to` with wherever you cloned the repo. If you're unsure, you can run `find ~ -name "bethel-dashboard" -type d 2>/dev/null` to find it.
3. Drop all the files I just generated into the repo root, preserving the folder structure (`.claude/` stays as a folder; `plans/` stays as a folder).
4. Type `claude` and hit Enter. You're in Claude Code.
5. Open `STARTER_PROMPT.md` in any text editor, copy the prompt inside, paste it into Claude Code, hit Enter.

That's day one. From here on out, every time you start a session in this repo, Claude Code will automatically read CLAUDE.md and follow the rules in there.

## 2. The "show me it working" rule

You can't read code. That's fine — but you also can't trust "it's done" without verification. Whenever Claude Code says something is finished, your next message is always some version of:

> "Show me it working. Run the tool and walk me through what's happening."

Or, more specifically for this project:

> "Run the full test suite and show me it green. Then start the dev server and walk me through logging in as user A and user B and confirming they can't see each other's data."

If Claude Code can't show you working software, **it isn't done.** Period. Don't accept "I made the changes" as evidence of anything.

## 3. The two-user manual test (your final gate before deploy)

This is the test you personally have to do, with your own eyes, before this thing goes live to anyone:

1. In Supabase, create two test accounts. Real-looking emails, throwaway passwords. Call them `test1@yourdomain.com` and `test2@yourdomain.com` or whatever.
2. Open the dashboard in **two different browsers** (not two tabs — Chrome and Safari, or Chrome and Chrome-Incognito). One browser per account.
3. Log in as test1 in browser A. Add some fake numbers. Take a screenshot. Wait for "saved ✓" everywhere.
4. Log in as test2 in browser B. Verify the dashboard is empty. Verify the reports tab has no screenshots.
5. Add different fake numbers as test2 in browser B.
6. Refresh both browsers. Each one should still show only its own data.
7. Open developer tools in each browser, look at the URL bar, try to manually visit URLs you'd expect to load the *other* user's data. Should fail.
8. Log out of both. Log back in. Data still there, still isolated.

If any step shows the wrong data: **stop, do not deploy, tell Claude Code.** That is the bug that ends this whole project if it ships unfixed.

## 4. Describing what you want

When asking Claude Code to build or change something, describe **outcomes**, not **implementation**:

✅ "When a user clicks 'Take screenshot', the screenshot should appear in the reports tab within 3 seconds."
✅ "If the network drops while saving, the user should see a 'will retry' message — not 'saved'."
✅ "Forgot password should send the email even if the user typed extra spaces in the email field."

❌ "Use Supabase's onAuthStateChange listener to handle..."
❌ "Add a debounce of 500ms to the input handler..."

You don't know that stuff. You don't need to. Claude Code does the implementation. You describe what good looks like.

## 5. When something goes weird

The pattern is always the same:

1. **Don't panic, don't accept it.** "Looks fine" without verification is how things break later.
2. **Ask for an explanation in plain language.** "Explain what you just did, like I'm twelve. What changed and why?"
3. **Ask for the demo.** "Show me it working."
4. **If it broke something:** "Undo the last change. Then let's plan again before trying."
5. **If you keep hitting the same problem:** ask Claude Code to add a note to CLAUDE.md so it doesn't happen next session. You can literally type: "Add to CLAUDE.md so you don't make this mistake again."

## 6. Updating CLAUDE.md without touching files

CLAUDE.md is the rulebook for this project. It's meant to grow over time. You never have to open it yourself. Inside Claude Code, you can either:

- Type `#` followed by your instruction. Claude Code saves it to CLAUDE.md automatically.
- Just say: "Add to CLAUDE.md: never deploy on a Friday." It'll do it.

Every time you correct Claude Code on the same thing twice, that's the signal to add a line.

## 7. Starting fresh between tasks

Long conversations get messy. Habit:

- One feature or bug per session. When that's done, type `/clear` and start fresh.
- Before clearing, say: "Summarize what we accomplished and append it to `progress.md`."

Treat each session as disposable. The CLAUDE.md, the tests, and the progress notes are what persist between sessions.

## 8. The session-ending checklist

Before you close Terminal at the end of a work session:

- ✅ "Run all the tests one more time and confirm green."
- ✅ "Did we add anything new that should go in CLAUDE.md?"
- ✅ "Append our progress to progress.md."
- ✅ "Commit the changes to git." (Claude Code knows how. You don't have to do anything except say so.)
- ✅ Don't push to main automatically. Push when you've manually verified the new state by clicking through the dashboard yourself.

## 9. The deploy gate

Before any change reaches dashboard.bethelresidency.com:

1. Full test suite green: `npx playwright test` returns all green, no skipped tests.
2. Two-user manual test from section 3 above passes.
3. You've poked around the dashboard yourself for a few minutes and nothing looks wrong.

If 1 or 2 fail, do not deploy. If 3 turns up something weird, file it as a bug for the next session.

## 10. What success looks like

You'll know this worked when:

- You describe what you want in plain English.
- Claude Code makes a plan you can read and react to.
- You say go.
- Claude Code writes tests first, then code, then shows you the tool working.
- You come back tomorrow and it still works exactly the same way.
- You tweak something with a one-line request, and the rest stays stable.

If those things are happening, you've replaced the reactive "Claude Code finds a bug every time I ask" pattern with a system that catches issues before you ever see them.

## 11. The next tool

When you want to build something else (not this dashboard, a new tool), open a new chat in Claude.ai (the website or app — not Claude Code) and say:

> "I want to build a new tool."

The bootstrap skill will fire again. New project, new folder, new CLAUDE.md, new guardrails.
