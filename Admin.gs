/**
 * Admin.gs — Slash command handlers for Heubot
 *
 * All admin commands are gated by the "admins" table.
 * Regular team members only interact via the standup card.
 *
 * Slash commands:
 *   /settings         — Show current bot config
 *   /set-schedule     — Open dialog to change times
 *   /questions        — Show current questions
 *   /add-question     — Open dialog to add a question
 *   /remove-question  — Show questions with remove buttons (same as /questions)
 *   /team             — Show team member list
 *   /add-member       — Open dialog to add a member
 *   /remove-member    — Show team with remove buttons (same as /team)
 *   /notify-all       — Manually notify all members to fill standup
 *   /digest-now       — Manually post the digest for today (or a given date)
 *   /status           — Show today's response status
 *   /purge            — Open dialog to delete data by date range
 */

// ---------------------------------------------------------------------------
// Slash Command Router
// ---------------------------------------------------------------------------

/**
 * Routes slash commands to the appropriate handler.
 * Checks admin authorization first.
 * @param {Object} event - Google Chat event
 * @returns {Object} Response card
 */
function routeSlashCommand(event) {
  var user = event.user;
  var rawCommandId = event.message.slashCommand.commandId;
  var commandId = String(rawCommandId);
  Logger.log('routeSlashCommand — rawCommandId: ' + rawCommandId + ', type: ' + typeof rawCommandId + ', commandId: ' + commandId);

  // Commands available to every team member (not just admins).
  // /standup (and /help in future) — these run before the admin gate.
  if (commandId === '11') {
    var standupResult = handleStandup(event);
    // handleStandup returns either:
    //   - createTextResponse(...) for the conversational flow (pre-wrapped)
    //   - a raw card for --form fallback or error (needs wrapping)
    // If it has hostAppDataAction, it's pre-wrapped. Otherwise wrap it.
    if (standupResult && standupResult.hostAppDataAction) {
      return standupResult;
    }
    return createCardResponse(standupResult);
  }

  // Everything else is admin-only.
  if (!isAdmin(user.email)) {
    return createCardResponse(buildTextCard('Access Denied', 'Sorry, only admins can use this command. Contact an admin to get access.'));
  }

  // Route by command ID. IDs are assigned when registering each slash
  // command in the GCP Console → Chat API → Configuration page.
  var result;
  switch (commandId) {
    case '1':   result = handleSettings(event); break;
    case '2':   result = handleSetSchedule(event); break;
    case '3':   result = handleQuestions(event); break;
    case '4':   result = handleShowAddQuestionCmd(event); break;
    case '5':   result = handleTeam(event); break;
    case '6':   result = handleShowAddMemberCmd(event); break;
    case '7':   result = handleNotifyAll(event); break;
    case '8':   result = handleStatus(event); break;
    case '9':   result = handlePurgeCmd(event); break;
    case '10':  result = handleSetThisSpace(event); break;
    case '12':  result = handleDigestNow(event); break;
    default:    result = buildTextCard('Unknown Command', 'Command ID ' + commandId + ' is not recognized.');
  }

  return createCardResponse(result);
}

// ---------------------------------------------------------------------------
// /settings
// ---------------------------------------------------------------------------

function handleSettings(event) {
  var settings = getAllSettings();
  var members = getActiveTeamMembers();
  var questions = getQuestions();
  return buildSettingsCard(settings, members.length, questions.length);
}

// ---------------------------------------------------------------------------
// /set-schedule
// ---------------------------------------------------------------------------

function handleSetSchedule(event) {
  var settings = getAllSettings();
  return buildScheduleDialog(settings);
}

/**
 * Button click: "Edit Schedule" from the settings card.
 * Framework calls this directly via action.function, so we must wrap the
 * return in the add-on navigation envelope ourselves.
 */
function handleShowScheduleDialog(event) {
  Logger.log('handleShowScheduleDialog invoked');
  var settings = getAllSettings();
  return createUpdateResponse(buildScheduleDialog(settings));
}

