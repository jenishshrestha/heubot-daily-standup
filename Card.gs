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
 *
 * The Submit button embeds the meeting date as an action parameter so
 * `handleStandupSubmit` upserts the response under the correct date —
 * works for both "today's meeting" pre-submissions and explicit-date
 * backfills via `/standup YYYY-MM-DD`.
 *
 * If `existingAnswers` is provided, the card behaves as an EDIT form:
 * each text input is pre-filled with the saved value, the subtitle
 * changes to "Edit your standup", and the submit button reads "Update
 * Standup". Members can edit their submission any time before the
 * morning digest because `handleStandupSubmit` upserts on (date, email).
 *
 * @param {Array<Object>} questions       - { id, sort_order, question, required }
 * @param {string} dateLabel              - Display date, e.g. "Monday, April 13, 2026"
 * @param {string} standupDate            - YYYY-MM-DD meeting date this form is for
 * @param {Object} [existingAnswers]      - Map of "question_<id>" → string, from a prior submission
 * @returns {Object} Google Chat Cards v2 message
 */
function buildStandupCard(questions, dateLabel, standupDate, existingAnswers) {
  var isEditing = !!(existingAnswers && Object.keys(existingAnswers).length > 0);
  var widgets = [];

  widgets.push({
    decoratedText: {
      topLabel: 'Standup for',
      text: dateLabel,
      startIcon: { knownIcon: 'DESCRIPTION' }
    }
  });

  widgets.push({ divider: {} });

  questions.forEach(function(q) {
    var inputKey = 'question_' + q.id;
    var input = {
      label: q.question,
      type: 'MULTIPLE_LINE',
      name: inputKey,
      hintText: q.required ? 'Required' : 'Optional'
    };
    if (existingAnswers && existingAnswers[inputKey]) {
      input.value = existingAnswers[inputKey];
    }
    widgets.push({ textInput: input });
  });

  widgets.push({ divider: {} });

  widgets.push({
    buttonList: {
      buttons: [{
        text: isEditing ? 'Update Standup' : 'Submit Standup',
        onClick: {
          action: {
            function: 'handleStandupSubmit',
            parameters: [
              {
                key: 'questionIds',
                value: questions.map(function(q) { return q.id; }).join(',')
              },
              {
                key: 'standupDate',
                value: standupDate || ''
              }
            ]
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
          subtitle: isEditing ? 'Edit your standup' : 'Daily Standup',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/checklist/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

/**
 * Builds the small notification card sent at PROMPT_TIME to nudge each
 * member to fill their standup. The "Fill Standup" button transforms
 * the notification into the full form (via `handleShowStandupForm`)
 * without leaving the chat — no need to type `/standup` manually.
 *
 * When `opts.broadcastNote` is set, an italic footer line is appended
 * (e.g. "Notified 14 other team members."). This lets the same card
 * serve double duty as both the personal nudge and the response to
 * `/notify-all` for the admin who triggered the broadcast.
 *
 * @param {string} dateLabel     - Display date for the upcoming meeting
 * @param {string} standupDate   - YYYY-MM-DD for that meeting
 * @param {Object} [opts]
 * @param {string} [opts.broadcastNote] - Optional footer text shown in italics
 * @returns {Object} Google Chat Cards v2 message
 */
function buildStandupNotificationCard(dateLabel, standupDate, opts) {
  opts = opts || {};

  var widgets = [
    {
      decoratedText: {
        topLabel: 'Standup for',
        text: dateLabel,
        startIcon: { knownIcon: 'DESCRIPTION' },
        wrapText: true
      }
    },
    {
      textParagraph: {
        text: 'Tap <b>Fill Standup</b> below, or run <code>/standup</code> any time before tomorrow morning\'s digest.'
      }
    },
    {
      buttonList: {
        buttons: [{
          text: 'Fill Standup',
          onClick: {
            action: {
              function: 'handleShowStandupForm',
              parameters: [{
                key: 'standupDate',
                value: standupDate || ''
              }]
            }
          },
          color: { red: 0.0, green: 0.53, blue: 0.33, alpha: 1.0 }
        }]
      }
    }
  ];

  if (opts.broadcastNote) {
    widgets.push({ divider: {} });
    widgets.push({
      textParagraph: { text: '<i>' + opts.broadcastNote + '</i>' }
    });
  }

  return {
    cardsV2: [{
      cardId: 'standup-notification',
      card: {
        header: {
          title: 'Heubot',
          subtitle: 'Time to fill your standup',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/notifications/default/48px.svg',
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
// Digest Cards (posted to team space)
//
// The digest is posted in two parts:
//   1. A small SUMMARY card as the main message in the team space
//      (response count + responders + non-responders).
//   2. One per-person REPLY card per response, posted as a thread reply
//      under the summary message.
//
// This keeps the channel uncluttered (one main message visible in the
// channel feed) while letting anyone expand the thread to read each
// person's standup individually. Modeled on DailyBot's pattern.
// ---------------------------------------------------------------------------

/**
 * Builds the small summary card that opens the digest thread. Contains
 * just the response counts and lists of responders / non-responders.
 *
 * @param {Array<Object>} responders     - Array of { name } that submitted
 * @param {Array<string>} nonResponders  - Names of people who didn't respond
 * @param {string} dateLabel             - Display date for the meeting
 * @returns {Object} Google Chat Cards v2 message
 */
function buildDigestSummaryCard(responders, nonResponders, dateLabel) {
  var totalCount = responders.length + nonResponders.length;
  var widgets = [];

  widgets.push({
    decoratedText: {
      topLabel: 'Daily Standup',
      text: dateLabel,
      startIcon: { knownIcon: 'DESCRIPTION' },
      wrapText: true
    }
  });

  widgets.push({
    decoratedText: {
      topLabel: 'Responses',
      text: '<b>' + responders.length + '</b> of ' + totalCount + ' members',
      startIcon: { knownIcon: 'STAR' },
      wrapText: true
    }
  });

  if (responders.length > 0) {
    widgets.push({
      decoratedText: {
        topLabel: 'Responded',
        text: responders.map(function(r) { return r.name; }).join(', '),
        wrapText: true
      }
    });
  }

  if (nonResponders.length > 0) {
    widgets.push({
      decoratedText: {
        topLabel: 'No Response',
        text: nonResponders.join(', '),
        startIcon: { knownIcon: 'PERSON' },
        wrapText: true
      }
    });
  }

  if (responders.length > 0) {
    widgets.push({
      textParagraph: {
        text: '<i>Open the thread to read each member\'s update.</i>'
      }
    });
  }

  return {
    cardsV2: [{
      cardId: 'standup-digest-summary',
      card: {
        header: {
          title: 'Heubot — Daily Standup',
          subtitle: dateLabel,
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/summarize/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

/**
 * Builds a per-person reply card containing one member's standup
 * answers and Jira tickets. Posted as a thread reply under the summary
 * card via `botMessageCreateInThread`.
 *
 * @param {Object} response   - { name, email, answers, jira_tickets, ... }
 * @param {Array<Object>} questions - Question list (for labels)
 * @returns {Object} Google Chat Cards v2 message
 */
function buildDigestReplyCard(response, questions) {
  var widgets = [];

  questions.forEach(function(q) {
    var raw = response.answers['question_' + q.id];
    var answer = raw ? formatChatMarkdownToHtml(raw) : '<i>No response</i>';
    widgets.push({
      decoratedText: {
        topLabel: q.question,
        text: answer,
        wrapText: true
      }
    });
  });

  if (response.jira_tickets && response.jira_tickets.length > 0) {
    widgets.push({ divider: {} });
    widgets.push({
      decoratedText: {
        topLabel: 'Jira Tickets',
        text: response.jira_tickets.map(function(t) {
          // Wrap the key in <a href> so it opens the ticket in Jira
          // when clicked. Fall back to plain bold if the row is from
          // an older submission that didn't capture the URL.
          var keyHtml = t.url
            ? '<a href="' + t.url + '"><b>' + t.key + '</b></a>'
            : '<b>' + t.key + '</b>';
          return getStatusEmoji(t.status) + ' ' + keyHtml + ' ' + t.summary + ' [' + t.status + ']';
        }).join('\n'),
        wrapText: true
      }
    });
  }

  return {
    cardsV2: [{
      cardId: 'standup-digest-reply',
      card: {
        header: {
          title: response.name,
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/account_circle/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: [{ widgets: widgets }]
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
                value: settings['DIGEST_TIME'] || '09:00'
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
 * Builds the standup status card.
 * @param {Array<Object>} responded - People who responded
 * @param {Array<Object>} pending - People who haven't responded
 * @param {string} [meetingLabel] - Human label for the meeting being reported on
 *                                  (e.g. "Tuesday, January 14, 2026"). Shown as the
 *                                  card subtitle so admins know which meeting this is.
 * @returns {Object} Google Chat Cards v2 message
 */
function buildStatusCard(responded, pending, meetingLabel) {
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
      textParagraph: { text: 'No standup responses recorded for this meeting yet.' }
    });
  }

  var subtitle = meetingLabel
    ? meetingLabel + ' — ' + responded.length + ' responded, ' + pending.length + ' pending'
    : responded.length + ' responded, ' + pending.length + ' pending';

  return {
    cardsV2: [{
      cardId: 'admin-status',
      card: {
        header: {
          title: 'Heubot — Standup Status',
          subtitle: subtitle,
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

/**
 * Converts the Chat-flavored markdown users type in the rich editor to
 * the HTML subset that Cards v2 decoratedText supports.
 *
 * Handles:
 *   *bold*         → <b>bold</b>
 *   _italic_       → <i>italic</i>
 *   ~strike~       → <s>strike</s>
 *   `code`         → <code>code</code>
 *   newlines       → <br>
 *   literal <, >, & in the user text are escaped first so they render
 *   as text (not break the card layout).
 */
function formatChatMarkdownToHtml(text) {
  if (!text) return '';
  var out = String(text);

  out = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  out = out.replace(/(^|[\s(>])\*([^*\n]+?)\*(?=[\s).,!?:;<]|$)/g, '$1<b>$2</b>');
  out = out.replace(/(^|[\s(>])_([^_\n]+?)_(?=[\s).,!?:;<]|$)/g, '$1<i>$2</i>');
  out = out.replace(/(^|[\s(>])~([^~\n]+?)~(?=[\s).,!?:;<]|$)/g, '$1<s>$2</s>');

  out = out.replace(/\r\n|\r|\n/g, '<br>');

  return out;
}
