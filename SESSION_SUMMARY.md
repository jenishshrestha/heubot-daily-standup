# Session Summary — April 11, 2026

Context for resuming Heubot work tomorrow or from another device.

---

## What got built today

Started the day with a half-working Chat bot stub where button clicks crashed with "Heubot is unable to process your request." Ended with a fully functional async standup bot on service-account auth.

**Major changes in order:**

1. **Fixed button click envelopes** — Dialog buttons were using `createMessageAction`, needed `renderActions.navigations.pushCard`. Then discovered handlers are dispatched directly (not via `onCardClick`), moved wrappers into each handler.
2. **Fixed schedule save** — Added missing `https://www.googleapis.com/auth/script.scriptapp` OAuth scope for `ScriptApp.getProjectTriggers`.
3. **Fixed trigger quota issues** — `deleteTriggers` now scoped to our own handler functions by name so repeated saves don't accumulate orphans.
4. **Workflow refactor (meeting-date storage)** — Submissions now keyed by the upcoming meeting date, not submission date. Friday submits land in Monday's digest.
5. **Idempotency** — Two layers: `CacheService` retry dedupe + `upsertStandupResponse` DB-level upsert on `(date, email)`.
6. **Retry-with-backoff** — Wrapped `supabaseRequest` with 3-attempt exponential backoff for transient failures.
7. **Set up clasp + bun + git** — Local development with `bun run push`, initial commit, pushed to `github.com/jenishshrestha/heubot-daily-standup`.
8. **Service-account bot identity** — The biggest architectural change. Apps Script `Chat.Spaces.*` calls run as the calling user, and Google Chat rejects card messages from human-credentialed callers. Created GCP service account `heubot-bot@heubot.iam.gserviceaccount.com`, downloaded JSON key, wrote `Bot.gs` that mints OAuth tokens via JWT bearer flow and calls `chat.googleapis.com` directly with bot credentials.
9. **`chat_user_id` capture** — Service-account Chat API calls don't accept email-style user IDs, they need numeric `users/117260094786438825675` form. Added `chat_user_id` column to `team_members` and a `captureChatUserId` helper that reads `event.user.name` and upserts on every interaction.
10. **Notification card pattern** — 16:45 cron and `/notify-all` now send a small notification card with a "Fill Standup" button instead of pushing the full form directly. Form opens on demand via the button or via `/standup`.
11. **Edit mode** — Re-opening the form after a prior submission pre-fills the saved answers; button becomes "Update Standup".
12. **`/notify-all` caller merge** — Skips sending to the caller, returns the notification card AS the slash command response (avoids duplicate message + out-of-order confusion).
13. **In-place card updates** — Every terminal admin action (Save, Add, Remove, Submit) uses `updateMessageAction` so dialogs transform into results in place.
14. **Renamed `/trigger-now` → `/notify-all`**, `handleTriggerNow` → `handleNotifyAll`, `sendStandupCards` → `sendStandupNotifications`.
15. **Added `/digest-now`, `/set-this-space`, `/standup`** slash commands.
16. **Threaded digest (DailyBot pattern)** — `postDigest` now posts a small summary card + each response as a thread reply under it. Channel stays clean.
17. **Clickable Jira links** in digest reply cards.
18. **Full setup README** with Mermaid architecture diagram. Merged to `main` on GitHub.

---

## Current state — what's tested and working

| Flow | Status |
|---|---|
| Service-account auth (`testBotAuth`) | ✅ Passed |
| `/notify-all` → notification card in DM | ✅ Working |
| Fill Standup button → form opens in place | ✅ Working |
| Submit → confirmation in place | ✅ Working |
| Re-open submitted standup → edit mode with pre-filled answers | ✅ Working |
| Update → row updated in DB, no duplicates | ✅ Working |
| `/set-this-space` captures space name from event | ✅ Working |
| `/digest-now 2026-04-13` posts summary + thread reply | ✅ Working |
| Clickable Jira ticket links in digest | ✅ Pushed, not yet re-verified |
| Admin flows: `/settings`, `/team`, `/questions`, `/set-schedule` | ✅ Working |
| Two-layer idempotency | ✅ Working |