function handleSaveSchedule(event) {
  Logger.log('handleSaveSchedule invoked');
  Logger.log('handleSaveSchedule event: ' + JSON.stringify(event));

  try {
    var formInputs = getFormInputs(event);
    Logger.log('handleSaveSchedule formInputs: ' + JSON.stringify(formInputs));

    var promptTime = readStringInput(formInputs, 'prompt_time');
    var reminderTime = readStringInput(formInputs, 'reminder_time');
    var digestTime = readStringInput(formInputs, 'digest_time');

    var timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(promptTime) || !timeRegex.test(reminderTime) || !timeRegex.test(digestTime)) {
      return createUpdateResponse(buildTextCard(
        'Invalid Time',
        'Please use HH:MM format (24h). Got:\n'
        + '• Prompt: ' + promptTime + '\n'
        + '• Reminder: ' + reminderTime + '\n'
        + '• Digest: ' + digestTime
      ));
    }

    updateSetting('PROMPT_TIME', promptTime);
    updateSetting('REMINDER_TIME', reminderTime);
    updateSetting('DIGEST_TIME', digestTime);

    var triggerNote = 'Triggers have been updated.';
    try {
      createTriggers();
    } catch (triggerErr) {
      Logger.log('createTriggers failed after settings save: ' + triggerErr.message);
      triggerNote = '<b>Note:</b> settings saved, but trigger rebuild failed — '
        + triggerErr.message
        + '\n\nRun <code>createTriggers</code> manually from the Apps Script editor once the quota resets.';
    }

    return createUpdateResponse(buildTextCard(
      'Schedule Updated',
      'New schedule:\n'
      + '• Prompt: ' + promptTime + '\n'
      + '• Reminder: ' + reminderTime + '\n'
      + '• Digest: ' + digestTime + '\n\n'
      + triggerNote
    ));
  } catch (e) {
    Logger.log('handleSaveSchedule error: ' + e.message + '\n' + e.stack);
    return createUpdateResponse(buildTextCard(
      'Save Failed',
      'Error: ' + e.message + '\n\n(Check Apps Script Executions log for details.)'
    ));
  }
}

// ---------------------------------------------------------------------------
// /questions, /add-question, /remove-question
// ---------------------------------------------------------------------------

function handleQuestions(event) {
  var questions = getQuestions();
  return buildQuestionsCard(questions);
}

function handleShowQuestions(event) {
  Logger.log('handleShowQuestions invoked');
  var questions = getQuestions();
  return createUpdateResponse(buildQuestionsCard(questions));
}

function handleShowAddQuestionCmd(event) {
  var questions = getQuestions();
  var nextOrder = questions.length > 0 ? questions[questions.length - 1].sort_order + 1 : 1;
  return buildAddQuestionDialog(nextOrder);
}

function handleShowAddQuestionDialog(event) {
  Logger.log('handleShowAddQuestionDialog invoked');
  var questions = getQuestions();
  var nextOrder = questions.length > 0 ? questions[questions.length - 1].sort_order + 1 : 1;
  return createUpdateResponse(buildAddQuestionDialog(nextOrder));
}

function handleAddQuestion(event) {
  Logger.log('handleAddQuestion invoked');
  var formInputs = getFormInputs(event);
  var params = getParams(event);

  var questionText = formInputs.question_text.stringInputs.value[0];
  var isRequired = formInputs.question_required
    && formInputs.question_required.stringInputs
    && formInputs.question_required.stringInputs.value.indexOf('true') > -1;
  var nextOrder = parseInt(params.nextOrder, 10);

  if (!questionText || questionText.trim() === '') {
    return createUpdateResponse(buildTextCard('Error', 'Question text cannot be empty.'));
  }

  addQuestion(nextOrder, questionText.trim(), isRequired);
  return createUpdateResponse(buildTextCard('Question Added', 'New question added: "' + questionText.trim() + '"'));
}

