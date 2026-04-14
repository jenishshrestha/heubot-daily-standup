/**
 * Code.gs — Main entry points for Heubot
 *
 * Handles:
 * - sendStandupNotifications() — DM small notification card to each member
 * - onCardClick(event)   — Route card button clicks
 * - onMessage(event)     — Route slash commands (delegates to Admin.gs)
 * - sendReminders()      — Remind non-responders
 * - postDigest()         — Post daily digest to team space
 * - createTriggers()     — Set up time-based triggers from settings
 * - checkDbUsage()       — Monthly DB usage check
 */

// ---------------------------------------------------------------------------
// Helper: Get today's date string in configured timezone
// ---------------------------------------------------------------------------

function getTodayDate() {
  var tz = getSetting('TIMEZONE') || 'Asia/Kathmandu';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

function getTodayDateLabel() {
  var tz = getSetting('TIMEZONE') || 'Asia/Kathmandu';
  return Utilities.formatDate(new Date(), tz, 'MMMM d, yyyy');
}

// ---------------------------------------------------------------------------
// Workday-aware date helpers
//
// All standups operate on a Mon-Fri cycle. Submissions made on Friday land
// in Monday's digest, not Saturday's. These helpers centralize that rule
// so the rest of the codebase doesn't have to think about weekends.
// ---------------------------------------------------------------------------

/**
 * Returns YYYY-MM-DD for the next workday (Mon-Fri), in the configured TZ.
 * If today is Mon-Thu, returns tomorrow. If Fri/Sat/Sun, returns next Monday.
 */
function getNextWorkdayDate() {
  var tz = getSetting('TIMEZONE') || 'Asia/Kathmandu';
  var d = new Date();
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

/**
 * Returns "Monday, January 13, 2026" style label for the next workday.
 * Used as the date shown on the standup form card so Friday cards say
 * "Monday" instead of "Saturday".
 */
function getNextWorkdayLabel() {
  var tz = getSetting('TIMEZONE') || 'Asia/Kathmandu';
  var d = new Date();
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return Utilities.formatDate(d, tz, 'EEEE, MMMM d, yyyy');
}

/**
 * Picks which standup date is "active" right now. Used by `/status` and
 * `/standup` to default to a sensible meeting date when none is given.
 *
 *   weekend                       → next Monday's meeting
 *   weekday before DIGEST_TIME    → today's meeting (still happening this morning)
 *   weekday at/after DIGEST_TIME  → next workday's meeting (today's meeting is over)
 *
 * The DIGEST_TIME cutoff is read from settings on every call so admins
 * can change it via `/set-schedule` without redeploying. The transition
 * happens at the moment the digest goes public — before that, "today's
 * meeting" is still the active one; after that, attention shifts to
 * tomorrow's meeting.
 */
function getActiveStandupDate() {
  var now = new Date();
  var day = now.getDay();

  if (day === 0 || day === 6) {
    return getNextWorkdayDate();
  }

  var tz = getSetting('TIMEZONE') || 'Asia/Kathmandu';
  var digestTime = getSetting('DIGEST_TIME') || '09:00';
  var nowHHmm = Utilities.formatDate(now, tz, 'HH:mm');

  if (nowHHmm < digestTime) {
    return getTodayDate();
  }
  return getNextWorkdayDate();
}

/**
 * Format a YYYY-MM-DD date string as "Monday, January 13, 2026" for display.
 * Lets handlers turn a stored standup date into a human label.
 */
function formatStandupDateLabel(dateStr) {
  var tz = getSetting('TIMEZONE') || 'Asia/Kathmandu';
  // Parse YYYY-MM-DD as a local date (avoid UTC midnight gotcha).
  var parts = dateStr.split('-');
  var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  return Utilities.formatDate(d, tz, 'EEEE, MMMM d, yyyy');
}

// ---------------------------------------------------------------------------
// Send Standup Cards (triggered at PROMPT_TIME, Mon-Fri)
// ---------------------------------------------------------------------------

/**
 * Sends standup notification cards via DM to all active team members.
 *
 * Skips weekends by default — admins generally don't want the bot
 * spamming people at 4:45 PM on a Saturday. Manual `/notify-all`
 * invocations pass `skipWeekendCheck = true` to override.
 *
 * Optionally skips a single member by email (`excludeEmail`). Used by
 * `handleNotifyAll` to avoid sending the caller a duplicate notification
 * — the caller already sees the notification card as the slash command's
 * response, so they don't need a second copy via API.
 *
 * Uses `botMessageCreate` (service-account auth) for the actual send,
 * so this works from time-based triggers and from manual slash commands
 * alike — both run as the bot, not as the caller.
 *
 * @param {boolean} [skipWeekendCheck=false]
 * @param {string}  [excludeEmail]  - team_member email to skip
 * @returns {{ skipped: string|null, sent: number, failed: number, total: number }}
 */
function sendStandupNotifications(skipWeekendCheck, excludeEmail) {
  // Time-based triggers pass an event object as the first arg. Coerce
  // anything that isn't a real boolean to false so the cron behaves like
  // a real cron (respects the weekend skip). Manual /notify-all callers
  // explicitly pass `true`.
  if (skipWeekendCheck !== true) {
    skipWeekendCheck = false;
  }
  if (typeof excludeEmail !== 'string') {
    excludeEmail = null;
  }

  if (!skipWeekendCheck) {
    var day = new Date().getDay();
    if (day === 0 || day === 6) {
      Logger.log('Skipping standup — weekend');
      return { skipped: 'weekend', sent: 0, failed: 0, total: 0 };
    }
  }

  var members = getActiveTeamMembers();
  var questions = getQuestions();

  if (members.length === 0) {
    Logger.log('No active team members found');
    return { skipped: 'no-members', sent: 0, failed: 0, total: 0 };
  }

  if (questions.length === 0) {
    Logger.log('No questions configured');
    return { skipped: 'no-questions', sent: 0, failed: 0, total: 0 };
  }

  var dateLabel = getNextWorkdayLabel();
  var standupDate = getNextWorkdayDate();
  // The cron and /notify-all both send the small notification card
  // (not the full form). The full form is opened on demand by each
  // member via /standup or by clicking the "Fill Standup" button.
  var card = buildStandupNotificationCard(dateLabel, standupDate);

  var successCount = 0;
  var failCount = 0;

  var skippedCaller = false;
  members.forEach(function(member) {
    if (excludeEmail && member.email === excludeEmail) {
      skippedCaller = true;
      return;
    }
    if (!member.chat_user_id) {
      Logger.log('Skipping ' + member.name + ' (' + member.email + '): no chat_user_id captured yet — they need to interact with the bot first');
      failCount++;
      return;
    }
    try {
      var dmSpace = getOrCreateDmSpace(member.chat_user_id);
      botMessageCreate(card, dmSpace);
      successCount++;
    } catch (e) {
      Logger.log('Failed to DM ' + member.email + ': ' + e.message);
      failCount++;
    }
  });

  Logger.log('Standup notifications sent: ' + successCount + ' success, ' + failCount + ' failed'
    + (skippedCaller ? ' (caller excluded)' : ''));
  // `total` reflects the number of members the function actually tried
  // to notify, so callers can build accurate "X of Y" messages.
  var attempted = members.length - (skippedCaller ? 1 : 0);
  return { skipped: null, sent: successCount, failed: failCount, total: attempted };
}

// ---------------------------------------------------------------------------
// Card Click Handler
// ---------------------------------------------------------------------------

/**
 * Fallback card-click dispatcher.
 *
 * In Google Chat add-ons, button `action.function` values are dispatched
 * directly to the named top-level function — this central handler is not
 * invoked by the framework under normal conditions. It is kept as a safety
 * net in case an event ever arrives with a different shape.
 *
 * Each delegated handler already wraps its own response in the correct
 * envelope (createNavResponse / createCardResponse), so this dispatcher
 * must pass results through unchanged to avoid double-wrapping.
 */
function onCardClick(event) {
  Logger.log('onCardClick fallback invoked: ' + JSON.stringify(event));

  captureChatUserId(event);

  var common = event.commonEventObject || event.common || {};
  var action = common.invokedFunction;
  var chatEvent = event.chat || event;
  var user = chatEvent.user || event.user;

  event.user = user;
  event.common = common;
  event.common.formInputs = common.formInputs || {};

  switch (action) {
    case 'handleStandupSubmit':          return handleStandupSubmit(event);
    case 'handleShowStandupForm':        return handleShowStandupForm(event);
    case 'handleShowScheduleDialog':     return handleShowScheduleDialog(event);
    case 'handleSaveSchedule':           return handleSaveSchedule(event);
    case 'handleShowQuestions':          return handleShowQuestions(event);
    case 'handleRemoveQuestion':         return handleRemoveQuestion(event);
    case 'handleShowAddQuestionDialog':  return handleShowAddQuestionDialog(event);
    case 'handleAddQuestion':            return handleAddQuestion(event);
    case 'handleShowTeam':               return handleShowTeam(event);
    case 'handleRemoveMember':           return handleRemoveMember(event);
    case 'handleActivateMember':         return handleActivateMember(event);
    case 'handleShowAddMemberDialog':    return handleShowAddMemberDialog(event);
    case 'handleAddMember':              return handleAddMember(event);
    case 'handleShowPurgeDialog':        return handleShowPurgeDialog(event);
    case 'handlePurge':                  return handlePurge(event);
    default:                             return createNavResponse(buildTextCard('Error', 'Unknown action: ' + action));
  }
}

// ---------------------------------------------------------------------------
// Event-shape helpers (shared by every button handler)
// ---------------------------------------------------------------------------

/**
 * Returns form inputs from an event, regardless of whether the framework
 * delivered them under commonEventObject (add-on) or common (legacy).
 */
function getFormInputs(event) {
  var common = event.commonEventObject || event.common || {};
  return common.formInputs || {};
}

/**
 * Captures the calling user's canonical Chat resource name from the
 * event and persists it to their team_members row. Idempotent and
 * cached, so it costs at most one Supabase write per user per 6 hours.
 *
 * Bot-credentialed Chat API calls require numeric user IDs (not
 * emails). The numeric ID lives in `event.user.name` on every
 * incoming event but isn't stored anywhere we can use later — this
 * helper grabs it the first time a user interacts with the bot and
 * makes it available for autonomous DM sends going forward.
 */
function captureChatUserId(event) {
  var chatEvent = event.chat || event;
  var user = chatEvent.user || event.user;
  if (!user || !user.email || !user.name) return;

  var cache = CacheService.getScriptCache();
  var cacheKey = 'cuid:' + user.email;
  if (cache.get(cacheKey) === user.name) return;

  try {
    updateMemberChatUserId(user.email, user.name);
    cache.put(cacheKey, user.name, 21600);
    Logger.log('Captured chat_user_id for ' + user.email + ': ' + user.name);
  } catch (e) {
    Logger.log('Failed to capture chat_user_id for ' + user.email + ': ' + e.message);
  }
}

/**
 * Returns action parameters from an event as a plain map. The framework
 * delivers parameters as either a key/value map or as an array of
 * {key, value} pairs depending on context — normalize to a map.
 */
function getParams(event) {
  var common = event.commonEventObject || event.common || {};
  var raw = common.parameters || {};

  if (Array.isArray(raw)) {
    var out = {};
    raw.forEach(function(p) {
      out[p.key] = p.value;
    });
    return out;
  }
  return raw;
}

/**
 * Reads a string value from a single form input, tolerating the multiple
 * shapes Google Chat uses. Returns '' when the input is missing so the
 * handler can fall through to its own validation instead of crashing on
 * a property access.
 */
function readStringInput(formInputs, name) {
  var input = formInputs && formInputs[name];
  if (!input) return '';

  if (input.stringInputs && input.stringInputs.value && input.stringInputs.value.length > 0) {
    return input.stringInputs.value[0];
  }
  if (typeof input.value === 'string') {
    return input.value;
  }
  if (Array.isArray(input.value) && input.value.length > 0) {
    return input.value[0];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Message Handler (Slash Commands)
// ---------------------------------------------------------------------------

/**
 * Google Chat event handler for messages (slash commands).
 * @param {Object} event - Google Chat event
 * @returns {Object} Response card
 */
function onMessage(event) {
  // Capture caller's chat_user_id on every interaction so autonomous
  // sends (cron prompts, reminders) can find their DM later. No-op if
  // already captured for this user within the cache window.
  captureChatUserId(event);

  // Add-on format: event data is nested under event.chat
  var chatEvent = event.chat || event;

  // Extract message — different location for slash commands vs regular messages
  var message = null;
  if (chatEvent.appCommandPayload && chatEvent.appCommandPayload.message) {
    message = chatEvent.appCommandPayload.message;
  } else if (chatEvent.messagePayload && chatEvent.messagePayload.message) {
    message = chatEvent.messagePayload.message;
  } else {
    message = event.message;
  }

  var user = chatEvent.user || event.user;

  // Normalize event for downstream handlers
  event.user = user;
  event.message = message;

  // Handle slash commands
  if (message && message.slashCommand) {
    return routeSlashCommand(event);
  }

  // Check for an active conversational standup session (DMs only).
  // If the user is in the middle of answering questions, route their
  // text message to the session handler instead of the default response.
  var space = getEventSpace(event);
  var isDm = space && (space.singleUserBotDm || space.type === 'DIRECT_MESSAGE' || space.type === 'DM');

  if (isDm && user && user.email) {
    var session = getStandupSession(user.email);
    if (session) {
      return handleStandupAnswer(event, session);
    }
  }

  // Default response for non-command messages
  return createTextResponse("Hi! I'm Heubot, your standup assistant. Use slash commands to interact with me.");
}

/**
 * Wraps a text string in the correct Chat app response format.
 */
function createTextResponse(text) {
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: {
            text: text
          }
        }
      }
    }
  };
}

