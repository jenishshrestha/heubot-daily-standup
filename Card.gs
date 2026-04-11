/**
 * Cards.gs — Card builders for Heubot
 *
 * Builds Google Chat Cards v2 for:
 * - Standup form (DM to team members)
 * - Confirmation reply (after submit)
 * - Reminder (for non-responders)
 * - Digest (posted to team space)
 * - Admin panels and dialogs
 */

// ---------------------------------------------------------------------------
// Standup Form Card (sent via DM)
// ---------------------------------------------------------------------------

/**
 * Builds a standup form card dynamically from questions in the DB.
 * @param {Array<Object>} questions - Array of { id, sort_order, question, required }
 * @param {string} dateLabel - Display date, e.g. "April 11, 2026"
 * @returns {Object} Google Chat Cards v2 message
 */
function buildStandupCard(questions, dateLabel) {
  var widgets = [];

  // Header info
  widgets.push({
    decoratedText: {
      topLabel: 'Standup for Tomorrow',
      text: dateLabel,
      startIcon: { knownIcon: 'DESCRIPTION' }
    }
  });

  widgets.push({ divider: {} });

  // Dynamic question fields
  questions.forEach(function(q) {
    widgets.push({
      textInput: {
        label: q.question,
        type: 'MULTIPLE_LINE',
        name: 'question_' + q.id,
        hintText: q.required ? 'Required' : 'Optional'
      }
    });
  });

  widgets.push({ divider: {} });

  // Submit button
  widgets.push({
    buttonList: {
      buttons: [{
        text: 'Submit Standup',
        onClick: {
          action: {
            function: 'handleStandupSubmit',
            parameters: [{
              key: 'questionIds',
              value: questions.map(function(q) { return q.id; }).join(',')
            }]
          }
        },
        color: {
          red: 0.0,
          green: 0.53,
          blue: 0.33,
          alpha: 1.0
        }
      }]
    }
  });

  return {
    cardsV2: [{
      cardId: 'standup-form',
      card: {
        header: {
          title: 'Heubot',
          subtitle: 'Daily Standup',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/checklist/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

// ---------------------------------------------------------------------------
// Confirmation Card (reply after submit)
// ---------------------------------------------------------------------------

/**
 * Builds a confirmation card shown after a successful standup submission.
 * @param {string} name - Team member's name
 * @returns {Object} Google Chat Cards v2 message
 */
function buildConfirmationCard(name) {
  return {
    cardsV2: [{
      cardId: 'standup-confirmation',
      card: {
        header: {
          title: 'Heubot',
          subtitle: 'Standup Recorded',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/check_circle/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{
          widgets: [{
            decoratedText: {
              topLabel: 'Thanks, ' + name + '!',
              text: 'Your standup has been recorded. It will appear in the daily digest.',
              startIcon: { knownIcon: 'STAR' }
            }
          }]
        }]
      }
    }]
  };
}

// ---------------------------------------------------------------------------
// Reminder Card (sent to non-responders)
// ---------------------------------------------------------------------------

/**
 * Builds a reminder card for team members who haven't submitted.
 * @returns {Object} Google Chat Cards v2 message
 */
function buildReminderCard() {
  return {
    cardsV2: [{
      cardId: 'standup-reminder',
      card: {
        header: {
          title: 'Heubot',
          subtitle: 'Reminder',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/notifications/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{
          widgets: [{
            decoratedText: {
              topLabel: 'Standup Pending',
              text: "Hey! You haven't submitted your standup yet. Please fill it in before the digest goes out.",
              startIcon: { knownIcon: 'CLOCK' }
            }
          }]
        }]
      }
    }]
  };
}

// ---------------------------------------------------------------------------
// Digest Card (posted to team space)
// ---------------------------------------------------------------------------

/**
 * Builds the daily digest card with per-person sections.
 * @param {Array<Object>} responses - Today's standup responses
 * @param {Array<Object>} questions - Questions list (for labels)
 * @param {Array<string>} nonResponders - Names of people who didn't respond
 * @param {string} dateLabel - Display date
 * @returns {Object} Google Chat Cards v2 message
 */
function buildDigestCard(responses, questions, nonResponders, dateLabel) {
  var sections = [];

  // Per-person sections
  responses.forEach(function(resp) {
    var widgets = [];

    // Answers
    questions.forEach(function(q) {
      var answer = resp.answers['question_' + q.id] || 'No response';
      widgets.push({
        decoratedText: {
          topLabel: q.question,
          text: answer,
          wrapText: true
        }
      });
    });

    // Jira tickets
    if (resp.jira_tickets && resp.jira_tickets.length > 0) {
      widgets.push({ divider: {} });
      widgets.push({
        decoratedText: {
          topLabel: 'Jira Tickets',
          text: resp.jira_tickets.map(function(t) {
            return getStatusEmoji(t.status) + ' <b>' + t.key + '</b> ' + t.summary + ' [' + t.status + ']';
          }).join('\n'),
          wrapText: true
        }
      });
    }

    sections.push({
      header: resp.name,
      widgets: widgets,
      collapsible: true,
      uncollapsibleWidgetsCount: 1
    });
  });

  // Non-responders section
  if (nonResponders.length > 0) {
    sections.push({
      widgets: [{
        decoratedText: {
          topLabel: 'No Response',
          text: nonResponders.join(', '),
          startIcon: { knownIcon: 'PERSON' },
          wrapText: true
        }
      }]
    });
  }

  return {
    cardsV2: [{
      cardId: 'standup-digest',
      card: {
        header: {
          title: 'Heubot — Daily Standup',
          subtitle: dateLabel,
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/summarize/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: sections
      }
    }]
  };
}

// ---------------------------------------------------------------------------
// Admin Cards
// ---------------------------------------------------------------------------

/**
 * Builds the settings overview card.
 * @param {Object} settings - Key-value settings from DB
 * @param {number} teamSize - Number of active team members
 * @param {number} questionCount - Number of questions
 * @returns {Object} Google Chat Cards v2 message
 */
function buildSettingsCard(settings, teamSize, questionCount) {
  return {
    cardsV2: [{
      cardId: 'admin-settings',
      card: {
        header: {
          title: 'Heubot Settings',
          subtitle: 'Current Configuration',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/settings/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{
          widgets: [
            { decoratedText: { topLabel: 'Prompt time', text: settings['PROMPT_TIME'] || 'Not set' } },
            { decoratedText: { topLabel: 'Reminder time', text: settings['REMINDER_TIME'] || 'Not set' } },
            { decoratedText: { topLabel: 'Digest time', text: settings['DIGEST_TIME'] || 'Not set' } },
            { decoratedText: { topLabel: 'Standup space', text: settings['STANDUP_SPACE_ID'] || 'Not set' } },
            { decoratedText: { topLabel: 'Jira project', text: settings['JIRA_PROJECT'] || 'Not set' } },
            { decoratedText: { topLabel: 'Team size', text: teamSize + ' members' } },
            { decoratedText: { topLabel: 'Questions', text: questionCount + '' } },
            { divider: {} },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Edit Schedule',
                    onClick: { action: { function: 'handleShowScheduleDialog' } }
                  },
                  {
                    text: 'Edit Questions',
                    onClick: { action: { function: 'handleShowQuestions' } }
                  }
                ]
              }
            }
          ]
        }]
      }
    }]
  };
}

/**
 * Builds the schedule edit dialog.
 * @param {Object} settings - Current settings
 * @returns {Object} Dialog action response
 */
function buildScheduleDialog(settings) {
  return {
    cardsV2: [{
      cardId: 'edit-schedule',
      card: {
        header: {
          title: 'Heubot',
          subtitle: 'Update Schedule',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/schedule/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{
          widgets: [
            {
              textInput: {
                label: 'Prompt time (HH:MM, 24h)',
                type: 'SINGLE_LINE',
                name: 'prompt_time',
                value: settings['PROMPT_TIME'] || '16:45'
              }
            },
            {
              textInput: {
                label: 'Reminder time (HH:MM, 24h)',
                type: 'SINGLE_LINE',
                name: 'reminder_time',
                value: settings['REMINDER_TIME'] || '17:15'
              }
            },
            {
              textInput: {
                label: 'Digest time (HH:MM, 24h)',
                type: 'SINGLE_LINE',
                name: 'digest_time',
                value: settings['DIGEST_TIME'] || '17:30'
              }
            },
            { divider: {} },
            {
              buttonList: {
                buttons: [{
                  text: 'Save',
                  onClick: {
                    action: { function: 'handleSaveSchedule' }
                  },
                  color: { red: 0.0, green: 0.53, blue: 0.33, alpha: 1.0 }
                }]
              }
            }
          ]
        }]
      }
    }]
  };
}

/**
 * Builds the questions management card.
 * @param {Array<Object>} questions - Current questions
 * @returns {Object} Google Chat Cards v2 message
 */
function buildQuestionsCard(questions) {
  var widgets = [];

  questions.forEach(function(q, index) {
    widgets.push({
      decoratedText: {
        topLabel: 'Q' + q.sort_order + (q.required ? ' (Required)' : ' (Optional)'),
        text: q.question,
        wrapText: true,
        button: {
          text: 'Remove',
          onClick: {
            action: {
              function: 'handleRemoveQuestion',
              parameters: [{ key: 'questionId', value: q.id }]
            }
          },
          color: { red: 0.8, green: 0.0, blue: 0.0, alpha: 1.0 }
        }
      }
    });
  });

  widgets.push({ divider: {} });
  widgets.push({
    buttonList: {
      buttons: [{
        text: 'Add Question',
        onClick: { action: { function: 'handleShowAddQuestionDialog' } }
      }]
    }
  });

  return {
    cardsV2: [{
      cardId: 'admin-questions',
      card: {
        header: {
          title: 'Heubot — Questions',
          subtitle: questions.length + ' questions configured',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/help/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

/**
 * Builds the add question dialog.
 * @param {number} nextOrder - The next sort_order value
 * @returns {Object} Dialog action response
 */
function buildAddQuestionDialog(nextOrder) {
  return {
    cardsV2: [{
      cardId: 'add-question',
      card: {
        header: {
          title: 'Heubot',
          subtitle: 'Add New Question',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/add_circle/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{
          widgets: [
            {
              textInput: {
                label: 'Question text',
                type: 'SINGLE_LINE',
                name: 'question_text'
              }
            },
            {
              selectionInput: {
                type: 'CHECK_BOX',
                label: 'Required',
                name: 'question_required',
                items: [{
                  text: 'This question is required',
                  value: 'true',
                  selected: true
                }]
              }
            },
            { divider: {} },
            {
              buttonList: {
                buttons: [{
                  text: 'Add',
                  onClick: {
                    action: {
                      function: 'handleAddQuestion',
                      parameters: [{ key: 'nextOrder', value: nextOrder + '' }]
                    }
                  },
                  color: { red: 0.0, green: 0.53, blue: 0.33, alpha: 1.0 }
                }]
              }
            }
          ]
        }]
      }
    }]
  };
}

/**
 * Builds the team members card.
 * @param {Array<Object>} members - Team members
 * @returns {Object} Google Chat Cards v2 message
 */
function buildTeamCard(members) {
  var widgets = [];

  members.forEach(function(m) {
    widgets.push({
      decoratedText: {
        topLabel: m.name + (m.active ? '' : ' (Inactive)'),
        text: m.email + (m.jira_username ? ' | Jira: ' + m.jira_username : ''),
        wrapText: true,
        button: {
          text: m.active ? 'Remove' : 'Activate',
          onClick: {
            action: {
              function: m.active ? 'handleRemoveMember' : 'handleActivateMember',
              parameters: [{ key: 'email', value: m.email }]
            }
          }
        }
      }
    });
  });

  widgets.push({ divider: {} });
  widgets.push({
    buttonList: {
      buttons: [{
        text: 'Add Member',
        onClick: { action: { function: 'handleShowAddMemberDialog' } }
      }]
    }
  });

  return {
    cardsV2: [{
      cardId: 'admin-team',
      card: {
        header: {
          title: 'Heubot — Team',
          subtitle: members.filter(function(m) { return m.active; }).length + ' active members',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/group/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

/**
 * Builds the add member dialog.
 * @returns {Object} Dialog action response
 */
function buildAddMemberDialog() {
  return {
    cardsV2: [{
      cardId: 'add-member',
      card: {
        header: {
          title: 'Heubot',
          subtitle: 'Add Team Member',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/person_add/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{
          widgets: [
            {
              textInput: {
                label: 'Name',
                type: 'SINGLE_LINE',
                name: 'member_name'
              }
            },
            {
              textInput: {
                label: 'Email',
                type: 'SINGLE_LINE',
                name: 'member_email'
              }
            },
            {
              textInput: {
                label: 'Jira Username (optional)',
                type: 'SINGLE_LINE',
                name: 'member_jira'
              }
            },
            { divider: {} },
            {
              buttonList: {
                buttons: [{
                  text: 'Add',
                  onClick: {
                    action: { function: 'handleAddMember' }
                  },
                  color: { red: 0.0, green: 0.53, blue: 0.33, alpha: 1.0 }
                }]
              }
            }
          ]
        }]
      }
    }]
  };
}

/**
 * Builds a simple text response card.
 * @param {string} title - Card title
 * @param {string} message - Message text
 * @returns {Object} Google Chat Cards v2 message
 */
function buildTextCard(title, message) {
  return {
    cardsV2: [{
      cardId: 'text-response',
      card: {
        header: {
          title: 'Heubot',
          subtitle: title,
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/info/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{
          widgets: [{
            textParagraph: { text: message }
          }]
        }]
      }
    }]
  };
}

/**
 * Builds the today's status card.
 * @param {Array<Object>} responded - People who responded
 * @param {Array<Object>} pending - People who haven't responded
 * @returns {Object} Google Chat Cards v2 message
 */
function buildStatusCard(responded, pending) {
  var widgets = [];

  if (responded.length > 0) {
    widgets.push({
      decoratedText: {
        topLabel: 'Responded (' + responded.length + ')',
        text: responded.map(function(r) { return r.name; }).join(', '),
        startIcon: { knownIcon: 'STAR' },
        wrapText: true
      }
    });
  }

  if (pending.length > 0) {
    widgets.push({
      decoratedText: {
        topLabel: 'Pending (' + pending.length + ')',
        text: pending.map(function(p) { return p.name; }).join(', '),
        startIcon: { knownIcon: 'CLOCK' },
        wrapText: true
      }
    });
  }

  if (responded.length === 0 && pending.length === 0) {
    widgets.push({
      textParagraph: { text: 'No standup data for today yet.' }
    });
  }

  return {
    cardsV2: [{
      cardId: 'admin-status',
      card: {
        header: {
          title: 'Heubot — Today\'s Status',
          subtitle: responded.length + ' responded, ' + pending.length + ' pending',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/monitoring/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

/**
 * Builds the purge confirmation dialog.
 * @returns {Object} Dialog action response
 */
function buildPurgeDialog() {
  return {
    cardsV2: [{
      cardId: 'purge-data',
      card: {
        header: {
          title: 'Heubot',
          subtitle: 'Purge Standup Data',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/delete/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{
          widgets: [
            {
              textParagraph: {
                text: '<b>Warning:</b> This permanently deletes standup responses in the given date range. This cannot be undone.'
              }
            },
            {
              textInput: {
                label: 'Start date (YYYY-MM-DD)',
                type: 'SINGLE_LINE',
                name: 'purge_start'
              }
            },
            {
              textInput: {
                label: 'End date (YYYY-MM-DD)',
                type: 'SINGLE_LINE',
                name: 'purge_end'
              }
            },
            { divider: {} },
            {
              buttonList: {
                buttons: [{
                  text: 'Delete Data',
                  onClick: {
                    action: { function: 'handlePurge' }
                  },
                  color: { red: 0.8, green: 0.0, blue: 0.0, alpha: 1.0 }
                }]
              }
            }
          ]
        }]
      }
    }]
  };
}