## What's NOT tested yet

- **Multi-user digest** — only 1 response in the DB so far. Need 2+ submissions to validate the threaded layout with multiple people.
- **`/standup` slash command** — needs GCP Console registration (commandId 11). Handler code is written and works when invoked via `onMessage`, just untested via actual slash command path.
- **Cron triggers firing** — `createTriggers` was blocked by the creation-rate quota today. Needs to be run tomorrow from the Apps Script editor once the quota resets.
- **17:15 reminders** — `sendReminders` never fired. Same code path as `sendStandupNotifications` so should work, but unverified.
- **Production deployment** — still on test deployment. Only jenish can use the bot right now.
- **Real team member onboarding** — no one else is in `team_members`.

---

## Critical gotchas to remember

1. **Service-account auth DOES NOT support email user IDs.** Must use `users/<numeric-id>` form. Capture via `event.user.name` → stored in `team_members.chat_user_id`.
2. **Cards from human-credentialed callers are rejected** with "Message cannot have cards for requests carrying human credentials". Everything autonomous goes through `Bot.gs → botMessageCreate`.
3. **GCP Console slash commands need TWO saves:** the inner popup save AND the outer page save at the bottom. If you only click the inner one, nothing persists.
4. **Trigger creation has a rolling daily quota** (~20/day per user per add-on), distinct from the 20-active-trigger cap. Don't spam `/set-schedule` — each save tries to recreate triggers.
5. **`findDirectMessage(self)` fails.** Calling user can't DM themselves. The `/notify-all` handler skips the caller and returns the notification card as the slash command response.
6. **The JSON service account key** is still at `/Users/jenishshrestha/Projects/work/heubot-standup/heubot-0ccc63fb5088.json`. **MOVE IT** to a password manager or `~/Documents/secrets/` before end of day. Bot already reads from Script Properties, so removal is safe.

---

## Must-do rollout checklist

In order:

1. **Run `createTriggers`** from Apps Script editor (after ~24h quota reset). Installs the 4 cron triggers.
2. **Register `/standup` in GCP Console** as commandId 11 (name `/standup`, type Slash command, "Opens a dialog" unchecked).
3. **Create a production deployment**: Apps Script → Deploy → New deployment → Add-on → copy Deployment ID → paste into GCP Console → Chat API → Configuration → Connection settings. Set visibility to "all people in heubert.com" or specific groups.
4. **Add team members**: `INSERT INTO team_members (name, email, active) VALUES (...)` for each person.
5. **Add admins**: `INSERT INTO admins (email) VALUES (...)` for anyone who should run admin slash commands.
6. **Send onboarding message** to each member:
   > Open Google Chat → Apps → find Heubot → run `/standup` once to register yourself. That's all the setup you need.
7. **Move the service account JSON key** out of the project folder.

## Should-do before rollout

- Customize standup questions (defaults: accomplish today / work on tomorrow / blockers)
- Upload bot avatar in GCP Console → Chat API → Configuration (`logo.png` in repo)
- Pilot with 2-3 trusted colleagues first, not the whole team on day 1
- Add all team members to the Heubot Standups space (not just the bot)

## Can-wait items

- Error notifications to admins when cron fails
- Holiday calendar awareness (currently only skips Sat/Sun)
- Late submission tracking (DailyBot differentiates)
- Hard delete for GDPR
- V8 modernization (code is still ES5)
- Monitoring / metrics

---

## Key commands

```bash
# From project root
cd /Users/jenishshrestha/Projects/work/heubot-standup

# Local dev loop
bun run push           # push to Apps Script
bun run status         # check what would be pushed
bun run logs           # tail execution logs (if needed)

# Git
git status
git pull
git log --oneline -20

# On a fresh machine (first-time setup)
bun install            # installs clasp
bunx clasp login       # browser OAuth
# Then create .clasp.json with the scriptId (see README)
# Then: bun run push
```

## Apps Script editor — useful functions to run manually