/**
 * Wraps a card in the correct Chat add-on response format.
 */
function createCardResponse(card) {
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: card
        }
      }
    }
  };
}

/**
 * Wraps a card for a button-click response that should appear as a NEW
 * message in the conversation. Used by the "show dialog" / "open list"
 * handlers — they post the dialog or list as a fresh card below the
 * triggering message, leaving the original (e.g. /settings) intact.
 */
function createNavResponse(cardResult) {
  return createCardResponse(cardResult);
}

/**
 * Wraps a card for a button-click response that should REPLACE the
 * message containing the clicked button. Used by terminal actions
 * (Save, Add, Remove, Activate, Purge) so a dialog transforms into its
 * confirmation in place — no stacked card residue.
 *
 * Caveats: only works on messages this bot created, and Google has a
 * soft age limit on edits (minutes-to-hours). For interactive flows
 * where the user clicks Save shortly after opening the dialog, this is
 * never a problem.
 */
function createUpdateResponse(cardResult) {
  return {
    hostAppDataAction: {
      chatDataAction: {
        updateMessageAction: {
          message: cardResult
        }
      }
    }
  };
}

/**
 * Extracts the Chat space from an event, regardless of which payload
 * shape Google delivers it in. Returns null if no space is found.
 */
function getEventSpace(event) {
  var chatEvent = event.chat || event;
  if (chatEvent.appCommandPayload && chatEvent.appCommandPayload.space) {
    return chatEvent.appCommandPayload.space;
  }
  if (chatEvent.messagePayload && chatEvent.messagePayload.space) {
    return chatEvent.messagePayload.space;
  }
  if (event.message && event.message.space) {
    return event.message.space;
  }
  if (event.space) {
    return event.space;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Standup Submit Handler
// ---------------------------------------------------------------------------

/**
 * Handles standup form submission.
 * Stores response in DB, fetches Jira tickets.
 * @param {Object} event - Google Chat event
 * @returns {Object} Confirmation card
 */
function handleStandupSubmit(event) {
  Logger.log('handleStandupSubmit invoked');

  captureChatUserId(event);

  var chatEvent = event.chat || event;
  var user = chatEvent.user || event.user;
  var formInputs = getFormInputs(event);
  var params = getParams(event);

  // ---- Idempotency layer 1: short-window retry dedupe via CacheService ----
  // Google Chat retries failed/slow card interactions within ~30s with the
  // same eventTime. Returning the cached response on a duplicate hit means
  // we never re-do the Jira fetch, the DB write, or any side effect.
  var eventTime = String(event.eventTime || (chatEvent && chatEvent.eventTime) || '');
  var cacheKey = 'submit:' + (user && user.email) + ':' + eventTime;
  var cache = CacheService.getScriptCache();
  var cached = eventTime ? cache.get(cacheKey) : null;
  if (cached) {
    Logger.log('handleStandupSubmit: cache hit for ' + cacheKey + ' — returning prior response');
    return JSON.parse(cached);
  }

  var members = getActiveTeamMembers();
  var member = null;
  for (var i = 0; i < members.length; i++) {
    if (members[i].email === user.email) {
      member = members[i];
      break;
    }
  }

  if (!member) {
    return createUpdateResponse(buildTextCard('Error', 'You are not registered as a team member. Contact an admin.'));
  }

  var answers = {};
  var questionIds = params.questionIds ? String(params.questionIds).split(',') : [];

  questionIds.forEach(function(qId) {
    var inputKey = 'question_' + qId;
    if (formInputs[inputKey] && formInputs[inputKey].stringInputs) {
      answers[inputKey] = formInputs[inputKey].stringInputs.value[0];
    }
  });

  var jiraTickets = [];
  try {
    jiraTickets = fetchJiraTickets(member.email);
  } catch (e) {
    Logger.log('Jira fetch failed for ' + member.email + ': ' + e.message);
    if (e.message && e.message.indexOf('401') > -1) {
      notifyAdminsJiraExpired();
    }
  }

  // ---- Idempotency layer 2: DB upsert keyed on (meetingDate, email) ----
  // Survives cache eviction, cold starts, and accidental double-clicks
  // hours apart. One row per user per meeting, no matter what.
  //
  // Storage key is the MEETING DATE the form was filled out for. The
  // form embeds this in its Submit button params (so /standup 2026-04-13
  // upserts to that date, not "now"). Falls back to next workday if the
  // param is missing for some reason.
  var meetingDate = (params.standupDate && /^\d{4}-\d{2}-\d{2}$/.test(params.standupDate))
    ? params.standupDate
    : getNextWorkdayDate();
  upsertStandupResponse(meetingDate, member.name, member.email, answers, jiraTickets);

  Logger.log('Standup recorded for ' + member.name);
  var response = createUpdateResponse(buildConfirmationCard(member.name));

  if (eventTime) {
    cache.put(cacheKey, JSON.stringify(response), 600);
  }

  return response;
}

// ---------------------------------------------------------------------------
// Open the Standup Form (button click + slash command shared backend)
// ---------------------------------------------------------------------------

/**
 * Resolves a meeting date string from various sources, applying these
 * rules in order:
 *
 *   1. If `requestedDate` is provided and parses as a valid YYYY-MM-DD
 *      (or YYYY/MM/DD) AND it's today or in the future → use it.
 *   2. If `requestedDate` is provided but invalid or in the past →
 *      throw, with a message the caller can show to the user.
 *   3. Otherwise → fall back to `getActiveStandupDate()`.
 *
 * @param {string} [requestedDate]
 * @returns {string} YYYY-MM-DD
 */
function resolveStandupDate(requestedDate) {
  if (!requestedDate) {
    return getActiveStandupDate();
  }

  var match = String(requestedDate).match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})$/);
  if (!match) {
    throw new Error('Invalid date "' + requestedDate + '". Use YYYY-MM-DD or YYYY/MM/DD.');
  }
  var normalized = match[1] + '-' + match[2] + '-' + match[3];

  // Verify the date is real (e.g. reject 2026-02-31).
  var parsed = new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10));
  if (parsed.getFullYear() !== parseInt(match[1], 10)
      || parsed.getMonth() !== parseInt(match[2], 10) - 1
      || parsed.getDate() !== parseInt(match[3], 10)) {
    throw new Error('Invalid date "' + requestedDate + '" — not a real calendar date.');
  }

  // Reject past dates. "Today" is allowed because backfill for the
  // morning's meeting is sometimes legitimate (e.g. you got pulled into
  // a meeting before you could fill it).
  if (normalized < getTodayDate()) {
    throw new Error('Cannot fill a standup for a past date (' + normalized + '). Only today and future dates are allowed.');
  }

  return normalized;
}

