/**
 * WA Corporate Intelligence - Popup UI Controller
 */

'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var statusEl = document.getElementById('backend-status');
  var openPanelBtn = document.getElementById('open-sidepanel-btn');

  // Query background service worker for backend health
  if (statusEl) {
    chrome.runtime.sendMessage({ type: 'CHECK_BACKEND_HEALTH' }, function (res) {
      if (chrome.runtime.lastError) {
        statusEl.textContent = 'Service worker initializing…';
        statusEl.style.color = '#64748b';
        return;
      }
      if (res && res.connected) {
        statusEl.textContent = 'Connected (127.0.0.1:3000)';
        statusEl.style.color = '#16a34a';
      } else {
        statusEl.textContent = 'Offline (Run npm run backend:start)';
        statusEl.style.color = '#dc2626';
      }
    });
  }

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