function handleRemoveQuestion(event) {
  Logger.log('handleRemoveQuestion invoked');
  var params = getParams(event);
  var questionId = params.questionId;

  deleteQuestion(questionId);

  var questions = getQuestions();
  if (questions.length === 0) {
    return createUpdateResponse(buildTextCard('Questions', 'All questions have been removed. Use /add-question to add new ones.'));
  }
  return createUpdateResponse(buildQuestionsCard(questions));
}

// ---------------------------------------------------------------------------
// /team, /add-member, /remove-member
// ---------------------------------------------------------------------------

function handleTeam(event) {
  var members = getAllTeamMembers();
  return buildTeamCard(members);
}

function handleShowTeam(event) {
  Logger.log('handleShowTeam invoked');
  var members = getAllTeamMembers();
  return createUpdateResponse(buildTeamCard(members));
}

function handleShowAddMemberCmd(event) {
  return buildAddMemberDialog();
}

function handleShowAddMemberDialog(event) {
  Logger.log('handleShowAddMemberDialog invoked');
  return createUpdateResponse(buildAddMemberDialog());
}

function handleAddMember(event) {
  Logger.log('handleAddMember invoked');
  var formInputs = getFormInputs(event);

  var name = formInputs.member_name.stringInputs.value[0];
  var email = formInputs.member_email.stringInputs.value[0];
  var jiraUsername = formInputs.member_jira
    && formInputs.member_jira.stringInputs
    ? formInputs.member_jira.stringInputs.value[0]
    : '';

  if (!name || !email) {
    return createUpdateResponse(buildTextCard('Error', 'Name and email are required.'));
  }

  try {
    addTeamMember(name.trim(), email.trim(), jiraUsername.trim());
    return createUpdateResponse(buildTextCard('Member Added', name.trim() + ' (' + email.trim() + ') has been added to the team.'));
  } catch (e) {
    if (e.message && e.message.indexOf('duplicate') > -1) {
      return createUpdateResponse(buildTextCard('Error', 'A member with email ' + email.trim() + ' already exists.'));
    }
    return createUpdateResponse(buildTextCard('Error', 'Failed to add member: ' + e.message));
  }
}

function handleRemoveMember(event) {
  Logger.log('handleRemoveMember invoked');
  var params = getParams(event);
  var email = params.email;

  removeTeamMember(email);

  var members = getAllTeamMembers();
  return createUpdateResponse(buildTeamCard(members));
}

function handleActivateMember(event) {
  Logger.log('handleActivateMember invoked');
  var params = getParams(event);
  var email = params.email;

  supabaseRequest('/rest/v1/team_members', {
    method: 'PATCH',
    query: 'email=eq.' + encodeURIComponent(email),
    payload: { active: true }
  });

  var members = getAllTeamMembers();
  return createUpdateResponse(buildTeamCard(members));
}

// ---------------------------------------------------------------------------
// /notify-all
// ---------------------------------------------------------------------------