/**
 * Shared logic for starting a conversational standup session. Used by
 * both `/standup` (slash command) and the "Fill Standup" button on
 * the notification card.
 *
 * Returns { introText } on success, or { error } if something's wrong.
 *
 * @param {string} email          - Caller's email
 * @param {string} [requestedDate] - Optional explicit date (YYYY-MM-DD)
 * @returns {{ introText: string } | { error: string }}
 */
function beginStandupConversation(email, requestedDate) {
  var standupDate;
  try {
    standupDate = resolveStandupDate(requestedDate);
  } catch (e) {
    return { error: e.message };
  }

  var questions = getQuestions();
  if (questions.length === 0) {
    return { error: 'No standup questions are configured. Ask an admin to add some via /add-question.' };
  }

  var members = getActiveTeamMembers();
  var member = null;
  for (var i = 0; i < members.length; i++) {
    if (members[i].email === email) {
      member = members[i];
      break;
    }
  }
  if (!member) {
    return { error: 'You are not registered as a team member. Contact an admin.' };
  }

  var existingAnswers = null;
  var existing = getStandupResponse(standupDate, email);
  if (existing && existing.answers) {
    existingAnswers = existing.answers;
  }

  var session = startStandupSession(email, standupDate, questions, member.name, existingAnswers);
  return { introText: buildSessionIntro(session) };
}

