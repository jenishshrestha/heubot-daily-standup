# Production Readiness Checklist

The status of Heubot on the path to production, and what's left to do before rolling out to the team.

Updated: **April 11, 2026**

---

## ✅ Completed

### Infrastructure

- [x] GCP project `heubot` created, linked to Apps Script
- [x] Google Chat API enabled
- [x] Google Apps Script API enabled
- [x] OAuth consent screen configured (Internal)
- [x] Supabase project provisioned with schema:
  - [x] `team_members` table (including `chat_user_id` column)
  - [x] `standup_responses` table (with unique `(date, email)` constraint)
  - [x] `questions` table
  - [x] `settings` table
  - [x] `admins` table
- [x] Jira API token generated and stored
- [x] Service account `heubot-bot@heubot.iam.gserviceaccount.com` created
- [x] Service account JSON key downloaded and stored as `SERVICE_ACCOUNT_KEY` Script Property
- [x] All Script Properties populated: `SUPABASE_URL`, `SUPABASE_KEY`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `SERVICE_ACCOUNT_KEY`
- [x] OAuth scopes granted (script.external_request, script.scriptapp, chat.spaces.*, chat.messages.*, chat.memberships.readonly)

### Local Development

- [x] `clasp` installed via bun
- [x] `bun install`, `bun run push`, `bun run status` wired via `package.json`
- [x] `.clasp.json` gitignored (contains script ID)
- [x] `.claspignore` excludes everything except the 7 source files
- [x] Git repository initialized, pushed to `github.com/jenishshrestha/heubot-daily-standup`
- [x] `main` branch has the full bot implementation merged in

### Code — core architecture

- [x] Service-account bot identity via `Bot.gs`
  - [x] JWT bearer flow token minting (`getBotAccessToken`)
  - [x] Token caching via `CacheService` (55-min TTL)
  - [x] `botMessageCreate`, `botFindDirectMessage`, `botSetupDm`, `botMessageCreateInThread`
- [x] Capture `chat_user_id` from `event.user.name` on every interaction (`captureChatUserId`)
- [x] Database layer with retry-with-backoff (`supabaseRequest`)
  - [x] Retries on network errors, 429, 5xx
  - [x] Fails fast on 4xx
  - [x] Exponential backoff with jitter (3 attempts, ~1.75s max)
- [x] Workday-aware date helpers
  - [x] `getNextWorkdayDate` (skips Sat/Sun)
  - [x] `getNextWorkdayLabel`
  - [x] `getActiveStandupDate` (reads `DIGEST_TIME` cutoff from settings)
  - [x] `formatStandupDateLabel`
- [x] Meeting-date storage model (responses keyed by the upcoming meeting, not submission day)

### Code — flows

- [x] `sendStandupNotifications` — sends notification cards, skips weekends, supports `excludeEmail`
- [x] `sendReminders` — DMs non-responders for the upcoming meeting
- [x] `postDigest` — two-phase: summary card + per-person thread replies
- [x] `handleStandupSubmit` — upsert on `(date, email)` with two-layer idempotency
- [x] `handleShowStandupForm` — opens the form, pre-fills for edit mode if a prior submission exists
- [x] `handleNotifyAll` — returns notification card as the slash command response (skips caller)
- [x] `handleDigestNow` — manual digest trigger with optional date parameter
- [x] `handleSetThisSpace` — registers the current space as the digest destination
- [x] `handleStandup` — parses optional date, opens form, enforces no past dates

### Code — cards

- [x] `buildStandupCard` — supports edit mode via `existingAnswers` parameter
- [x] `buildStandupNotificationCard` — with optional `broadcastNote` footer
- [x] `buildConfirmationCard`
- [x] `buildReminderCard`
- [x] `buildDigestSummaryCard` — response count + responders + non-responders
- [x] `buildDigestReplyCard` — per-person with clickable Jira ticket links
- [x] Admin cards: `buildSettingsCard`, `buildTeamCard`, `buildQuestionsCard`, `buildStatusCard`, etc.
- [x] All terminal admin actions use `updateMessageAction` for in-place card replacement

### Slash commands — registered in GCP

- [x] `/settings` (ID 1)
- [x] `/set-schedule` (ID 2)
- [x] `/questions` (ID 3)
- [x] `/add-question` (ID 4)
- [x] `/team` (ID 5)
- [x] `/add-member` (ID 6)
- [x] `/notify-all` (ID 7, renamed from `/trigger-now`)
- [x] `/status` (ID 8)
- [x] `/purge` (ID 9)
- [x] `/set-this-space` (ID 10)
- [x] `/digest-now` (ID 12)

