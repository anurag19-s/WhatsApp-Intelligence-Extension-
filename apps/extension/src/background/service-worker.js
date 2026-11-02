/**
 * WA Corporate Intelligence - Service Worker (Background)
 * Coordinates communication between Popup, Side Panel, Content Scripts,
 * and the local secure Node.js backend.
 */

'use strict';

const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:3001';
const DEFAULT_TIMEOUT_MS = 125000;

function normalizeBackendBaseUrl(value) {
  var url;
  try {
    url = new URL(value);
  } catch (err) {
    throw new Error('Backend URL must be an HTTP URL on localhost or 127.0.0.1.');
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new Error('Backend URL must be an HTTP URL on localhost or 127.0.0.1.');
  }
  return url.origin;
}

function getBackendBaseUrl() {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.get({ backendBaseUrl: DEFAULT_BACKEND_BASE_URL }, function (settings) {
      if (chrome.runtime.lastError) {
        reject(new Error('Could not read the saved backend URL.'));
        return;
      }
      try {
        resolve(normalizeBackendBaseUrl(settings.backendBaseUrl));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Enable side panel on extension icon click where supported
if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function (err) {
    console.warn('[WACI SW] setPanelBehavior error:', err);
  });
}

chrome.runtime.onInstalled.addListener(function () {
  console.log('[WACI SW] Background service worker initialized.');
});

/**
 * Finds the currently active WhatsApp Web tab.
 */
async function findWhatsAppTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    return { error: 'No active tab found. Please switch to your WhatsApp Web tab.' };
  }
  var tab = tabs[0];
  if (!tab.url || !/^https:\/\/web\.whatsapp\.com\//.test(tab.url)) {
    return {
      error: 'The active tab is not WhatsApp Web. Switch to the conversation you want to use.',
    };
  }
  return { tab: tab };
}

/**
 * Checks connectivity with the local backend server.
 */
async function checkBackendHealth() {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, 4000);

  try {
    var backendBaseUrl = await getBackendBaseUrl();
    var response = await fetch(backendBaseUrl + '/health', {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      var data = await response.json();
      return { ok: true, connected: true, data: data };
    }
    return {
      ok: false,
      connected: false,
      error: 'Backend returned HTTP ' + response.status,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      connected: false,
      error: 'Backend offline. Check that the backend is running and the saved Backend URL is correct.',
    };
  }
}

/**
 * Relays selected messages to the local backend for corporate intelligence analysis.
 */
async function analyzeSelectedMessages(payload) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return {
      ok: false,
      error: 'Cannot analyze: No messages selected. Please select at least one message.',
    };
  }
  if (payload.messages.some(function (message) {
    return !message || typeof message !== 'object' || Array.isArray(message);
  })) {
    return { ok: false, error: 'Cannot analyze: selected message data is invalid.' };
  }

  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, DEFAULT_TIMEOUT_MS);
  var backendBaseUrl;
  try {
    backendBaseUrl = await getBackendBaseUrl();
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, error: err.message };
  }
  var requestPayload = {
    conversation: payload.conversation,
    messages: payload.messages.map(function (message) {
      return {
        id: message.id,
        text: message.text,
        sender: message.sender,
        timestamp: message.timestamp,
        direction: message.direction,
      };
    }),
  };

  try {
    var response = await fetch(backendBaseUrl + '/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    var text = await response.text();
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'The backend returned a malformed response. Check backend logs locally.' };
    }

    if (!response.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || 'Backend analysis failed with status ' + response.status,
      };
    }

    if (!json.data || typeof json.data !== 'object') {
      return { ok: false, error: 'The backend response did not contain a valid analysis report.' };
    }
    return { ok: true, data: json.data };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return {
        ok: false,
        error: 'Analysis request timed out after ' + (DEFAULT_TIMEOUT_MS / 1000) + ' seconds.',
      };
    }
    return {
      ok: false,
      error: 'Could not connect to local backend at ' + backendBaseUrl +
             '. Ensure the backend is running (`npm run backend:start`) and the URL is correct.',
    };
  }
}

/**
 * Message Dispatcher
 */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message.type !== 'string') return false;
  var type = message.type;

  // 1. PING / GET_EXTRACTION_STATUS
  if (type === 'PING' || type === 'GET_EXTRACTION_STATUS') {
    sendResponse({ ok: true, status: 'ONLINE', timestamp: new Date().toISOString() });
    return false;
  }

  // 2. CHECK_BACKEND_HEALTH
  if (type === 'CHECK_BACKEND_HEALTH') {
    checkBackendHealth().then(sendResponse);
    return true; // Keep channel open for async response
  }

  // 3. EXTRACT_MESSAGES
  if (type === 'EXTRACT_MESSAGES') {
    findWhatsAppTab().then(function (res) {
      if (res.error) {
        sendResponse({ ok: false, error: res.error });
        return;
      }
      chrome.tabs.sendMessage(res.tab.id, { type: 'EXTRACT_MESSAGES' }, function (csRes) {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            error: 'Could not communicate with WhatsApp Web tab: ' +
                   chrome.runtime.lastError.message + '. Try reloading the WhatsApp page.',
          });
        } else {
          sendResponse(csRes || { ok: false, error: 'Empty response from content script.' });
        }
      });
    });
    return true;
  }

  // 4. RUN_DIAGNOSTIC
  if (type === 'RUN_DIAGNOSTIC') {
    findWhatsAppTab().then(function (res) {
      if (res.error) {
        sendResponse({ ok: false, error: res.error });
        return;
      }
      chrome.tabs.sendMessage(res.tab.id, { type: 'RUN_DIAGNOSTIC' }, function (csRes) {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError.message || 'Diagnostic communication failure.',
          });
        } else {
          sendResponse(csRes || { ok: false, error: 'Empty diagnostic response.' });
        }
      });
    });
    return true;
  }

  // 5. ANALYZE_SELECTED_MESSAGES
  if (type === 'ANALYZE_SELECTED_MESSAGES') {
    analyzeSelectedMessages(message.payload).then(sendResponse);
    return true;
  }

  return false;
});