function handleNotifyAll(event) {
  Logger.log('handleNotifyAll invoked');

  // Skip notifying the caller via API — they'll see the same card returned
  // as the slash command's response below, so a separate DM would be a
  // duplicate (and would arrive *before* the response in chat order, which
  // is confusing).
  var callerEmail = (event.user && event.user.email) || null;
  var result = sendStandupNotifications(true, callerEmail);

  if (result.skipped === 'no-members') {
    return buildTextCard('Nothing to Send', 'No active team members configured. Use <code>/team</code> to add some.');
  }
  if (result.skipped === 'no-questions') {
    return buildTextCard('Nothing to Send', 'No questions configured. Use <code>/add-question</code> to add some.');
  }

  // Build the broadcast footer that gets stitched into the response card.
  var note;
  if (result.total === 0) {
    note = 'You are the only active team member — no one else to notify.';
  } else if (result.failed > 0 && result.sent === 0) {
    note = '⚠ Tried to notify ' + result.total + ' other members, but every send failed. '
      + 'Most likely cause: <code>chat_user_id</code> not yet captured. Check the Apps Script Executions log.';
  } else if (result.failed > 0) {
    note = 'Notified ' + result.sent + ' of ' + result.total + ' other members. '
      + result.failed + ' skipped (haven\'t messaged the bot yet).';
  } else {
    note = 'Notified ' + result.sent + ' other team member' + (result.sent === 1 ? '' : 's') + '.';
  }

  // The response card IS the caller's notification — same Fill Standup
  // button as everyone else's notification, plus a footer telling them
  // how many other people were notified. One card, not two.
  var dateLabel = getNextWorkdayLabel();
  var standupDate = getNextWorkdayDate();
  return buildStandupNotificationCard(dateLabel, standupDate, { broadcastNote: note });
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

function handleStatus(event) {
  // Smart auto-detect: if it's a weekday morning before submissions
  // open, show today's meeting (the one happening now). Otherwise show
  // the next workday's meeting (the one submissions are being collected
  // for). On weekends, show next Monday.
  var standupDate = getActiveStandupDate();
  var responses = getTodaysResponses(standupDate);
  var members = getActiveTeamMembers();

  var respondedEmails = responses.map(function(r) { return r.email; });

  var responded = members.filter(function(m) {
    return respondedEmails.indexOf(m.email) > -1;
  });

  var pending = members.filter(function(m) {
    return respondedEmails.indexOf(m.email) === -1;
  });

  return buildStatusCard(responded, pending, formatStandupDateLabel(standupDate));
}

// ---------------------------------------------------------------------------
// /purge
// ---------------------------------------------------------------------------

function handlePurgeCmd(event) {
  return buildPurgeDialog();
}

function handleShowPurgeDialog(event) {
  Logger.log('handleShowPurgeDialog invoked');
  return createUpdateResponse(buildPurgeDialog());
}

function handlePurge(event) {
  Logger.log('handlePurge invoked');
  var formInputs = getFormInputs(event);

  var startDate = formInputs.purge_start.stringInputs.value[0];
  var endDate = formInputs.purge_end.stringInputs.value[0];

  var dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    return createUpdateResponse(buildTextCard('Invalid Date', 'Please use YYYY-MM-DD format. Example: 2025-01-01'));
  }

  if (startDate > endDate) {
    return createUpdateResponse(buildTextCard('Invalid Range', 'Start date must be before end date.'));
  }

  var deleted = purgeResponses(startDate, endDate);
  var count = deleted ? deleted.length : 0;

  return createUpdateResponse(buildTextCard(
    'Data Purged',
    'Deleted <b>' + count + '</b> standup responses from ' + startDate + ' to ' + endDate + '.'
  ));
}

// ---------------------------------------------------------------------------
// /set-this-space — capture the current space ID for the daily digest
// ---------------------------------------------------------------------------

/**
 * Slash command run from inside the team space where the digest should
 * post. Reads the space from the event itself, so the admin never has
 * to look up or copy a space ID.
 */
function handleSetThisSpace(event) {
  Logger.log('handleSetThisSpace invoked');

  var space = getEventSpace(event);
  if (!space || !space.name) {
    return buildTextCard(
      'Error',
      'Could not determine the current space ID. Run this command from inside the team space you want digests posted to.'
    );
  }

  // Refuse to set a DM as the digest space — that defeats the point.
  if (space.singleUserBotDm || space.type === 'DIRECT_MESSAGE') {
    return buildTextCard(
      'Wrong Place',
      'Run <code>/set-this-space</code> from your team space, not from this DM. The team space is where the daily digest gets posted.'
    );
  }

  updateSetting('STANDUP_SPACE_ID', space.name);

  var displayName = space.displayName || space.name;
  return buildTextCard(
    'Standup Space Set',
    'Daily digest will now post to <b>' + displayName + '</b>.\n\n'
    + 'Space ID: <code>' + space.name + '</code>\n\n'
    + 'Make sure Heubot is added as a member of this space.'
  );
}

// ---------------------------------------------------------------------------
// /digest-now [YYYY-MM-DD] — admin manual trigger for postDigest
// ---------------------------------------------------------------------------