### Testing — validated end-to-end

- [x] `testBotAuth` smoke test passes
- [x] `/notify-all` delivers notification card to DM (as bot, via service account)
- [x] "Fill Standup" button transforms notification into form in place
- [x] Form submit transforms form into confirmation in place
- [x] Re-opening a submitted form shows edit mode with pre-filled answers
- [x] `/set-this-space` captures the space name from event payload
- [x] `/digest-now 2026-04-13` posts threaded digest (summary + 1 thread reply)
- [x] Clickable Jira ticket link in digest reply card
- [x] `/settings`, `/team`, `/questions`, `/set-schedule` admin flows
- [x] Add/edit/remove for questions and team members

### Documentation

- [x] `README.md` — 18-step setup guide, file overview, troubleshooting
- [x] `README.md` architecture diagram (Mermaid)
- [x] `SESSION_SUMMARY.md` — session context for resuming work
- [x] `PRODUCTION_CHECKLIST.md` — this file

---

## 🔴 Blockers — must do before going live

These are hard gates. The bot does not work for anyone other than the developer until these are complete.

- [ ] **Install cron triggers** — run `createTriggers` from Apps Script editor once the trigger-creation quota resets (~24h from last attempt). Installs the 4 scheduled functions.
- [ ] **Register `/standup` slash command** (commandId 11) in GCP Console → Chat API → Configuration. Name `/standup`, description `Fill in your standup`, Type "Slash command", "Opens a dialog" unchecked. Save the outer page.
- [ ] **Create a production deployment**:
  - [ ] Apps Script → Deploy → New deployment → Add-on → copy Deployment ID
  - [ ] GCP Console → Chat API → Configuration → Connection settings → replace test Deployment ID with production one
  - [ ] Save
- [ ] **Expand app visibility**:
  - [ ] GCP Console → Chat API → Configuration → App availability → **"Make this Chat app available to specific people and groups in heubert.com"** (for phased rollout) OR **"…all people and groups in heubert.com"** (for full rollout)
  - [ ] Save
- [ ] **Seed `team_members`** with the real team roster
- [ ] **Seed `admins`** with everyone who should run admin commands
- [ ] **Send onboarding message** to each team member instructing them to run `/standup` once to register their `chat_user_id`
- [ ] **Move `heubot-0ccc63fb5088.json`** out of the project folder to a password manager or secure storage

---

## 🟡 Should do before going live

Not blockers, but significantly improve the day-1 experience and reduce the chance of a bad first impression.

- [ ] **Customize standup questions** if the defaults ("What did you accomplish today?" / "What will you work on tomorrow?" / "Any blockers?") don't match how your team talks
- [ ] **Upload bot avatar** in GCP Console → Chat API → Configuration → Avatar URL. Use a public-hosted version of `logo.png` from this repo, or any brand image
- [ ] **Write a friendly app description** in the same Configuration page. Shows up in the Apps panel when users discover the bot
- [ ] **Pilot with 2-3 people** before rolling out to the full team. Add 2-3 trusted colleagues, have them run the full daily flow for a day, iron out any surprises, then add everyone else
- [ ] **Multi-user digest test** — have 2+ people submit for the same meeting date, then run `/digest-now` to verify the threaded layout renders well with multiple responders
- [ ] **Add all team members to the `Heubot Standups` space** so they can see the digest (not just the bot)
- [ ] **Register `/standup` in the Chat API as both DM and Space available** (same as other commands)
- [ ] **Verify `STANDUP_SPACE_ID`** is set to the real team space (`/settings` should show a real space ID, not `spaces/REPLACE_ME`)
- [ ] **Confirm schedule times** are what you want: `PROMPT_TIME` (default 16:45), `REMINDER_TIME` (17:15), `DIGEST_TIME` (09:00 next workday)
- [ ] **Run `testBotAuth`** one last time from the production deployment to confirm everything still works

---

## 🟢 Nice-to-have (can wait)

Items that would make the bot better but aren't required for a working rollout. Tackle when you have time.

### Features

