/**
 * WA Corporate Intelligence - Popup UI Controller
 */

'use strict';

var DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:3001';

function normalizeBackendBaseUrl(value) {
  var url;
  try {
    url = new URL(value);
  } catch (err) {
    throw new Error('Enter an HTTP URL on localhost or 127.0.0.1.');
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
    throw new Error('Enter an HTTP URL on localhost or 127.0.0.1.');
  }
  return url.origin;
}

document.addEventListener('DOMContentLoaded', function () {
  var statusEl = document.getElementById('backend-status');
  var backendUrlEl = document.getElementById('backend-url');
  var backendUrlStatusEl = document.getElementById('backend-url-status');
  var saveBackendUrlBtn = document.getElementById('save-backend-url-btn');
  var openPanelBtn = document.getElementById('open-sidepanel-btn');

  chrome.storage.local.get({ backendBaseUrl: DEFAULT_BACKEND_BASE_URL }, function (settings) {
    if (!chrome.runtime.lastError && backendUrlEl) {
      backendUrlEl.value = settings.backendBaseUrl;
    }
  });

  if (saveBackendUrlBtn) {
    saveBackendUrlBtn.addEventListener('click', function () {
      var backendBaseUrl;
      try {
        backendBaseUrl = normalizeBackendBaseUrl(backendUrlEl.value.trim());
      } catch (err) {
        backendUrlStatusEl.textContent = err.message;
        backendUrlStatusEl.style.color = '#dc2626';
        return;
      }
      chrome.storage.local.set({ backendBaseUrl: backendBaseUrl }, function () {
        if (chrome.runtime.lastError) {
          backendUrlStatusEl.textContent = 'Could not save the backend URL.';
          backendUrlStatusEl.style.color = '#dc2626';
          return;
        }
        backendUrlEl.value = backendBaseUrl;
        backendUrlStatusEl.textContent = 'Backend URL saved.';
        backendUrlStatusEl.style.color = '#16a34a';
        checkBackendHealth();
      });
    });
  }

  function checkBackendHealth() {
    if (statusEl) {
      chrome.runtime.sendMessage({ type: 'CHECK_BACKEND_HEALTH' }, function (res) {
        if (chrome.runtime.lastError) {
          statusEl.textContent = 'Service worker initializing…';
          statusEl.style.color = '#64748b';
          return;
        }
        if (res && res.connected) {
          var provider = res.data && res.data.provider;
          var model = res.data && res.data.model;
          statusEl.textContent = provider && model
            ? 'Connected (' + provider + ': ' + model + ')'
            : 'Connected to local backend';
          statusEl.style.color = '#16a34a';
        } else {
          statusEl.textContent = 'Offline (Run npm run backend:start)';
          statusEl.style.color = '#dc2626';
        }
      });
    }
  }

  checkBackendHealth();

  if (openPanelBtn) {
    openPanelBtn.addEventListener('click', async function () {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        try {
          var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs && tabs[0] && tabs[0].id) {
            await chrome.sidePanel.open({ tabId: tabs[0].id });
            window.close();
          }
        } catch (err) {
          console.error('Failed to open side panel:', err);
        }
      }
    });
  }
});