| Function | Purpose |
|---|---|
| `testBotAuth` | Smoke test: mints a bot token, finds existing DM. Fastest way to verify Bot.gs works. |
| `createTriggers` | Installs the 4 daily cron triggers from current settings. |
| `dumpAllTriggers` | Logs all currently installed triggers. |
| `deleteAllTriggersHard` | Wipes every trigger on the project. One-shot cleanup. |
| `postDigest('2026-04-13')` | Manually post the digest for a specific date. |

## Script Properties (already set)

- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_KEY` — Supabase service_role key
- `JIRA_EMAIL` — Jira account email
- `JIRA_API_TOKEN` — Jira API token
- `SERVICE_ACCOUNT_KEY` — Full JSON contents of `heubot-0ccc63fb5088.json`

---

## Git state

- Remote: `github.com/jenishshrestha/heubot-daily-standup`
- Default branch: `main`
- `feat/bot-implementation` merged to main via GitHub PR
- Key commits (most recent first):
  - `docs: replace ASCII architecture diagram with mermaid`
  - `docs: add comprehensive setup README`
  - `feat: full bot implementation — service-account auth, /standup, threaded digest`
  - `tooling: stop clasp from traversing node_modules and .git`
  - `Initial import: Heubot standup bot`

## Key file layout

```
heubot-standup/
├── appsscript.json       # Manifest: OAuth scopes, advanced services
├── Code.gs               # Entry points, date helpers, workflow
├── Admin.gs              # Slash command handlers
├── Card.gs               # Cards v2 builders
├── Bot.gs                # Service-account JWT + Chat REST (NEW)
├── Database.gs           # Supabase REST + retries
├── Jira.gs               # Jira ticket fetch
├── README.md             # Full setup docs
├── SESSION_SUMMARY.md    # This file
├── package.json          # bun / clasp scripts
├── .gitignore
├── .claspignore
├── .clasp.json           # gitignored — contains scriptId
├── heubot-0ccc63fb5088.json   # gitignored — MOVE BEFORE EOD
└── node_modules/
```

---

## Supabase schema reference

```sql
team_members (
  id, name, email UNIQUE, jira_username, chat_user_id, active, created_at
)
standup_responses (
  id, date, name, email, answers JSONB, jira_tickets JSONB, responded_at,
  UNIQUE (date, email)
)
settings (key PRIMARY, value, updated_at)
questions (id, sort_order, question, required, created_at)
admins (email PRIMARY, created_at)
```

Settings currently in the DB:

- `PROMPT_TIME = 16:45`
- `REMINDER_TIME = 17:15`
- `DIGEST_TIME = 09:00` (changed from `17:30` earlier today)
- `TIMEZONE = Asia/Kathmandu`
- `STANDUP_SPACE_ID = spaces/AAQAYxN4n3A` (Heubot Standups space)
- `JIRA_DOMAIN = heubert.atlassian.net`
- `JIRA_PROJECT = HEU` (or whatever it is)

---

## How to resume tomorrow

1. `cd /Users/jenishshrestha/Projects/work/heubot-standup`
2. `git pull` (in case anything changed on GitHub)
3. Open Apps Script editor → Executions tab
4. Run `createTriggers` — should succeed now that the creation quota has reset
5. Verify triggers installed via the Triggers tab
6. Optional: run `testBotAuth` to confirm nothing broke overnight
7. Pick up from the Must-do rollout checklist above

If you want to keep iterating on code instead of rolling out, just edit in VS Code → `bun run push` → test in Chat.

## How to resume from a different device

1. `git clone git@github.com:jenishshrestha/heubot-daily-standup.git`
2. `cd heubot-daily-standup`
3. `bun install`
4. `bunx clasp login` (browser OAuth — use the same Google account)
5. Create `.clasp.json` with the script ID:
   ```json
   {"scriptId":"14qUQXBvMSYxoNeqg1ixfk0hepIFm1ljzhSiLoDDLzrt2d1gebkq3qllM","rootDir":"."}
   ```
6. `bun run status` to verify the link works
7. You're ready to `bun run push`

**Note:** the service account JSON key is NOT in the repo (gitignored). If you need to set up the bot on a new environment you'd re-download it from GCP Console → IAM & Admin → Service Accounts → heubot-bot → Keys. But for just *editing* code, you don't need the key file — it lives in Apps Script Script Properties already.
