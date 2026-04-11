/**
 * Bot.gs — Chat REST API calls authenticated as Heubot's own bot identity.
 *
 * Apps Script's `Chat.Spaces.*` advanced service always authenticates as
 * the calling user. When the calling user is human, Google Chat rejects
 * card-bearing messages with "Message cannot have cards for requests
 * carrying human credentials." That blocks every autonomous code path
 * (cron-triggered prompts, reminders, digests).
 *
 * To get around it, we mint short-lived OAuth access tokens from a
 * service account (`heubot-bot@<project>.iam.gserviceaccount.com`) via
 * the JWT bearer flow and call `https://chat.googleapis.com/v1/...`
 * directly via `UrlFetchApp`. The Chat API recognizes the service
 * account as the bot because it lives in the same GCP project as the
 * Chat App configuration.
 *
 * Required Script Property:
 *   SERVICE_ACCOUNT_KEY — full JSON contents of the downloaded key file.
 *                         Treat as a credential. Stored encrypted by Apps
 *                         Script Properties at rest.
 */

// ---------------------------------------------------------------------------
// Token minting (JWT bearer → OAuth access token)
// ---------------------------------------------------------------------------

/**
 * Returns a cached or freshly-minted OAuth access token for the bot.
 *
 * Tokens are cached in CacheService for 55 minutes. Google issues 1h
 * tokens; the 5-min safety margin avoids races where a token expires
 * mid-call. CacheService is per-script (not per-user) so the same
 * token is shared across triggers, slash commands, and button clicks.
 */
function getBotAccessToken() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('bot_access_token');
  if (cached) return cached;

  var keyJson = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_KEY');
  if (!keyJson) {
    throw new Error('Missing SERVICE_ACCOUNT_KEY in Script Properties');
  }

  var key;
  try {
    key = JSON.parse(keyJson);
  } catch (e) {
    throw new Error('SERVICE_ACCOUNT_KEY is not valid JSON: ' + e.message);
  }

  if (!key.client_email || !key.private_key) {
    throw new Error('SERVICE_ACCOUNT_KEY is missing client_email or private_key');
  }

  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claims = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/chat.bot',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  var encodedHeader = base64UrlEncode(JSON.stringify(header));
  var encodedClaims = base64UrlEncode(JSON.stringify(claims));
  var signingInput = encodedHeader + '.' + encodedClaims;

  var signature = Utilities.computeRsaSha256Signature(signingInput, key.private_key);
  var encodedSig = base64UrlEncode(signature);

  var jwt = signingInput + '.' + encodedSig;

  var response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) {
    throw new Error('Bot token mint failed (' + code + '): ' + body);
  }

  var tokenData = JSON.parse(body);
  if (!tokenData.access_token) {
    throw new Error('Bot token mint succeeded but no access_token in response: ' + body);
  }

  cache.put('bot_access_token', tokenData.access_token, 3300);
  return tokenData.access_token;
}

/**
 * Base64url encoding (RFC 4648 §5) — URL-safe alphabet, no padding.
 * Accepts either a String or a byte[] (the type returned by
 * Utilities.computeRsaSha256Signature).
 */
function base64UrlEncode(input) {
  return Utilities.base64EncodeWebSafe(input).replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Bot-credentialed Chat REST API wrappers
// ---------------------------------------------------------------------------

/**
 * Generic call to chat.googleapis.com authenticated as the bot.
 * Returns parsed JSON, or null if the response body was empty.
 * Throws on any non-2xx with the response body in the error message.
 */
function botFetch(method, path, payload) {
  var token = getBotAccessToken();
  var url = 'https://chat.googleapis.com' + path;

  var options = {
    method: method,
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  };

  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code >= 400) {
    throw new Error('Chat API ' + method + ' ' + path + ' failed (' + code + '): ' + body);
  }

  return body ? JSON.parse(body) : null;
}

