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
 *   /trigger-now      — Manually trigger standup collection
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

  // Check admin access
  if (!isAdmin(user.email)) {
    return createCardResponse(buildTextCard('Access Denied', 'Sorry, only admins can use this command. Contact an admin to get access.'));
  }

  // Route by command ID
  // Command IDs are assigned when registering slash commands in GCP
  var result;
  switch (commandId) {
    case '1':  result = handleSettings(event); break;
    case '2':  result = handleSetSchedule(event); break;
    case '3':  result = handleQuestions(event); break;
    case '4':  result = handleShowAddQuestionCmd(event); break;
    case '5':  result = handleTeam(event); break;
    case '6':  result = handleShowAddMemberCmd(event); break;
    case '7':  result = handleTriggerNow(event); break;
    case '8':  result = handleStatus(event); break;
    case '9':  result = handlePurgeCmd(event); break;
    default:   result = buildTextCard('Unknown Command', 'Command ID ' + commandId + ' is not recognized.');
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
  return createNavResponse(buildScheduleDialog(settings));
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
      return createNavResponse(buildTextCard(
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

    return createNavResponse(buildTextCard(
      'Schedule Updated',
      'New schedule:\n'
      + '• Prompt: ' + promptTime + '\n'
      + '• Reminder: ' + reminderTime + '\n'
      + '• Digest: ' + digestTime + '\n\n'
      + triggerNote
    ));
  } catch (e) {
    Logger.log('handleSaveSchedule error: ' + e.message + '\n' + e.stack);
    return createNavResponse(buildTextCard(
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
  return createNavResponse(buildQuestionsCard(questions));
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
  return createNavResponse(buildAddQuestionDialog(nextOrder));
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
    return createNavResponse(buildTextCard('Error', 'Question text cannot be empty.'));
  }

  addQuestion(nextOrder, questionText.trim(), isRequired);
  return createNavResponse(buildTextCard('Question Added', 'New question added: "' + questionText.trim() + '"'));
}

function handleRemoveQuestion(event) {
  Logger.log('handleRemoveQuestion invoked');
  var params = getParams(event);
  var questionId = params.questionId;

  deleteQuestion(questionId);

  var questions = getQuestions();
  if (questions.length === 0) {
    return createNavResponse(buildTextCard('Questions', 'All questions have been removed. Use /add-question to add new ones.'));
  }
  return createNavResponse(buildQuestionsCard(questions));
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
  return createNavResponse(buildTeamCard(members));
}

function handleShowAddMemberCmd(event) {
  return buildAddMemberDialog();
}

function handleShowAddMemberDialog(event) {
  Logger.log('handleShowAddMemberDialog invoked');
  return createNavResponse(buildAddMemberDialog());
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
    return createNavResponse(buildTextCard('Error', 'Name and email are required.'));
  }

  try {
    addTeamMember(name.trim(), email.trim(), jiraUsername.trim());
    return createNavResponse(buildTextCard('Member Added', name.trim() + ' (' + email.trim() + ') has been added to the team.'));
  } catch (e) {
    if (e.message && e.message.indexOf('duplicate') > -1) {
      return createNavResponse(buildTextCard('Error', 'A member with email ' + email.trim() + ' already exists.'));
    }
    return createNavResponse(buildTextCard('Error', 'Failed to add member: ' + e.message));
  }
}

function handleRemoveMember(event) {
  Logger.log('handleRemoveMember invoked');
  var params = getParams(event);
  var email = params.email;

  removeTeamMember(email);

  var members = getAllTeamMembers();
  return createNavResponse(buildTeamCard(members));
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
  return createNavResponse(buildTeamCard(members));
}

// ---------------------------------------------------------------------------
// /trigger-now
// ---------------------------------------------------------------------------

function handleTriggerNow(event) {
  sendStandupCards();
  return buildTextCard('Triggered', 'Standup cards have been sent to all active team members.');
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

function handleStatus(event) {
  var today = getTodayDate();
  var responses = getTodaysResponses(today);
  var members = getActiveTeamMembers();

  var respondedEmails = responses.map(function(r) { return r.email; });

  var responded = members.filter(function(m) {
    return respondedEmails.indexOf(m.email) > -1;
  });

  var pending = members.filter(function(m) {
    return respondedEmails.indexOf(m.email) === -1;
  });

  return buildStatusCard(responded, pending);
}

// ---------------------------------------------------------------------------
// /purge
// ---------------------------------------------------------------------------

function handlePurgeCmd(event) {
  return buildPurgeDialog();
}

function handleShowPurgeDialog(event) {
  Logger.log('handleShowPurgeDialog invoked');
  return createNavResponse(buildPurgeDialog());
}

function handlePurge(event) {
  Logger.log('handlePurge invoked');
  var formInputs = getFormInputs(event);

  var startDate = formInputs.purge_start.stringInputs.value[0];
  var endDate = formInputs.purge_end.stringInputs.value[0];

  var dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    return createNavResponse(buildTextCard('Invalid Date', 'Please use YYYY-MM-DD format. Example: 2025-01-01'));
  }

  if (startDate > endDate) {
    return createNavResponse(buildTextCard('Invalid Range', 'Start date must be before end date.'));
  }

  var deleted = purgeResponses(startDate, endDate);
  var count = deleted ? deleted.length : 0;

  return createNavResponse(buildTextCard(
    'Data Purged',
    'Deleted <b>' + count + '</b> standup responses from ' + startDate + ' to ' + endDate + '.'
  ));
}