- [ ] **`/hello` or `/ping` slash command** — dedicated onboarding command for new members. Does nothing but capture `chat_user_id` and show a welcome message. Easier to instruct than "run any slash command"
- [ ] **Late submission tracking** — DailyBot tracks which responses came in after the prompt-to-digest window. Nice data for managers
- [ ] **Holiday calendar awareness** — currently only skips Sat/Sun. Holidays (Dashain, national holidays) still trigger empty digests
- [ ] **Hard delete for GDPR** — current `removeTeamMember` is a soft delete. Add `hardDeleteTeamMember` if privacy rights become relevant
- [ ] **`/help` command** — lists available slash commands per role
- [ ] **Optional standup questions** — let members submit partially (some questions blank) more gracefully than current "required" checking
- [ ] **Per-user time zone support** — currently everyone's in `Asia/Kathmandu`. If the team is distributed, each member's prompt time should respect their local time
- [ ] **Submission "edit history"** — if someone edits their standup multiple times, track each version
- [ ] **Reactions / comments on digest replies** — let team members ❤️ each other's updates

### Code quality

- [ ] **V8 modernization** — current code is ES5 style (`var`, `function()`, no arrow functions, no template literals, no destructuring). Modernize when touching files
- [ ] **Structured logging** — replace `Logger.log('string')` with `console.log({...})` for structured JSON that Stackdriver can filter
- [ ] **Unit tests** — Apps Script has no native test runner, but `QUnitGS2` or similar can work. Low priority for a small project
- [ ] **CI/CD** — GitHub Actions that run `clasp push` on merge to main. Not critical for solo development, worth it if multiple contributors
- [ ] **Stronger typing via clasp TypeScript support** — clasp can transpile `.ts` to `.gs` on push. Significant refactor

### Operations

- [ ] **Error notifications to admins** — when cron jobs fail, DM admins so they know to investigate. Currently you'd only see failures in the Executions log
- [ ] **Daily synthetic monitor** — a `testEndToEnd` function that runs on a separate trigger, submits a test standup as a test user, verifies it lands in the digest, and alerts on failure
- [ ] **Usage metrics dashboard** — how many people submit per day, average submission time, % edited after first submit, etc.
- [ ] **Automated database backups** — Supabase has built-in backups, but you may want explicit export of `standup_responses` to a separate backup for DR
- [ ] **Credential rotation runbook** — document the exact steps to rotate Supabase keys, Jira tokens, and the service account JSON

### UX polish

- [ ] **Status chip widgets for Jira tickets** — instead of `⚪ CRM-629 ...`, use Chat's `chipList` widget with color-coded chips per status
- [ ] **Per-person avatars in digest reply cards** — fetch from Google People API, show real photos instead of the generic account_circle icon
- [ ] **Compact summary row at top of digest** — "5 of 7 responded · 12 active Jira tickets" as a single highlighted widget
- [ ] **Non-responders collapsed by default** — small visual de-emphasis for the "no response" list
- [ ] **Dark mode testing** — verify cards render well in Chat's dark mode
- [ ] **Mobile screen testing** — verify cards look acceptable on small screens (columns collapse, truncation, etc.)

---

## Rollout plan (suggested)

### Day 1: Production setup
- Run through every item in **🔴 Blockers**
- Keep the test deployment installed for yourself as a debugging option
- Total time: ~30-45 minutes

### Day 2: Pilot with 2-3 colleagues
- Add 2-3 trusted teammates to `team_members` and send onboarding instructions
- Let the 16:45 cron fire naturally
- Verify everyone receives the notification
- Have them submit their standup
- Verify 17:15 reminder fires for anyone who didn't submit
- Verify 09:00 digest posts to the team space
- Monitor Executions log for any failures

### Day 3: Iterate
- Fix any bugs or polish items that surfaced
- Get pilot feedback on the form UX, digest format, notification timing

### Day 4-5: Full rollout
- Add the remaining team members to `team_members`
- Send the onboarding instructions
- Monitor for the first few days
- Be ready to manually run `/notify-all` or `/digest-now` if cron fails unexpectedly

### Week 2+: Steady state
- Work through **🟡 Should do** items as time allows
- Pick **🟢 Nice-to-have** items based on actual feedback

---

## Out of scope (explicitly not doing)

For clarity on what this bot does NOT do and won't do without a separate decision:

- ❌ **Automatic question rotation** — every day uses the same questions. No random or context-aware question selection
- ❌ **Cross-team standups** — all members share one question set, one prompt time, one digest space. No per-team configuration
- ❌ **Integration with other tools** — Slack, Microsoft Teams, Confluence, Notion — not on the roadmap
- ❌ **AI-generated summaries** — no LLM post-processing of standup content
- ❌ **Public distribution** — this is an internal Heubert tool, not a product. `OAuth consent screen` is set to Internal
- ❌ **External users** — only `heubert.com` domain users can access the bot
- ❌ **Multiple standups per day** — bot assumes one standup cycle per weekday