/**
 * Sends a card-bearing message to a Chat space, as the bot.
 *
 * @param {Object} message - Cards v2 message body (e.g. { cardsV2: [...] })
 * @param {string} parent  - Space name like 'spaces/AAAA'
 * @returns {Object} The created Message resource (includes `thread.name`
 *                   which can be passed to `botMessageCreateInThread` to
 *                   add follow-up replies in the same thread)
 */
function botMessageCreate(message, parent) {
  return botFetch('POST', '/v1/' + parent + '/messages', message);
}

/**
 * Sends a reply that lands inside the thread of an existing message.
 * Used by `postDigest` to post each member's standup as a thread reply
 * under the main summary message — keeps the main channel uncluttered.
 *
 * @param {Object} message    - Cards v2 message body
 * @param {string} parent     - Space name like 'spaces/AAAA'
 * @param {string} threadName - Full thread resource, e.g.
 *                              'spaces/AAAA/threads/XYZ'
 * @returns {Object} The created Message resource
 */
function botMessageCreateInThread(message, parent, threadName) {
  var bodyWithThread = {};
  for (var key in message) {
    if (message.hasOwnProperty(key)) {
      bodyWithThread[key] = message[key];
    }
  }
  bodyWithThread.thread = { name: threadName };

  // messageReplyOption tells Chat to put this in the named thread,
  // falling back to a new thread if the named one is gone.
  return botFetch(
    'POST',
    '/v1/' + parent + '/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    bodyWithThread
  );
}

/**
 * Finds the existing DM between the bot and a user. Returns null if no
 * DM exists yet (instead of throwing).
 *
 * IMPORTANT: when authenticated as a service account, the Chat API does
 * NOT support looking up users by email. The userResourceName must be
 * the canonical numeric form: "users/117260094786438825675", not
 * "users/jenish@heubert.com". Numeric IDs come from `event.user.name`
 * on any incoming Chat event.
 *
 * @param {string} userResourceName - e.g. "users/117260094786438825675"
 */
function botFindDirectMessage(userResourceName) {
  try {
    return botFetch('GET', '/v1/spaces:findDirectMessage?name=' + encodeURIComponent(userResourceName));
  } catch (e) {
    if (e.message && (e.message.indexOf('NOT_FOUND') > -1 || e.message.indexOf('404') > -1)) {
      return null;
    }
    throw e;
  }
}

/**
 * Creates a new DM space between the bot and a user.
 * Same numeric-ID requirement as `botFindDirectMessage`.
 *
 * @param {string} userResourceName - e.g. "users/117260094786438825675"
 */
function botSetupDm(userResourceName) {
  return botFetch('POST', '/v1/spaces:setup', {
    space: { spaceType: 'DIRECT_MESSAGE' },
    memberships: [{
      member: {
        name: userResourceName,
        type: 'HUMAN'
      }
    }]
  });
}

// ---------------------------------------------------------------------------
// Test function — run from the editor to verify auth end-to-end
// ---------------------------------------------------------------------------

/**
 * Smoke test for the entire bot auth + Chat API path. Run from the
 * Apps Script editor and check the execution log.
 *
 * Uses a hardcoded numeric user ID (jenish's, captured from a previous
 * /notify-all event payload) because service-account-authenticated
 * Chat API calls do not accept email-style user identifiers.
 */
function testBotAuth() {
  try {
    var token = getBotAccessToken();
    Logger.log('Bot token minted (length: ' + token.length + ')');

    var jenishUserId = 'users/117260094786438825675';
    var dm = botFindDirectMessage(jenishUserId);
    if (dm) {
      Logger.log('Found existing DM with ' + jenishUserId + ': ' + dm.name);
    } else {
      Logger.log('No existing DM with ' + jenishUserId + ' — a setupDm call would create one');
    }

    Logger.log('--- testBotAuth passed ---');
  } catch (e) {
    Logger.log('testBotAuth FAILED: ' + e.message);
    if (e.stack) Logger.log(e.stack);
  }
}
