/**
 * WA Corporate Intelligence - Content Script Entry Point
 * Injected into https://web.whatsapp.com/*
 *
 * Loaded last in manifest injection order (after dom-inspector.js and extractor.js).
 * Coordinates extraction and diagnostic tasks with window.WACI modules.
 */

(function () {
  'use strict';

  // Guard: only operate on WhatsApp Web
  if (window.location.hostname !== 'web.whatsapp.com') return;

  // Prevent duplicate listener attachments if injected more than once
  if (window.__WACI_CS_INITIALIZED__) {
    console.log('[WACI] Content script already initialized; reusing existing instance.');
    return;
  }
  window.__WACI_CS_INITIALIZED__ = true;

  console.log('[WACI] Content script active on WhatsApp Web.');

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return false;

    if (message.type === 'PING') {
      sendResponse({ ok: true, status: 'CONTENT_SCRIPT_READY' });
      return false;
    }

    if (message.type === 'RUN_DIAGNOSTIC') {
      try {
        if (!window.WACI || typeof window.WACI.runDomDiagnostic !== 'function') {
          sendResponse({ ok: false, error: 'WACI DOM inspector module is not loaded.' });
          return false;
        }
        var report = window.WACI.runDomDiagnostic();
        sendResponse({ ok: true, data: report });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || 'Diagnostic error' });
      }
      return false;
    }

    if (message.type === 'EXTRACT_MESSAGES') {
      try {
        if (!window.WACI || typeof window.WACI.extractMessages !== 'function') {
          sendResponse({ ok: false, error: 'WACI extractor module is not loaded.' });
          return false;
        }
        // Always run quick diagnostic alongside extraction to surface DOM health
        var diagnostic = (window.WACI.runDomDiagnostic) ? window.WACI.runDomDiagnostic() : null;
        var extraction = window.WACI.extractMessages();
        sendResponse({ ok: true, diagnostic: diagnostic, extraction: extraction });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || 'Extraction execution error' });
      }
      return false;
    }

    if (message.type === 'GET_CONVERSATION_INFO') {
      try {
        var title = (window.WACI && window.WACI.getConversationTitle) ? window.WACI.getConversationTitle() : null;
        sendResponse({ ok: true, title: title });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return false;
    }

    return false;
  });

})();
