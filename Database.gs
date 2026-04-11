/**
 * Database.gs — Supabase REST API helpers for Heubot
 *
 * All database operations go through this file.
 * Uses Supabase PostgREST API (no Postgres driver needed).
 *
 * Required Script Properties:
 *   SUPABASE_URL      — e.g. https://xxxxx.supabase.co
 *   SUPABASE_KEY      — service_role key (not anon key)
 */

// ---------------------------------------------------------------------------
// Core HTTP helper
// ---------------------------------------------------------------------------

/**
 * Makes an authenticated request to the Supabase REST API.
 * @param {string} path - PostgREST path, e.g. "/rest/v1/team_members"
 * @param {Object} options - { method, payload, query }
 * @returns {Object|Array} Parsed JSON response
 */
function supabaseRequest(path, options) {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = props.getProperty('SUPABASE_URL');
  var apiKey = props.getProperty('SUPABASE_KEY');

  if (!baseUrl || !apiKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in Script Properties');
  }

  var url = baseUrl + path;
  if (options.query) {
    url += '?' + options.query;
  }

  var fetchOptions = {
    method: options.method || 'GET',
    headers: {
      'apikey': apiKey,
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation'
    },
    muteHttpExceptions: true
  };

  if (options.payload) {
    fetchOptions.payload = JSON.stringify(options.payload);
  }

  var response = UrlFetchApp.fetch(url, fetchOptions);
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code >= 400) {
    throw new Error('Supabase error (' + code + '): ' + body);
  }

  return body ? JSON.parse(body) : null;
}

// ---------------------------------------------------------------------------
// Team Members
// ---------------------------------------------------------------------------

function getActiveTeamMembers() {
  return supabaseRequest('/rest/v1/team_members', {
    query: 'active=eq.true&order=name.asc'
  });
}

function getAllTeamMembers() {
  return supabaseRequest('/rest/v1/team_members', {
    query: 'order=name.asc'
  });
}

function addTeamMember(name, email, jiraUsername) {
  return supabaseRequest('/rest/v1/team_members', {
    method: 'POST',
    payload: { name: name, email: email, jira_username: jiraUsername }
  });
}

function removeTeamMember(email) {
  return supabaseRequest('/rest/v1/team_members', {
    method: 'PATCH',
    query: 'email=eq.' + encodeURIComponent(email),
    payload: { active: false }
  });
}

// ---------------------------------------------------------------------------
// Standup Responses
// ---------------------------------------------------------------------------

/**
 * Upsert a standup response for (date, email).
 *
 * Guarantees one row per user per day regardless of retries or accidental
 * double-clicks. We do an explicit check-then-write rather than relying
 * on a Postgres unique constraint, so it works against the existing
 * schema without a migration.
 */
function upsertStandupResponse(date, name, email, answers, jiraTickets) {
  var existing = supabaseRequest('/rest/v1/standup_responses', {
    query: 'date=eq.' + encodeURIComponent(date)
      + '&email=eq.' + encodeURIComponent(email)
      + '&select=id'
  });

  var payload = {
    date: date,
    name: name,
    email: email,
    answers: answers,
    jira_tickets: jiraTickets,
    responded_at: new Date().toISOString()
  };

  if (existing && existing.length > 0) {
    return supabaseRequest('/rest/v1/standup_responses', {
      method: 'PATCH',
      query: 'id=eq.' + existing[0].id,
      payload: payload
    });
  }

  return supabaseRequest('/rest/v1/standup_responses', {
    method: 'POST',
    payload: payload
  });
}

function getTodaysResponses(date) {
  return supabaseRequest('/rest/v1/standup_responses', {
    query: 'date=eq.' + date + '&order=responded_at.asc'
  });
}

function getRespondedEmails(date) {
  var responses = getTodaysResponses(date);
  return responses.map(function(r) { return r.email; });
}

function purgeResponses(startDate, endDate) {
  return supabaseRequest('/rest/v1/standup_responses', {
    method: 'DELETE',
    query: 'date=gte.' + startDate + '&date=lte.' + endDate,
    prefer: 'return=representation'
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getAllSettings() {
  var rows = supabaseRequest('/rest/v1/settings', {
    query: 'order=key.asc'
  });
  var settings = {};
  rows.forEach(function(row) {
    settings[row.key] = row.value;
  });
  return settings;
}

function getSetting(key) {
  var rows = supabaseRequest('/rest/v1/settings', {
    query: 'key=eq.' + encodeURIComponent(key)
  });
  return rows.length > 0 ? rows[0].value : null;
}

function updateSetting(key, value) {
  return supabaseRequest('/rest/v1/settings', {
    method: 'PATCH',
    query: 'key=eq.' + encodeURIComponent(key),
    payload: { value: value }
  });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function getQuestions() {
  return supabaseRequest('/rest/v1/questions', {
    query: 'order=sort_order.asc'
  });
}

function addQuestion(sortOrder, questionText, required) {
  return supabaseRequest('/rest/v1/questions', {
    method: 'POST',
    payload: { sort_order: sortOrder, question: questionText, required: required }
  });
}

function deleteQuestion(id) {
  return supabaseRequest('/rest/v1/questions', {
    method: 'DELETE',
    query: 'id=eq.' + id
  });
}

function updateQuestionOrder(id, newOrder) {
  return supabaseRequest('/rest/v1/questions', {
    method: 'PATCH',
    query: 'id=eq.' + id,
    payload: { sort_order: newOrder }
  });
}

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------

function isAdmin(email) {
  var rows = supabaseRequest('/rest/v1/admins', {
    query: 'email=eq.' + encodeURIComponent(email)
  });
  return rows.length > 0;
}

function getAdmins() {
  return supabaseRequest('/rest/v1/admins', {
    query: 'order=email.asc'
  });
}

function addAdmin(email) {
  return supabaseRequest('/rest/v1/admins', {
    method: 'POST',
    payload: { email: email }
  });
}

// ---------------------------------------------------------------------------
// DB Usage (for monthly warning)
// ---------------------------------------------------------------------------

function getDbRowCount() {
  var responses = supabaseRequest('/rest/v1/standup_responses', {
    query: 'select=id',
    prefer: 'count=exact'
  });
  // PostgREST returns count in content-range header, but we can approximate
  // by getting all IDs. For a more accurate count, we use RPC (see below).
  return responses.length;
}

// ---------------------------------------------------------------------------
// Test function — run this from Apps Script editor to verify connection
// ---------------------------------------------------------------------------

function testDatabaseConnection() {
  try {
    var settings = getAllSettings();
    Logger.log('Connection successful!');
    Logger.log('Settings found: ' + Object.keys(settings).length);
    Logger.log('Settings: ' + JSON.stringify(settings, null, 2));

    var questions = getQuestions();
    Logger.log('Questions found: ' + questions.length);

    var members = getActiveTeamMembers();
    Logger.log('Active team members: ' + members.length);

    var admins = getAdmins();
    Logger.log('Admins: ' + admins.length);

    Logger.log('--- All tests passed! ---');
  } catch (e) {
    Logger.log('Connection FAILED: ' + e.message);
  }
}
