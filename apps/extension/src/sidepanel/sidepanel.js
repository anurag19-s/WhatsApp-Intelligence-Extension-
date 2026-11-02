/**
 * WA Corporate Intelligence - Side Panel Controller
 *
 * Coordinates:
 *   - Diagnostic scan requests (RUN_DIAGNOSTIC)
 *   - Message extraction requests (EXTRACT_MESSAGES)
 *   - Message list rendering with per-message selection checkboxes
 *   - Selection management (individual, select-all, clear)
 *   - Corporate intelligence analysis requests (ANALYZE_SELECTED_MESSAGES)
 *   - Results presentation and Markdown export
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------
  var els = {};

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var state = {
    conversationTitle: null,
    chatType: 'unknown',
    messages: [],           // All extracted messages
    selected: new Set(),    // Selected message IDs
    lastReport: null,       // Latest intelligence report
    activeTab: 'messages',  // 'messages' | 'report'
    isAnalyzing: false,
  };

  // ---------------------------------------------------------------------------
  // Status Helpers
  // ---------------------------------------------------------------------------
  var STATUS = {
    IDLE: 'idle',
    LOADING: 'loading',
    SUCCESS: 'success',
    ERROR: 'error',
    WARN: 'warn',
  };

  function setStatus(type, text) {
    if (!els.statusBar || !els.statusText) return;
    els.statusBar.className = 'status-bar status-' + type;
    els.statusText.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Backend Health Check
  // ---------------------------------------------------------------------------
  function checkBackendStatus() {
    chrome.runtime.sendMessage({ type: 'CHECK_BACKEND_HEALTH' }, function (res) {
      if (chrome.runtime.lastError) {
        setBackendBadge(false, 'Worker offline');
        return;
      }
      if (res && res.connected) {
        setBackendBadge(true, 'Backend Online');
      } else {
        setBackendBadge(false, 'Backend Offline');
      }
    });
  }

  function setBackendBadge(isOnline, text) {
    if (!els.backendIndicator) return;
    els.backendIndicator.className = 'backend-badge ' + (isOnline ? 'online' : 'offline');
    els.backendIndicator.textContent = text;
    els.backendIndicator.title = isOnline
      ? 'Connected to local backend (http://127.0.0.1:3000)'
      : 'Local backend server is offline. Run `npm run backend:start` in terminal.';
  }

  // ---------------------------------------------------------------------------
  // Diagnostic
  // ---------------------------------------------------------------------------
  function summariseDiagnostic(report) {
    var counts = (report.landmarks || {}).counts || {};
    var parts = [];
    if (counts.convMsgElements !== undefined && counts.convMsgElements > 0) {
      parts.push(counts.convMsgElements + ' conv-msg');
    }
    if (counts.selectableTextElements !== undefined && counts.selectableTextElements > 0) {
      parts.push(counts.selectableTextElements + ' selectable');
    }
    if (counts.dataIdElements !== undefined) parts.push(counts.dataIdElements + ' [data-id]');
    if (counts.copyableElements !== undefined) parts.push(counts.copyableElements + ' .copyable');
    return parts.length ? '(' + parts.join(', ') + ')' : '';
  }

  async function runDiagnostic() {
    setStatus(STATUS.LOADING, 'Running DOM diagnostic…');
    els.diagnosticDetails.hidden = false;
    els.diagnosticOutput.textContent = 'Scanning active WhatsApp Web DOM…';

    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTIC' }, function (response) {
      if (chrome.runtime.lastError) {
        setStatus(STATUS.ERROR, 'Diagnostic failed: ' + chrome.runtime.lastError.message);
        els.diagnosticOutput.textContent = 'Error: ' + chrome.runtime.lastError.message;
        return;
      }
      if (!response || !response.ok) {
        var err = (response && response.error) || 'Unknown error';
        setStatus(STATUS.ERROR, 'Diagnostic failed: ' + err);
        els.diagnosticOutput.textContent = 'Error: ' + err;
        return;
      }

      var report = response.data;
      if (report.warnings && report.warnings.length > 0) {
        showWarnings(report.warnings);
      } else {
        els.warningsBanner.hidden = true;
      }

      els.diagnosticOutput.textContent = JSON.stringify(report, null, 2);
      var summary = summariseDiagnostic(report);
      setStatus(STATUS.SUCCESS, 'Diagnostic complete ' + summary + '.');
    });
  }

  // ---------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------
  function extractMessages() {
    setStatus(STATUS.LOADING, 'Extracting active conversation messages…');
    els.extractBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'EXTRACT_MESSAGES' }, function (response) {
      els.extractBtn.disabled = false;

      if (chrome.runtime.lastError) {
        setStatus(STATUS.ERROR, chrome.runtime.lastError.message);
        showWarnings([chrome.runtime.lastError.message]);
        return;
      }

      if (!response || !response.ok) {
        var errorMsg = (response && response.error) || 'Extraction failed.';
        setStatus(STATUS.ERROR, errorMsg);
        showWarnings([errorMsg]);
        return;
      }

      var extraction = response.extraction;
      var diagnostic = response.diagnostic;

      var warnings = (extraction.meta.warnings || []).concat(diagnostic ? (diagnostic.warnings || []) : []);
      if (warnings.length > 0) {
        showWarnings(warnings);
      } else {
        els.warningsBanner.hidden = true;
      }

      // Attach metrics to diagnostic details view
      if (diagnostic) {
        diagnostic.extractionMetrics = extraction.meta;
        els.diagnosticOutput.textContent = JSON.stringify(diagnostic, null, 2);
      } else {
        els.diagnosticOutput.textContent = JSON.stringify(extraction.meta, null, 2);
      }

      // Update state
      state.messages = extraction.messages || [];
      state.conversationTitle = extraction.meta.conversationTitle || 'Active Chat';
      state.chatType = extraction.meta.chatType || 'unknown';

      // Select all by default upon fresh extraction
      state.selected.clear();
      state.messages.forEach(function (m) {
        state.selected.add(m.id);
      });

      // Update Conversation Card
      updateConversationCard(extraction.meta);

      // Render Messages
      renderMessages(state.messages);

      // Switch to messages view
      switchView('messages');

      var count = state.messages.length;
      var inCount = extraction.meta.incomingCount || 0;
      var outCount = extraction.meta.outgoingCount || 0;
      var unkCount = extraction.meta.unknownDirectionCount || 0;
      var dirSummary = inCount + ' incoming, ' + outCount + ' outgoing' + (unkCount > 0 ? ', ' + unkCount + ' unknown' : '');

      if (count === 0) {
        setStatus(STATUS.WARN, 'No text messages extracted from active conversation.');
      } else {
        setStatus(STATUS.SUCCESS, count + ' message(s) loaded (' + dirSummary + ').');
      }

      // Also trigger a background health check refresh
      checkBackendStatus();
    });
  }

  // ---------------------------------------------------------------------------
  // Conversation Card Updates
  // ---------------------------------------------------------------------------
  function updateConversationCard(meta) {
    if (!els.conversationCard) return;
    els.conversationCard.hidden = false;

    var title = meta.conversationTitle || 'Active Conversation';
    els.convTitle.textContent = title;
    els.convTitle.title = title;

    var typeText = meta.chatType === 'group' ? 'Group Chat' : (meta.chatType === 'individual' ? '1:1 Chat' : 'Chat');
    els.convMeta.textContent = typeText + ' • ' + (meta.validTextMessagesExtracted || 0) + ' messages rendered';
    els.chatTypeBadge.textContent = meta.chatType || 'chat';

    var unk = meta.unknownDirectionCount || 0;
    if (unk > 0) {
      els.unknownDirBadge.hidden = false;
      els.unknownDirBadge.textContent = unk + ' Unknown Dir';
    } else {
      els.unknownDirBadge.hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Message List Rendering
  // ---------------------------------------------------------------------------
  function renderMessages(messages) {
    if (!messages || messages.length === 0) {
      els.placeholder.hidden = false;
      els.messageList.hidden = true;
      els.statsBar.hidden = true;
      els.analyzeBar.hidden = true;
      return;
    }

    els.placeholder.hidden = true;
    els.messageList.hidden = false;
    els.statsBar.hidden = false;
    els.analyzeBar.hidden = false;

    els.messageList.innerHTML = '';

    messages.forEach(function (msg) {
      var li = buildMessageItem(msg);
      els.messageList.appendChild(li);
    });

    updateSelectionCounts();
  }

  function buildMessageItem(msg) {
    var li = document.createElement('li');
    var direction = msg.direction === 'sent' || msg.direction === 'outgoing'
      ? 'sent'
      : (msg.direction === 'received' || msg.direction === 'incoming' ? 'received' : 'unknown');
    li.className = 'message-item is-' + direction;
    if (state.selected.has(msg.id)) {
      li.classList.add('is-selected');
    }
    li.dataset.msgId = msg.id;

    // Checkbox
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'msg-checkbox';
    cb.id = 'cb-' + sanitizeId(msg.id);
    cb.checked = state.selected.has(msg.id);
    cb.setAttribute('aria-label', 'Select message from ' + (msg.sender || 'unknown'));

    cb.addEventListener('change', function (e) {
      e.stopPropagation();
      toggleSelected(msg.id, cb.checked, li);
    });

    // Body
    var body = document.createElement('div');
    body.className = 'msg-body';

    // Meta row
    var meta = document.createElement('div');
    meta.className = 'msg-meta';

    var senderEl = document.createElement('span');
    senderEl.className = 'msg-sender';
    senderEl.textContent = msg.sender || 'Unknown';
    senderEl.title = msg.sender || 'Unknown';

    var dirEl = document.createElement('span');
    dirEl.className = 'msg-direction ' + direction;
    dirEl.textContent = direction === 'sent' ? 'Sent' : (direction === 'received' ? 'Received' : 'Unknown');

    meta.appendChild(senderEl);
    meta.appendChild(dirEl);

    if (msg.timestamp) {
      var tsEl = document.createElement('span');
      tsEl.className = 'msg-timestamp';
      tsEl.textContent = msg.timestamp;
      meta.appendChild(tsEl);
    }

    if (msg.messageType === 'media_caption') {
      var capBadge = document.createElement('span');
      capBadge.className = 'msg-quoted-badge';
      capBadge.textContent = '📷 caption';
      meta.appendChild(capBadge);
    }

    // Text
    var textEl = document.createElement('p');
    textEl.className = 'msg-text';
    textEl.textContent = msg.text || '';

    // Quoted context badge
    if (msg.hasQuotedContext) {
      var quotedBadge = document.createElement('span');
      quotedBadge.className = 'msg-quoted-badge';
      quotedBadge.textContent = '↩ reply';
      body.appendChild(quotedBadge);
    }

    body.appendChild(meta);
    body.appendChild(textEl);

    // Expand message on text click
    textEl.addEventListener('click', function (e) {
      e.stopPropagation();
      textEl.classList.toggle('is-expanded');
    });

    li.appendChild(cb);
    li.appendChild(body);

    // Row click toggles selection
    li.addEventListener('click', function (e) {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      toggleSelected(msg.id, cb.checked, li);
    });

    return li;
  }

  // ---------------------------------------------------------------------------
  // Selection Handling
  // ---------------------------------------------------------------------------
  function toggleSelected(msgId, isChecked, liEl) {
    if (isChecked) {
      state.selected.add(msgId);
      liEl.classList.add('is-selected');
    } else {
      state.selected.delete(msgId);
      liEl.classList.remove('is-selected');
    }
    updateSelectionCounts();
  }

  function selectAll() {
    state.messages.forEach(function (msg) {
      state.selected.add(msg.id);
    });
    els.messageList.querySelectorAll('.message-item').forEach(function (li) {
      li.classList.add('is-selected');
      var cb = li.querySelector('.msg-checkbox');
      if (cb) cb.checked = true;
    });
    updateSelectionCounts();
  }

  function clearSelection() {
    state.selected.clear();
    els.messageList.querySelectorAll('.message-item').forEach(function (li) {
      li.classList.remove('is-selected');
      var cb = li.querySelector('.msg-checkbox');
      if (cb) cb.checked = false;
    });
    updateSelectionCounts();
  }

  function updateSelectionCounts() {
    var count = state.selected.size;
    els.extractedCount.textContent = state.messages.length;
    els.selectedCount.textContent = count;
    els.tabMsgCount.textContent = state.messages.length;

    els.analyzeBtnText.textContent = 'Analyse Selected (' + count + ')';
    els.analyzeBtn.disabled = count === 0 || state.isAnalyzing;
  }

  // ---------------------------------------------------------------------------
  // Corporate Intelligence Analysis Action
  // ---------------------------------------------------------------------------
  function analyzeSelectedMessages() {
    if (state.selected.size === 0) {
      setStatus(STATUS.WARN, 'Please select at least one message before analyzing.');
      showWarnings(['Selection validation: No messages selected. Check the boxes of messages you want analyzed.']);
      return;
    }

    if (state.isAnalyzing) return; // Prevent duplicate concurrent requests

    // Filter ONLY explicitly selected messages
    var selectedMessages = state.messages.filter(function (m) {
      return state.selected.has(m.id);
    });

    state.isAnalyzing = true;
    els.analyzeBtn.disabled = true;
    els.extractBtn.disabled = true;
    els.analysisProgress.hidden = false;
    setStatus(STATUS.LOADING, 'Analyzing ' + selectedMessages.length + ' selected message(s) via local backend…');

    var payload = {
      conversation: {
        title: state.conversationTitle,
        chatType: state.chatType,
      },
      messages: selectedMessages,
    };

    chrome.runtime.sendMessage({
      type: 'ANALYZE_SELECTED_MESSAGES',
      payload: payload,
    }, function (response) {
      state.isAnalyzing = false;
      els.analysisProgress.hidden = true;
      els.extractBtn.disabled = false;
      updateSelectionCounts();

      if (chrome.runtime.lastError) {
        setStatus(STATUS.ERROR, chrome.runtime.lastError.message);
        showWarnings(['Communication failure with service worker: ' + chrome.runtime.lastError.message]);
        return;
      }

      if (!response || !response.ok) {
        var err = (response && response.error) || 'Analysis failed.';
        setStatus(STATUS.ERROR, err);
        showWarnings([
          err,
          'Ensure the local backend is running: open a terminal and execute `npm run backend:start`.'
        ]);
        return;
      }

      // Analysis succeeded!
      var report = response.data;
      state.lastReport = report;

      renderReport(report);
      switchView('report');
      setStatus(
        report.meta && report.meta.isMock ? STATUS.WARN : STATUS.SUCCESS,
        report.meta && report.meta.isMock
          ? 'Mock output returned; it contains no AI-generated findings.'
          : 'Corporate intelligence analysis ready (' + selectedMessages.length + ' messages).'
      );

      // Refresh backend badge
      setBackendBadge(true, 'Backend Online');
    });
  }

  // ---------------------------------------------------------------------------
  // Intelligence Report Rendering
  // ---------------------------------------------------------------------------
  function renderReport(report) {
    if (!report || !els.reportContent) return;

    var meta = report.meta || {};
    var isMock = meta.isMock;
    var model = meta.model || 'Not specified';
    var provider = meta.provider || (isMock ? 'mock' : 'unknown');
    var title = meta.conversationTitle || state.conversationTitle || 'WhatsApp Conversation';
    var decisions = report.decisions || {};

    var html = '';

    html += '<div class="report-header-card">';
    html += '  <h3 class="report-header-title">📊 ' + escapeHtml(title) + '</h3>';
    html += '  <div class="report-header-meta">';
    html += '    <span>Selected messages: <strong>' + escapeHtml(meta.selectedCount || state.selected.size) + '</strong></span>';
    html += '    <span>•</span>';
    html += '    <span>Provider: <strong>' + escapeHtml(provider) + '</strong></span>';
    html += '    <span>•</span>';
    html += '    <span>Model: <strong>' + escapeHtml(model) + '</strong></span>';
    html += '    <span>•</span>';
    html += '    <span>' + escapeHtml(meta.generatedAt || meta.analyzedAt || 'Time unavailable') + '</span>';
    html += '  </div>';
    html += '</div>';

    if (isMock) {
      html += '<div class="mock-notice"><strong>MOCK OUTPUT — not AI analysis.</strong> ' +
        escapeHtml(meta.warning || 'No AI interpretation was performed.') + '</div>';
    }

    html += '<section class="report-section">';
    html += '  <h4 class="section-title">📌 Executive Summary</h4>';
    html += '  <div class="summary-box">' + escapeHtml(report.executiveSummary || 'No summary available.') + '</div>';
    html += '</section>';

    html += renderFindingSection('💬 Key Discussion Points', report.keyDiscussionPoints);
    html += '<section class="report-section">';
    html += '  <h4 class="section-title">⚖️ Decisions & Agreements</h4>';
    html += renderDecisionList('Confirmed', decisions.confirmed || report.confirmedDecisions, 'tag-confirmed');
    html += renderDecisionList('Proposed', decisions.proposed || report.proposedDecisions, 'tag-proposed');
    html += renderDecisionList('Ambiguous', decisions.ambiguous, 'tag-proposed');
    html += '</section>';

    html += '<section class="report-section">';
    html += '  <h4 class="section-title">✅ Action Items</h4>';
    if (report.actionItems && report.actionItems.length) {
      report.actionItems.forEach(function (item) {
        var status = ['confirmed', 'proposed', 'pending'].indexOf(item.status) >= 0 ? item.status : 'pending';
        var statusBadge = status === 'confirmed' ? 'tag-confirmed' : 'tag-proposed';
        html += '<div class="action-card">';
        html += '  <div class="action-task">' + escapeHtml(item.task || '') + '</div>';
        html += '  <div class="action-meta">';
        html += '    <span>Owner: <strong class="action-owner">' + escapeHtml(item.owner || 'Unassigned') + '</strong></span>';
        html += '    <span>Deadline: <span class="action-deadline">' + escapeHtml(item.deadline || 'Not specified') + '</span></span>';
        html += '    <span class="decision-tag ' + statusBadge + '">' + escapeHtml(status) + '</span>';
        html += '  </div>';
        html += renderEvidence(item);
        html += '</div>';
      });
    } else {
      html += '<p>No action items identified in the selected messages.</p>';
    }
    html += '</section>';

    html += '<section class="report-section">';
    html += '  <h4 class="section-title">⏳ Approvals and Dependencies</h4>';
    var approvals = report.approvals || (report.pendingApprovals || []).map(function (item) {
      return { item: item, owner: 'Unassigned' };
    });
    if (approvals.length) {
      approvals.forEach(function (approval) {
        html += '<div class="decision-item"><span>' + escapeHtml(approval.item || '') +
          '</span><span>Owner: ' + escapeHtml(approval.owner || 'Unassigned') + '</span>' +
          renderEvidence(approval) + '</div>';
      });
    } else {
      html += '<p>No pending approvals were identified in the selected messages.</p>';
    }
    html += '</section>';

    html += renderFindingSection('Unresolved Issues', report.unresolvedIssues);
    html += '<section class="report-section"><h4 class="section-title">⚠️ Risks and Watchpoints</h4>';
    if (report.risks && report.risks.length) {
      html += '<div class="risk-box">';
      html += '<ul class="risk-list">';
      report.risks.forEach(function (risk) {
        html += '<li><strong>' + escapeHtml(risk.type || 'Risk') + ':</strong> ' +
          escapeHtml(risk.description || '') + renderEvidence(risk) + '</li>';
      });
      html += '</ul></div>';
    } else {
      html += '<p>No risks were identified in this report; this does not establish that no risk exists.</p>';
    }
    html += '</section>';
    html += renderFindingSection('Recommended Next Steps', report.recommendedNextSteps);
    if (meta.warning && !isMock) {
      html += '<div class="mock-notice">' + escapeHtml(meta.warning) + '</div>';
    }

    els.reportContent.innerHTML = html;
  }

  function renderFindingSection(title, items) {
    var list = Array.isArray(items) ? items : [];
    var html = '<section class="report-section"><h4 class="section-title">' + escapeHtml(title) + '</h4>';
    if (!list.length) return html + '<p>None identified in the selected messages.</p></section>';
    html += '<ul class="item-list">';
    list.forEach(function (item) {
      html += '<li>' + escapeHtml(findingText(item)) + renderEvidence(item) + '</li>';
    });
    return html + '</ul></section>';
  }

  function renderDecisionList(label, items, className) {
    var list = Array.isArray(items) ? items : [];
    return list.map(function (item) {
      return '<div class="decision-item"><span class="decision-tag ' + className + '">' +
        escapeHtml(label) + '</span><span>' + escapeHtml(findingText(item)) +
        renderEvidence(item) + '</span></div>';
    }).join('');
  }

  function findingText(item) {
    if (typeof item === 'string') return item;
    return item && typeof item.text === 'string' ? item.text : '';
  }

  function renderEvidence(item) {
    if (!item || typeof item !== 'object') return '';
    var refs = Array.isArray(item.sourceIndices) && item.sourceIndices.length
      ? 'Sources: ' + item.sourceIndices.map(function (index) { return '#' + index; }).join(', ')
      : 'Source not identified';
    var confidence = item.confidence ? ' • ' + item.confidence + ' confidence' : '';
    return '<span class="finding-evidence">' + escapeHtml(refs + confidence) + '</span>';
  }

  // ---------------------------------------------------------------------------
  // View Switcher (Tabs)
  // ---------------------------------------------------------------------------
  function switchView(tabName) {
    state.activeTab = tabName;
    if (tabName === 'report') {
      els.messagesSection.hidden = true;
      els.resultsSection.hidden = false;
      els.tabReportBtn.classList.add('active');
      els.tabMessagesBtn.classList.remove('active');
    } else {
      els.messagesSection.hidden = false;
      els.resultsSection.hidden = true;
      els.tabMessagesBtn.classList.add('active');
      els.tabReportBtn.classList.remove('active');
    }

    if (state.lastReport) {
      els.viewTabs.hidden = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Copy Report to Clipboard
  // ---------------------------------------------------------------------------
  function copyReportMarkdown() {
    if (!state.lastReport) return;
    var md = window.WACIReportExport.buildMarkdown(state.lastReport, state.conversationTitle);
    navigator.clipboard.writeText(md).then(function () {
      var origText = els.copyReportBtn.textContent;
      els.copyReportBtn.textContent = '✓ Copied!';
      setTimeout(function () {
        els.copyReportBtn.textContent = origText;
      }, 2000);
    }).catch(function (err) {
      setStatus(STATUS.ERROR, 'Could not copy report: ' + err.message);
    });
  }

  function downloadReport(format) {
    if (!state.lastReport) return;
    var content = format === 'csv'
      ? window.WACIReportExport.buildCsv(state.lastReport)
      : window.WACIReportExport.buildMarkdown(state.lastReport, state.conversationTitle);
    var mimeType = format === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8';
    var extension = format === 'csv' ? 'csv' : 'md';
    var fileName = (state.conversationTitle || 'whatsapp-report')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'whatsapp-report';
    var url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    var link = document.createElement('a');
    link.href = url;
    link.download = 'waci-' + fileName + '.' + extension;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Warnings Banner
  // ---------------------------------------------------------------------------
  function showWarnings(warnings) {
    if (!els.warningsBanner) return;
    els.warningsBanner.hidden = false;
    els.warningsBanner.innerHTML = warnings
      .map(function (w) { return '<p>⚠ ' + escapeHtml(w) + '</p>'; })
      .join('');
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sanitizeId(str) {
    return String(str || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    // Resolve DOM elements
    els.backendIndicator   = document.getElementById('backend-indicator');
    els.conversationCard   = document.getElementById('conversation-card');
    els.convTitle          = document.getElementById('conv-title');
    els.convMeta           = document.getElementById('conv-meta');
    els.chatTypeBadge      = document.getElementById('chat-type-badge');
    els.unknownDirBadge    = document.getElementById('unknown-dir-badge');
    els.extractBtn         = document.getElementById('extract-btn');
    els.diagnosticBtn      = document.getElementById('diagnostic-btn');
    els.statusBar          = document.getElementById('status-bar');
    els.statusText         = document.getElementById('status-text');
    els.statsBar           = document.getElementById('stats-bar');
    els.extractedCount     = document.getElementById('extracted-count');
    els.selectedCount      = document.getElementById('selected-count');
    els.selectAllBtn       = document.getElementById('select-all-btn');
    els.clearBtn           = document.getElementById('clear-btn');
    els.analyzeBar         = document.getElementById('analyze-bar');
    els.analyzeBtn         = document.getElementById('analyze-btn');
    els.analyzeBtnText     = document.getElementById('analyze-btn-text');
    els.analysisProgress   = document.getElementById('analysis-progress');
    els.diagnosticDetails  = document.getElementById('diagnostic-details');
    els.diagnosticOutput   = document.getElementById('diagnostic-output');
    els.warningsBanner     = document.getElementById('warnings-banner');
    els.viewTabs           = document.getElementById('view-tabs');
    els.tabMessagesBtn     = document.getElementById('tab-messages-btn');
    els.tabReportBtn       = document.getElementById('tab-report-btn');
    els.tabMsgCount        = document.getElementById('tab-msg-count');
    els.placeholder        = document.getElementById('placeholder');
    els.messageList        = document.getElementById('message-list');
    els.messagesSection    = document.getElementById('messages-section');
    els.resultsSection     = document.getElementById('results-section');
    els.reportContent      = document.getElementById('report-content');
    els.copyReportBtn      = document.getElementById('copy-report-btn');
    els.downloadMarkdownBtn = document.getElementById('download-markdown-btn');
    els.downloadCsvBtn     = document.getElementById('download-csv-btn');
    els.backToMessagesBtn  = document.getElementById('back-to-messages-btn');

    // Wire Event Listeners
    els.extractBtn.addEventListener('click', extractMessages);
    els.diagnosticBtn.addEventListener('click', runDiagnostic);
    els.selectAllBtn.addEventListener('click', selectAll);
    els.clearBtn.addEventListener('click', clearSelection);
    els.analyzeBtn.addEventListener('click', analyzeSelectedMessages);
    els.tabMessagesBtn.addEventListener('click', function () { switchView('messages'); });
    els.tabReportBtn.addEventListener('click', function () { switchView('report'); });
    els.backToMessagesBtn.addEventListener('click', function () { switchView('messages'); });
    els.copyReportBtn.addEventListener('click', copyReportMarkdown);
    els.downloadMarkdownBtn.addEventListener('click', function () { downloadReport('markdown'); });
    els.downloadCsvBtn.addEventListener('click', function () { downloadReport('csv'); });

    // Initial backend check
    checkBackendStatus();

    console.log('[WACI] Side panel controller ready.');
  });

})();