/**
 * Button-click handler for the "Fill Standup" button on the daily
 * notification card. Starts a conversational session (same as /standup)
 * and replaces the notification card with the intro message + Q1.
 *
 * The card form is still available as a fallback via /standup --form.
 */
function handleShowStandupForm(event) {
  Logger.log('handleShowStandupForm invoked');

  captureChatUserId(event);

  var chatEvent = event.chat || event;
  var user = chatEvent.user || event.user;
  var callerEmail = (user && user.email) || null;

  var params = getParams(event);
  var requestedDate = params.standupDate || null;

  var result = beginStandupConversation(callerEmail, requestedDate);

  if (result.error) {
    return createUpdateResponse(buildTextCard('Error', result.error));
  }

  // Replace the notification card with the session intro text.
  // The conversation continues as plain text messages from here.
  return {
    hostAppDataAction: {
      chatDataAction: {
        updateMessageAction: {
          message: { text: result.introText }
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Conversational Standup Session (state machine)
//
// Instead of a card form, the bot asks questions one at a time via
// plain text messages. The user types their answer as a regular chat
// message. This gives a natural "talking to a colleague" feel and
// uses the full Chat input box instead of cramped card widgets.
//
// Session state is kept in CacheService (6-hour TTL). Each user can
// have at most one active session at a time.
//
// The card form remains available as a fallback — the "Fill Standup"
// button on the notification card opens the card form via
// handleShowStandupForm.
// ---------------------------------------------------------------------------

var SESSION_TTL = 21600; // 6 hours

function getSessionCacheKey(email) {
  return 'standup_session:' + email;
}

/**
 * Creates a new conversational standup session for a user and returns
 * the intro message + first question.
 */
function startStandupSession(email, standupDate, questions, memberName, existingAnswers) {
  var session = {
    email: email,
    standupDate: standupDate,
    questions: questions.map(function(q) {
      return { id: String(q.id), question: q.question, required: !!q.required };
    }),
    currentIndex: 0,
    answers: {},
    existingAnswers: existingAnswers || {},
    memberName: memberName,
    isEditing: !!(existingAnswers && Object.keys(existingAnswers).length > 0)
  };

  CacheService.getScriptCache().put(
    getSessionCacheKey(email),
    JSON.stringify(session),
    SESSION_TTL
  );

  return session;
}

function getStandupSession(email) {
  var raw = CacheService.getScriptCache().get(getSessionCacheKey(email));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveStandupSession(session) {
  CacheService.getScriptCache().put(
    getSessionCacheKey(session.email),
    JSON.stringify(session),
    SESSION_TTL
  );
}

function clearStandupSession(email) {
  CacheService.getScriptCache().remove(getSessionCacheKey(email));
}

/**
 * Formats the current question as a text prompt.
 */
function buildQuestionPrompt(session) {
  var q = session.questions[session.currentIndex];
  var total = session.questions.length;
  var num = session.currentIndex + 1;
  var inputKey = 'question_' + q.id;

  var text = '*(' + num + '/' + total + ') ' + q.question + '*';

  // Show previous answer in edit mode
  if (session.isEditing && session.existingAnswers[inputKey]) {
    text += '\n_Previous: ' + session.existingAnswers[inputKey] + '_';
  }

  // Hint for optional questions
  if (!q.required) {
    text += '\n_(Optional)_';
  }

  return text;
}

/**
 * Builds the intro message shown when a session starts, including
 * the first question.
 */
function buildSessionIntro(session) {
  var dateLabel = formatStandupDateLabel(session.standupDate);
  var total = session.questions.length;
  var intro;

  if (session.isEditing) {
    intro = '*Editing your standup for ' + dateLabel + '*\n'
      + total + ' question' + (total === 1 ? '' : 's')
      + '. Type a new answer or "keep" to keep your previous one.\n\n'
      + '_Commands: "keep" · "skip" (optional) · "back" · "cancel"_';
  } else {
    intro = '*Standup for ' + dateLabel + '*\n'
      + total + ' question' + (total === 1 ? '' : 's')
      + '. Just type your answer and send.\n\n'
      + '_Commands: "skip" (optional) · "back" · "cancel"_';
  }

  intro += '\n\n' + buildQuestionPrompt(session);
  return intro;
}

/**
 * Processes a user's text message as an answer in their active
 * conversational standup session. Handles commands (skip, back,
 * cancel, keep) and regular answers.
 *
 * @param {Object} event - Google Chat event
 * @param {Object} session - The active session from cache
 * @returns {Object} Text response with the next question, or confirmation
 */
function handleStandupAnswer(event, session) {
  var chatEvent = event.chat || event;
  var message = null;
  if (chatEvent.messagePayload && chatEvent.messagePayload.message) {
    message = chatEvent.messagePayload.message;
  } else if (chatEvent.appCommandPayload && chatEvent.appCommandPayload.message) {
    message = chatEvent.appCommandPayload.message;
  } else {
    message = event.message;
  }

  var text = ((message && message.text) || '').trim();
  var lower = text.toLowerCase();

  // ---- Command: cancel ----
  if (lower === 'cancel' || lower === 'quit' || lower === 'exit') {
    clearStandupSession(session.email);
    return createTextResponse('Standup cancelled. Run /standup to start again.');
  }

  // ---- Command: back ----
  if (lower === 'back' || lower === 'undo') {
    if (session.currentIndex === 0) {
      return createTextResponse('Already at the first question.\n\n' + buildQuestionPrompt(session));
    }
    session.currentIndex--;
    saveStandupSession(session);
    return createTextResponse(buildQuestionPrompt(session));
  }

  var q = session.questions[session.currentIndex];
  var inputKey = 'question_' + q.id;

  // ---- Command: skip (optional questions only) ----
  if (lower === 'skip') {
    if (q.required) {
      return createTextResponse('This question is required and cannot be skipped.\n\n' + buildQuestionPrompt(session));
    }
    session.answers[inputKey] = '';
    session.currentIndex++;
    saveStandupSession(session);

    if (session.currentIndex >= session.questions.length) {
      return completeStandupSession(session);
    }
    return createTextResponse(buildQuestionPrompt(session));
  }

  // ---- Command: keep (edit mode — retain previous answer) ----
  if (lower === 'keep') {
    if (!session.isEditing || !session.existingAnswers[inputKey]) {
      return createTextResponse('No previous answer to keep for this question. Type your answer instead.\n\n' + buildQuestionPrompt(session));
    }
    session.answers[inputKey] = session.existingAnswers[inputKey];
    session.currentIndex++;
    saveStandupSession(session);

    if (session.currentIndex >= session.questions.length) {
      return completeStandupSession(session);
    }
    return createTextResponse(buildQuestionPrompt(session));
  }

  // ---- Blank answer ----
  if (!text) {
    if (q.required) {
      return createTextResponse('This question is required. Please type your answer.\n\n' + buildQuestionPrompt(session));
    }
    // Optional + blank → treat as skip
    session.answers[inputKey] = '';
    session.currentIndex++;
    saveStandupSession(session);

    if (session.currentIndex >= session.questions.length) {
      return completeStandupSession(session);
    }
    return createTextResponse(buildQuestionPrompt(session));
  }

  // ---- Regular answer ----
  session.answers[inputKey] = text;
  session.currentIndex++;
  saveStandupSession(session);

  if (session.currentIndex >= session.questions.length) {
    return completeStandupSession(session);
  }
  return createTextResponse(buildQuestionPrompt(session));
}

/**
 * Saves all collected answers to the database, fetches Jira tickets,
 * clears the session, and returns a confirmation message.
 */
function completeStandupSession(session) {
  var jiraTickets = [];
  try {
    jiraTickets = fetchJiraTickets(session.email);
  } catch (e) {
    Logger.log('Jira fetch failed during session complete for ' + session.email + ': ' + e.message);
    if (e.message && e.message.indexOf('401') > -1) {
      notifyAdminsJiraExpired();
    }
  }

  upsertStandupResponse(
    session.standupDate,
    session.memberName,
    session.email,
    session.answers,
    jiraTickets
  );

  clearStandupSession(session.email);
  Logger.log('Conversational standup completed for ' + session.memberName + ' (' + session.standupDate + ')');

  var dateLabel = formatStandupDateLabel(session.standupDate);
  return createTextResponse(
    'Thanks, ' + session.memberName + '! Your standup for *' + dateLabel + '* has been recorded.\n\n'
    + '_You can edit your answers by running /standup again before the morning digest._'
  );
}

// ---------------------------------------------------------------------------
// Send Reminders (triggered at REMINDER_TIME)
// ---------------------------------------------------------------------------

/**
 * Sends reminder DMs to team members who haven't submitted for the
 * upcoming meeting (the next workday's standup).
 *
 * Reminders fire at REMINDER_TIME on the same day submissions opened
 * (e.g. 17:15 right after the 16:45 prompt). Submissions are stored
 * keyed by the meeting date (next workday), so we need to query that
 * date — not today — to find non-responders.
 */
function sendReminders() {
  var day = new Date().getDay();
  if (day === 0 || day === 6) return;

  var meetingDate = getNextWorkdayDate();
  var members = getActiveTeamMembers();
  var respondedEmails = getRespondedEmails(meetingDate);

  var nonResponders = members.filter(function(m) {
    return respondedEmails.indexOf(m.email) === -1;
  });

  if (nonResponders.length === 0) {
    Logger.log('Everyone has responded! No reminders needed.');
    return;
  }

  var reminderCard = buildReminderCard();
  var sentCount = 0;

  nonResponders.forEach(function(member) {
    if (!member.chat_user_id) {
      Logger.log('Skipping reminder for ' + member.name + ' (' + member.email + '): no chat_user_id captured yet');
      return;
    }
    try {
      var dmSpace = getOrCreateDmSpace(member.chat_user_id);
      botMessageCreate(reminderCard, dmSpace);
      sentCount++;
    } catch (e) {
      Logger.log('Failed to remind ' + member.email + ': ' + e.message);
    }
  });

  Logger.log('Reminders sent to ' + sentCount + ' of ' + nonResponders.length + ' non-responders');
}

// ---------------------------------------------------------------------------
// Post Digest (triggered at DIGEST_TIME)
// ---------------------------------------------------------------------------

/**
 * Posts the standup digest for a meeting date to the team space.
 *
 * Two invocation modes:
 *
 *   postDigest()
 *     Cron mode. No date passed → uses today's date and skips weekends.
 *     This is what the time-based trigger calls at DIGEST_TIME.
 *
 *   postDigest('2026-04-13')
 *     Manual mode. Skips the weekend check (admin is explicitly asking),
 *     uses the given meeting date for the query and the card label.
 *     Used by the `/digest-now [YYYY-MM-DD]` slash command and for
 *     ad-hoc testing from the editor.
 *
 * Submissions are stored keyed by MEETING DATE, so the query is always
 * `date = meetingDate` regardless of which day this function runs on.
 *
 * @param {string} [meetingDate] - YYYY-MM-DD; defaults to getTodayDate()
 * @returns {{ ok: boolean, reason: string|null, responseCount: number }}
 */
function postDigest(meetingDate) {
  // Time-based triggers call this as `postDigest(triggerEvent)`, so the
  // first argument is an event object — not a date. Treat anything that
  // isn't a string as "no date provided" and fall back to cron behavior
  // (use today's date, skip weekends).
  if (typeof meetingDate !== 'string') {
    meetingDate = null;
  }

  if (!meetingDate) {
    var day = new Date().getDay();
    if (day === 0 || day === 6) {
      Logger.log('postDigest skipping — weekend');
      return { ok: false, reason: 'weekend', responseCount: 0 };
    }
    meetingDate = getTodayDate();
  }

  var responses = getTodaysResponses(meetingDate);
  var questions = getQuestions();
  var members = getActiveTeamMembers();
  var settings = getAllSettings();

  var spaceId = settings['STANDUP_SPACE_ID'];
  if (!spaceId || spaceId === 'spaces/REPLACE_ME') {
    Logger.log('STANDUP_SPACE_ID not configured');
    return { ok: false, reason: 'no-space', responseCount: 0 };
  }

  var respondedEmails = responses.map(function(r) { return r.email; });
  var nonResponders = members
    .filter(function(m) { return respondedEmails.indexOf(m.email) === -1; })
    .map(function(m) { return m.name; });

  var dateLabel = formatStandupDateLabel(meetingDate);

  // Step 1: post the SUMMARY card to the team space. The response
  // includes a `thread.name` reference we use for the per-person replies.
  var summaryCard = buildDigestSummaryCard(responses, nonResponders, dateLabel);
  var summaryMessage;
  try {
    summaryMessage = botMessageCreate(summaryCard, spaceId);
  } catch (e) {
    Logger.log('Failed to post digest summary: ' + e.message);
    return { ok: false, reason: e.message, responseCount: responses.length };
  }

  Logger.log('Digest summary posted to ' + spaceId + ' for ' + meetingDate);

  // Step 2: post each member's response as a reply in the summary thread.
  // We don't fail the whole digest if a single reply fails — log and
  // keep going. Worst case the channel still has the summary, just
  // missing one or two thread replies.
  var threadName = summaryMessage && summaryMessage.thread && summaryMessage.thread.name;
  var repliesPosted = 0;
  var repliesFailed = 0;

  if (threadName) {
    responses.forEach(function(response) {
      try {
        var replyCard = buildDigestReplyCard(response, questions);
        botMessageCreateInThread(replyCard, spaceId, threadName);
        repliesPosted++;
      } catch (e) {
        Logger.log('Failed to post digest reply for ' + response.email + ': ' + e.message);
        repliesFailed++;
      }
    });
  } else {
    Logger.log('No thread name on summary message — skipping per-person replies');
  }

  Logger.log('Digest complete for ' + meetingDate + ': '
    + responses.length + ' responses, '
    + nonResponders.length + ' non-responders, '
    + repliesPosted + ' replies posted'
    + (repliesFailed ? ', ' + repliesFailed + ' replies failed' : ''));

  return { ok: true, reason: null, responseCount: responses.length };
}

// ---------------------------------------------------------------------------
// DM Space Helper
// ---------------------------------------------------------------------------

/**
 * Gets or creates a DM space between the bot and a user.
 *
 * Uses bot-credentialed REST calls (Bot.gs) so the lookup runs as the
 * bot itself, not as the calling user. This sidesteps the "DM with
 * yourself" rejection that occurs when the script runs as a human user
 * and tries to find a DM with that same user.
 *
 * Tries `findDirectMessage` first; falls back to `setupDm` if no DM
 * exists yet.
 *
 * @param {string} email - User's email
 * @returns {string} Space name (e.g. "spaces/AAAA")
 */
function getOrCreateDmSpace(email) {
  var existing = botFindDirectMessage(email);
  if (existing && existing.name) {
    return existing.name;
  }

  var created = botSetupDm(email);
  return created.name;
}

// ---------------------------------------------------------------------------
// Jira Expiry Notification
// ---------------------------------------------------------------------------

/**
 * Notifies all admins that the Jira API token has expired.
 */
function notifyAdminsJiraExpired() {
  var admins = getAdmins();
  var members = getAllTeamMembers();
  var memberByEmail = {};
  members.forEach(function(m) { memberByEmail[m.email] = m; });

  var warningCard = buildTextCard(
    'Jira Token Expired',
    'The Jira API token has expired or is invalid. Standup collection continues but Jira tickets are unavailable.\n\nUpdate the token in Apps Script → Project Settings → Script Properties → JIRA_API_TOKEN.'
  );

  admins.forEach(function(admin) {
    var member = memberByEmail[admin.email];
    if (!member || !member.chat_user_id) {
      Logger.log('Cannot notify admin ' + admin.email + ': no chat_user_id captured (admin must also be a team_member who has interacted with the bot)');
      return;
    }
    try {
      var dmSpace = getOrCreateDmSpace(member.chat_user_id);
      botMessageCreate(warningCard, dmSpace);
    } catch (e) {
      Logger.log('Failed to notify admin ' + admin.email + ': ' + e.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Trigger Management
// ---------------------------------------------------------------------------

/**
 * Creates time-based triggers from settings.
 * Deletes any existing Heubot triggers first.
 * Run this manually on first deploy, or after schedule changes.
 */
function createTriggers() {
  deleteTriggers();

  var settings = getAllSettings();
  var promptTime = settings['PROMPT_TIME'] || '16:45';
  var reminderTime = settings['REMINDER_TIME'] || '17:15';
  var digestTime = settings['DIGEST_TIME'] || '09:00';

  createDailyTrigger('sendStandupNotifications', promptTime);
  createDailyTrigger('sendReminders', reminderTime);
  createDailyTrigger('postDigest', digestTime);

  // Monthly DB usage check — 1st of every month at 10:00
  ScriptApp.newTrigger('checkDbUsage')
    .timeBased()
    .onMonthDay(1)
    .atHour(10)
    .create();

  Logger.log('Triggers created: prompt=' + promptTime + ', reminder=' + reminderTime + ', digest=' + digestTime + ', monthly DB check');
}

/**
 * Creates a daily trigger at a specific time.
 * @param {string} functionName - Function to trigger
 * @param {string} timeStr - Time in HH:MM format (24h)
 */
function createDailyTrigger(functionName, timeStr) {
  var parts = timeStr.split(':');
  var hour = parseInt(parts[0], 10);
  var minute = parseInt(parts[1], 10);

  ScriptApp.newTrigger(functionName)
    .timeBased()
    .everyDays(1)
    .atHour(hour)
    .nearMinute(minute)
    .create();
}

/**
 * Deletes only the triggers this project owns (by handler function name).
 * Keeps us from nuking unrelated triggers a developer may have added
 * while debugging, and keeps the delete/create cycle idempotent so we
 * don't accumulate duplicates on every schedule save.
 */
function deleteTriggers() {
  var owned = {
    sendStandupNotifications: true,
    sendStandupCards: true,         // legacy name — clean up if found
    sendReminders: true,
    postDigest: true,
    checkDbUsage: true
  };
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  triggers.forEach(function(trigger) {
    if (owned[trigger.getHandlerFunction()]) {
      ScriptApp.deleteTrigger(trigger);
      deleted++;
    }
  });
  Logger.log('Deleted ' + deleted + ' of ' + triggers.length + ' existing triggers');
}

/**
 * Diagnostic — run manually from the editor to see every trigger
 * currently visible to this user on this project.
 */
function dumpAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  Logger.log('Total triggers: ' + triggers.length);
  triggers.forEach(function(t, i) {
    Logger.log(i + ': handler=' + t.getHandlerFunction()
      + ' eventType=' + t.getEventType()
      + ' id=' + t.getUniqueId());
  });
}

/**
 * One-shot cleanup — deletes EVERY trigger on the project. Use from the
 * editor only, when you are quota-blocked and willing to wipe the slate.
 */
function deleteAllTriggersHard() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Hard-deleted ' + triggers.length + ' triggers');
}

// ---------------------------------------------------------------------------
// DB Usage Check (monthly trigger)
// ---------------------------------------------------------------------------

/**
 * Checks approximate DB usage and warns admins if threshold exceeded.
 */
function checkDbUsage() {
  var settings = getAllSettings();
  var threshold = parseInt(settings['DB_WARN_THRESHOLD_PERCENT'] || '80', 10);

  // Supabase free tier: 500MB. Estimate based on row count.
  // ~500 bytes per response row, so 500MB ≈ 1,000,000 rows
  var maxRows = 1000000;
  var rowCount = getDbRowCount();
  var usagePercent = Math.round((rowCount / maxRows) * 100);

  Logger.log('DB usage: ~' + rowCount + ' rows (' + usagePercent + '% of estimated capacity)');

  if (usagePercent >= threshold) {
    var admins = getAdmins();
    var warningCard = buildTextCard(
      'DB Usage Warning',
      'Heubot database is approximately <b>' + usagePercent + '%</b> full (' + rowCount + ' response rows).\n\n'
      + 'Use the <b>/purge</b> command to delete old standup data and free up space.'
    );

    var allMembers = getAllTeamMembers();
    var byEmail = {};
    allMembers.forEach(function(m) { byEmail[m.email] = m; });

    admins.forEach(function(admin) {
      var member = byEmail[admin.email];
      if (!member || !member.chat_user_id) {
        Logger.log('Cannot notify admin ' + admin.email + ': no chat_user_id');
        return;
      }
      try {
        var dmSpace = getOrCreateDmSpace(member.chat_user_id);
        botMessageCreate(warningCard, dmSpace);
      } catch (e) {
        Logger.log('Failed to notify admin ' + admin.email + ': ' + e.message);
      }
    });
  }
}
