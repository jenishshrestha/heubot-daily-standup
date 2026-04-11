/**
 * Code.gs — Main entry points for Heubot
 *
 * Handles:
 * - sendStandupCards()   — DM standup form to each team member
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

function getTomorrowDateLabel() {
  var tz = getSetting('TIMEZONE') || 'Asia/Kathmandu';
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return Utilities.formatDate(tomorrow, tz, 'MMMM d, yyyy');
}

function getTodayDateLabel() {
  var tz = getSetting('TIMEZONE') || 'Asia/Kathmandu';
  return Utilities.formatDate(new Date(), tz, 'MMMM d, yyyy');
}

// ---------------------------------------------------------------------------
// Send Standup Cards (triggered at PROMPT_TIME, Mon-Fri)
// ---------------------------------------------------------------------------

/**
 * Sends standup form cards via DM to all active team members.
 * Skips weekends.
 */
function sendStandupCards() {
  // Skip weekends
  var day = new Date().getDay();
  if (day === 0 || day === 6) {
    Logger.log('Skipping standup — weekend');
    return;
  }

  var members = getActiveTeamMembers();
  var questions = getQuestions();

  if (members.length === 0) {
    Logger.log('No active team members found');
    return;
  }

  if (questions.length === 0) {
    Logger.log('No questions configured');
    return;
  }

  var dateLabel = getTomorrowDateLabel();
  var card = buildStandupCard(questions, dateLabel);

  var successCount = 0;
  var failCount = 0;

  members.forEach(function(member) {
    try {
      var dmSpace = getOrCreateDmSpace(member.email);
      Chat.Spaces.Messages.create(card, dmSpace);
      successCount++;
    } catch (e) {
      Logger.log('Failed to DM ' + member.email + ': ' + e.message);
      failCount++;
    }
  });

  Logger.log('Standup cards sent: ' + successCount + ' success, ' + failCount + ' failed');
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

  var common = event.commonEventObject || event.common || {};
  var action = common.invokedFunction;
  var chatEvent = event.chat || event;
  var user = chatEvent.user || event.user;

  event.user = user;
  event.common = common;
  event.common.formInputs = common.formInputs || {};

  switch (action) {
    case 'handleStandupSubmit':          return handleStandupSubmit(event);
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
 * Wraps a card for a button-click response.
 *
 * Slash-command responses are posted as real chat messages via
 * `hostAppDataAction.chatDataAction.createMessageAction`. Buttons on those
 * cards live inside chat messages, so their click responses must also use
 * the `hostAppDataAction` envelope (not `renderActions`, which only
 * applies to add-on home/sidebar cards). Posting a new message is the
 * simplest shape that works in every context — the click produces a new
 * card below the current one, and the user can scroll back.
 */
function createNavResponse(cardResult) {
  return createCardResponse(cardResult);
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
    return createNavResponse(buildTextCard('Error', 'You are not registered as a team member. Contact an admin.'));
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

  // ---- Idempotency layer 2: DB upsert keyed on (date, email) ----
  // Survives cache eviction, cold starts, and accidental double-clicks
  // hours apart. One row per user per day, no matter what.
  var today = getTodayDate();
  upsertStandupResponse(today, member.name, member.email, answers, jiraTickets);

  Logger.log('Standup recorded for ' + member.name);
  var response = createNavResponse(buildConfirmationCard(member.name));

  if (eventTime) {
    cache.put(cacheKey, JSON.stringify(response), 600);
  }

  return response;
}

// ---------------------------------------------------------------------------
// Send Reminders (triggered at REMINDER_TIME)
// ---------------------------------------------------------------------------

/**
 * Sends reminder DMs to team members who haven't submitted today.
 */
function sendReminders() {
  var day = new Date().getDay();
  if (day === 0 || day === 6) return;

  var today = getTodayDate();
  var members = getActiveTeamMembers();
  var respondedEmails = getRespondedEmails(today);

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
    try {
      var dmSpace = getOrCreateDmSpace(member.email);
      Chat.Spaces.Messages.create(reminderCard, dmSpace);
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
 * Posts the daily standup digest to the team space.
 */
function postDigest() {
  var day = new Date().getDay();
  if (day === 0 || day === 6) return;

  var today = getTodayDate();
  var responses = getTodaysResponses(today);
  var questions = getQuestions();
  var members = getActiveTeamMembers();
  var settings = getAllSettings();

  var spaceId = settings['STANDUP_SPACE_ID'];
  if (!spaceId || spaceId === 'spaces/REPLACE_ME') {
    Logger.log('STANDUP_SPACE_ID not configured');
    return;
  }

  // Find non-responders
  var respondedEmails = responses.map(function(r) { return r.email; });
  var nonResponders = members
    .filter(function(m) { return respondedEmails.indexOf(m.email) === -1; })
    .map(function(m) { return m.name; });

  var dateLabel = getTodayDateLabel();
  var digestCard = buildDigestCard(responses, questions, nonResponders, dateLabel);

  try {
    Chat.Spaces.Messages.create(digestCard, spaceId);
    Logger.log('Digest posted to ' + spaceId);
  } catch (e) {
    Logger.log('Failed to post digest: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// DM Space Helper
// ---------------------------------------------------------------------------

/**
 * Gets or creates a DM space with a user.
 * @param {string} email - User's email
 * @returns {string} Space name (e.g. "spaces/AAAA")
 */
function getOrCreateDmSpace(email) {
  var response = Chat.Spaces.setup({
    spaceType: 'DIRECT_MESSAGE',
    members: [{
      member: {
        name: 'users/' + email,
        type: 'HUMAN'
      }
    }]
  });
  return response.name;
}

// ---------------------------------------------------------------------------
// Jira Expiry Notification
// ---------------------------------------------------------------------------

/**
 * Notifies all admins that the Jira API token has expired.
 */
function notifyAdminsJiraExpired() {
  var admins = getAdmins();
  var warningCard = buildTextCard(
    'Jira Token Expired',
    'The Jira API token has expired or is invalid. Standup collection continues but Jira tickets are unavailable.\n\nUpdate the token in Apps Script → Project Settings → Script Properties → JIRA_API_TOKEN.'
  );

  admins.forEach(function(admin) {
    try {
      var dmSpace = getOrCreateDmSpace(admin.email);
      Chat.Spaces.Messages.create(warningCard, dmSpace);
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
  var digestTime = settings['DIGEST_TIME'] || '17:30';

  createDailyTrigger('sendStandupCards', promptTime);
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
    sendStandupCards: true,
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

    admins.forEach(function(admin) {
      try {
        var dmSpace = getOrCreateDmSpace(admin.email);
        Chat.Spaces.Messages.create(warningCard, dmSpace);
      } catch (e) {
        Logger.log('Failed to notify admin ' + admin.email + ': ' + e.message);
      }
    });
  }
}