/**
 * Manually triggers postDigest for a meeting date. Defaults to today.
 *
 * Useful when:
 *   - the 09:00 cron didn't fire (trigger quota, deploy issue, etc.)
 *   - testing the digest before the auto-cron is in place
 *   - reposting after fixing a bad submission
 *
 * Usage:
 *   /digest-now             — posts digest for today's meeting
 *   /digest-now 2026-04-13  — posts digest for that specific meeting
 */
function handleDigestNow(event) {
  Logger.log('handleDigestNow invoked');

  var text = (event.message && event.message.text) || '';
  var argMatch = text.match(/^\/\S+\s+(.+)$/);
  var requestedDate = argMatch ? argMatch[1].trim() : null;

  var meetingDate;
  if (requestedDate) {
    var match = requestedDate.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})$/);
    if (!match) {
      return buildTextCard('Invalid Date', 'Use YYYY-MM-DD or YYYY/MM/DD. Example: <code>/digest-now 2026-04-13</code>');
    }
    meetingDate = match[1] + '-' + match[2] + '-' + match[3];
  } else {
    meetingDate = getTodayDate();
  }

  var result = postDigest(meetingDate);

  if (result.reason === 'no-space') {
    return buildTextCard(
      'No Standup Space',
      'No team space configured for digests. Run <code>/set-this-space</code> from inside your team space to set one up.'
    );
  }
  if (!result.ok) {
    return buildTextCard('Digest Failed', 'Could not post digest: ' + result.reason);
  }
  if (result.responseCount === 0) {
    return buildTextCard(
      'Digest Posted (Empty)',
      'Posted the digest for ' + meetingDate + ', but no team members had submitted responses. The card lists everyone as "no response".'
    );
  }
  return buildTextCard(
    'Digest Posted',
    'Posted the digest for <b>' + meetingDate + '</b> with ' + result.responseCount
    + ' response' + (result.responseCount === 1 ? '' : 's') + ' to the configured team space.'
  );
}

// ---------------------------------------------------------------------------
// /standup [YYYY-MM-DD] — non-admin command, available to every member
// ---------------------------------------------------------------------------

/**
 * Slash command that opens the standup form in the caller's DM.
 *
 * Usage:
 *   /standup                    — uses the active standup date
 *                                 (today before DIGEST_TIME, otherwise next workday)
 *   /standup 2026-04-13         — fills the form for that specific date
 *   /standup 2026/04/13         — same, alternate format
 *
 * Past dates are rejected. The caller must already exist in
 * `team_members`, otherwise `handleStandupSubmit` will refuse the
 * submission later anyway.
 */
function handleStandup(event) {
  Logger.log('handleStandup invoked');
  captureChatUserId(event);

  var callerEmail = (event.user && event.user.email) || null;

  // Parse optional date argument: "/standup 2026-04-13"
  var text = (event.message && event.message.text) || '';
  var argMatch = text.match(/^\/\S+\s+(.+)$/);
  var requestedDate = argMatch ? argMatch[1].trim() : null;

  // Check for explicit --form flag: "/standup --form" or "/standup --form 2026-04-13"
  // This is the card-form fallback path.
  var useForm = false;
  if (requestedDate && requestedDate.indexOf('--form') > -1) {
    useForm = true;
    requestedDate = requestedDate.replace('--form', '').trim() || null;
  }

  // Card form fallback (/standup --form)
  if (useForm) {
    var standupDate;
    try {
      standupDate = resolveStandupDate(requestedDate);
    } catch (e) {
      return buildTextCard('Invalid Date', e.message);
    }
    var questions = getQuestions();
    if (questions.length === 0) {
      return buildTextCard('No Questions', 'No standup questions configured.');
    }
    var existingAnswers = null;
    var existing = getStandupResponse(standupDate, callerEmail);
    if (existing && existing.answers) {
      existingAnswers = existing.answers;
    }
    return buildStandupCard(questions, formatStandupDateLabel(standupDate), standupDate, existingAnswers);
  }

  // Default: conversational flow via shared helper.
  var result = beginStandupConversation(callerEmail, requestedDate);
  if (result.error) {
    return buildTextCard('Error', result.error);
  }
  return createTextResponse(result.introText);
}
