/**
 * Jira.gs — Jira REST API integration for Heubot
 *
 * Fetches active tickets assigned to a team member.
 * Uses Basic Auth (email + API token).
 *
 * Required Script Properties:
 *   JIRA_EMAIL     — Jira account email (e.g. jenish@heubert.com)
 *   JIRA_API_TOKEN — Jira API token (generate at https://id.atlassian.com/manage-profile/security/api-tokens)
 *
 * Required Supabase settings:
 *   JIRA_DOMAIN    — e.g. heubert.atlassian.net
 */

/**
 * Fetches active Jira tickets assigned to a user.
 * @param {string} email - The team member's email (used as Jira assignee)
 * @returns {Array<Object>} Array of { key, summary, status, url }
 */
function fetchJiraTickets(email) {
  var props = PropertiesService.getScriptProperties();
  var jiraEmail = props.getProperty('JIRA_EMAIL');
  var jiraToken = props.getProperty('JIRA_API_TOKEN');

  if (!jiraEmail || !jiraToken) {
    Logger.log('Missing JIRA_EMAIL or JIRA_API_TOKEN in Script Properties');
    return [];
  }

  var settings = getAllSettings();
  var domain = settings['JIRA_DOMAIN'];

  if (!domain) {
    Logger.log('Missing JIRA_DOMAIN in settings');
    return [];
  }

  var auth = Utilities.base64Encode(jiraEmail + ':' + jiraToken);

  var jql = 'assignee = "' + email + '" AND statusCategory != Done ORDER BY updated DESC';

  var url = 'https://' + domain + '/rest/api/3/search/jql'
    + '?jql=' + encodeURIComponent(jql)
    + '&fields=key,summary,status'
    + '&maxResults=50';

  var response = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    Logger.log('Jira API error (' + code + '): ' + response.getContentText());
    return [];
  }

  var data = JSON.parse(response.getContentText());
  var tickets = [];

  if (data.issues) {
    data.issues.forEach(function(issue) {
      tickets.push({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        url: 'https://' + domain + '/browse/' + issue.key
      });
    });
  }

  return tickets;
}

/**
 * Returns a status emoji based on Jira status name.
 * @param {string} status - Jira status name
 * @returns {string} Emoji
 */
function getStatusEmoji(status) {
  var lower = status.toLowerCase();
  if (lower === 'in progress' || lower === 'in development') return '🔵';
  if (lower === 'in review' || lower === 'code review') return '🟡';
  if (lower === 'to do' || lower === 'open' || lower === 'backlog') return '⚪';
  if (lower === 'done' || lower === 'closed') return '🟢';
  return '⚫';
}

/**
 * Verifies the configured Jira credentials still work.
 * Used by the digest to surface a "token expired" alert in the team space.
 *
 * @returns {{ok: true}} when the token authenticates
 * @returns {{ok: false, code: number, message: string}} when it doesn't
 */
function checkJiraTokenHealth() {
  var props = PropertiesService.getScriptProperties();
  var jiraEmail = props.getProperty('JIRA_EMAIL');
  var jiraToken = props.getProperty('JIRA_API_TOKEN');

  if (!jiraEmail || !jiraToken) {
    return { ok: false, code: 0, message: 'JIRA_EMAIL or JIRA_API_TOKEN not set in Script Properties' };
  }

  var domain = getAllSettings()['JIRA_DOMAIN'];
  if (!domain) {
    return { ok: false, code: 0, message: 'JIRA_DOMAIN not set in Supabase settings' };
  }

  var auth = Utilities.base64Encode(jiraEmail + ':' + jiraToken);
  var response = UrlFetchApp.fetch('https://' + domain + '/rest/api/3/myself', {
    method: 'GET',
    headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' },
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code === 200) return { ok: true };
  if (code === 401 || code === 403) {
    return { ok: false, code: code, message: 'Jira token expired or revoked' };
  }
  return { ok: false, code: code, message: 'Jira auth check failed: HTTP ' + code };
}

// ---------------------------------------------------------------------------
// Test function — run from Apps Script editor
// ---------------------------------------------------------------------------

function testFetchJiraTickets() {
  // Replace with your actual email to test
  var email = 'jenish@heubert.com';
  var tickets = fetchJiraTickets(email);

  if (tickets.length === 0) {
    Logger.log('No active tickets found for ' + email + ' (or Jira not configured yet)');
  } else {
    Logger.log('Found ' + tickets.length + ' tickets for ' + email + ':');
    tickets.forEach(function(t) {
      Logger.log(getStatusEmoji(t.status) + ' ' + t.key + ' — ' + t.summary + ' [' + t.status + ']');
    });
  }
}
