/**
 * WA Corporate Intelligence - Message Extractor
 *
 * Extracts messages from the currently active WhatsApp Web conversation.
 * Scoped strictly inside [data-testid="conversation-panel-messages"].
 *
 * Primary message boundary: div[data-testid^="conv-msg-"]
 * Direction detection: tail-out (outgoing), tail-in (incoming), or unknown (never guessed).
 * Excludes quoted-message content, reactions, metadata, and timestamps outside text.
 * Preserves genuine document captions.
 *
 * Attaches to the shared window.WACI namespace.
 */

(function () {
  'use strict';

  window.WACI = window.WACI || {};

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------
  var SEL = {
    // Primary active conversation container
    conversationPanel: '[data-testid="conversation-panel-messages"]',
    mainPane: '#main',

    // Conversation header landmarks
    chatHeader: '[data-testid="conversation-header"], #main header',
    groupIcon: '[data-testid="default-group"], [data-icon="default-group"], [data-testid="avatar-group"]',
    chatSubtitle: '[data-testid="chat-subtitle"]',

    // Primary message boundary (observed on modern WhatsApp Web)
    convMsgBoundary: 'div[data-testid^="conv-msg-"]',
    convMsgFallback: '[data-testid*="conv-msg"]',
    msgContainer: '[data-testid="msg-container"]',
    messageRow: '[data-id]',

    // Direction indicators (strongest evidence)
    tailOut: '[data-testid*="tail-out"], [data-icon*="tail-out"], .tail-out, [class*="tail-out"]',
    tailIn: '[data-testid*="tail-in"], [data-icon*="tail-in"], .tail-in, [class*="tail-in"]',
    msgOutClass: '.message-out',
    msgInClass: '.message-in',

    // Text-bearing elements
    selectableText: '[data-testid="selectable-text"]',
    documentCaption: '[data-testid="document-caption"]',
    copyableText: '.copyable-text',
    prePlainText: '[data-pre-plain-text]',

    // Author element inside bubble
    author: '[data-testid="author"]',

    // Excluded regions
    quotedMessage: '[data-testid="quoted-message"], [data-testid*="quoted"], .quoted-mention, [class*="quoted-mention"]',
    reactionContainer: '[data-testid="reactions-tray"], [data-testid="reaction-bubble"], [data-testid*="reaction"]',
    msgMeta: '[data-testid="msg-meta"]',

    // Media indicators (for detecting captionless media)
    mediaIndicators: 'img[src*="blob:"], video, audio, [data-testid*="audio-player"], [data-testid*="audio-play"], [data-testid*="sticker"], [data-testid*="media-canvas"], [data-testid*="image"]',
    directedSpan: 'span[dir="ltr"], span[dir="rtl"]',
  };

  // Excluded selector array for strict hierarchy filtering
  var EXCLUDE_SELECTORS = [
    // Quoted messages and reply context
    '[data-testid="quoted-message"]',
    '[data-testid*="quoted"]',
    '.quoted-mention',
    '[class*="quoted-mention"]',

    // Author element (bubble sender header in group chats)
    '[data-testid="author"]',

    // Reactions
    '[data-testid="reactions-tray"]',
    '[data-testid="reaction-bubble"]',
    '[data-testid*="reaction"]',
    '.reactions-tray',

    // Message metadata and timestamps
    '[data-testid="msg-meta"]',
    '[data-testid*="msg-meta"]',
    '.msg-meta',

    // Delivery and read receipt indicators
    '[data-icon="msg-dblcheck"]',
    '[data-icon="msg-check"]',
    '[data-icon="msg-time"]',
    '[data-icon="msg-check-muted"]',
    '[data-testid*="status-icon"]',

    // Speech bubble tail markers
    '[data-testid*="tail-out"]',
    '[data-testid*="tail-in"]',
    '[data-icon*="tail-out"]',
    '[data-icon*="tail-in"]',
    '.tail-out',
    '.tail-in',
  ];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Parses data-pre-plain-text attribute into { timestamp, sender }.
   * Formats:
   *   "[H:MM AM/PM, M/DD/YYYY] Sender: "
   *   "[H:MM, DD/MM/YYYY] Sender: "
   */
  function parsePrePlainText(raw) {
    if (!raw) return { timestamp: null, sender: null };

    var match = raw.match(/^\[([^\]]+)\]\s*(.+?):\s*$/);
    if (match) {
      var s = match[2].trim();
      return {
        timestamp: match[1].trim(),
        sender: s || null,
      };
    }

    var bracketMatch = raw.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (bracketMatch) {
      var rest = bracketMatch[2].trim().replace(/:+$/, '').trim();
      return {
        timestamp: bracketMatch[1].trim(),
        sender: rest || null,
      };
    }

    return { timestamp: null, sender: null };
  }

  /**
   * Normalizes a parsed timestamp string to an ISO string if valid, or null.
   * Handles formats:
   *   "H:MM AM/PM, M/DD/YYYY"
   *   "H:MM, DD/MM/YYYY"
   *   "YYYY-MM-DDTHH:MM:SS"
   * Does NOT invent dates or times if missing.
   */
  function normalizeTimestamp(rawTs) {
    if (!rawTs || typeof rawTs !== 'string') return null;
    var trimmed = rawTs.trim();
    if (!trimmed) return null;

    var parts = trimmed.split(',');
    if (parts.length === 2) {
      var timePart = parts[0].trim();
      var datePart = parts[1].trim();

      var dateSub = datePart.split(/[\/\-\.]/);
      if (dateSub.length === 3) {
        var num1 = parseInt(dateSub[0], 10);
        var num2 = parseInt(dateSub[1], 10);
        var year = parseInt(dateSub[2], 10);
        if (year < 100) year += 2000;

        var month, day;
        if (num1 > 12) {
          day = num1;
          month = num2;
        } else {
          month = num1;
          day = num2;
        }

        var timeMatch = timePart.match(/(\d+):(\d+)(?::(\d+))?\s*(AM|PM)?/i);
        if (timeMatch) {
          var hours = parseInt(timeMatch[1], 10);
          var mins = parseInt(timeMatch[2], 10);
          var secs = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
          var ampm = timeMatch[4] ? timeMatch[4].toUpperCase() : null;

          if (ampm === 'PM' && hours < 12) hours += 12;
          if (ampm === 'AM' && hours === 12) hours = 0;

          var d = new Date(Date.UTC(year, month - 1, day, hours, mins, secs));
          if (!isNaN(d.getTime())) {
            return d.toISOString();
          }
        }
      }
    }

    var dDirect = new Date(trimmed);
    if (!isNaN(dDirect.getTime())) {
      return dDirect.toISOString();
    }

    return null;
  }

  /**
   * Scopes extraction strictly to the active conversation panel.
   * Prioritises #main to ensure extraction targets the active conversation,
   * avoiding stale or hidden panels elsewhere in the DOM.
   * Never falls back to document.body.
   */
  function findConversationPanel() {
    var main = document.querySelector(SEL.mainPane);

    if (main) {
      // 1. Look for conversation panel strictly inside active #main
      var innerPanel = main.querySelector(SEL.conversationPanel);
      if (innerPanel) {
        return { el: innerPanel, method: '#main [data-testid="conversation-panel-messages"]' };
      }
      // 2. Safe fallback: #main itself (wraps all messages in active conversation)
      return { el: main, method: '#main (direct active pane)' };
    }

    // 3. Fallback: top-level conversation panel if #main selector failed
    var panel = document.querySelector(SEL.conversationPanel);
    if (panel) {
      return { el: panel, method: 'data-testid="conversation-panel-messages"' };
    }

    return null;
  }

  /**
   * Checks whether an element is a descendant of any selector in the exclude list.
   */
  function isDescendantOf(el, selectorList) {
    if (!el || !el.closest) return false;
    for (var i = 0; i < selectorList.length; i++) {
      if (el.closest(selectorList[i])) return true;
    }
    return false;
  }

  /**
   * Finds all primary message boundary containers strictly inside the conversation panel.
   * Primary: div[data-testid^="conv-msg-"]
   */
  function getMessageBoundaries(scope) {
    // 1. Primary: div[data-testid^="conv-msg-"]
    var convMsgEls = Array.from(scope.querySelectorAll(SEL.convMsgBoundary));
    if (convMsgEls.length > 0) {
      return convMsgEls;
    }

    // 2. Fallback: any element matching conv-msg testid
    var convFallback = Array.from(scope.querySelectorAll(SEL.convMsgFallback));
    if (convFallback.length > 0) {
      return convFallback;
    }

    // 3. Fallback: msg-container or message-in / message-out
    var msgContainers = Array.from(scope.querySelectorAll(SEL.msgContainer + ', .message-in, .message-out'));
    if (msgContainers.length > 0) {
      return msgContainers;
    }

    // 4. Fallback: non-empty [data-id] elements
    var dataIdEls = Array.from(scope.querySelectorAll(SEL.messageRow));
    return dataIdEls.filter(function (el) {
      var hasText = (el.innerText || el.textContent || '').trim().length > 0;
      var hasMedia = el.querySelector(SEL.mediaIndicators) !== null;
      return hasText || hasMedia;
    });
  }

  /**
   * Resolves a stable identifier from WhatsApp message DOM attributes if present.
   * Returns string ID if genuine ID found; null if boundary has no stable ID.
   */
  function getRawMessageId(boundary) {
    if (!boundary) return null;

    // 1. From [data-id] attribute on the boundary
    var dataId = boundary.getAttribute('data-id');
    if (dataId && dataId.trim() && dataId !== 'null') {
      return dataId.trim();
    }

    // 2. From data-testid="conv-msg-<id>"
    var testId = boundary.getAttribute('data-testid') || '';
    var convMatch = testId.match(/conv-msg-(.+)/);
    if (convMatch && convMatch[1]) {
      return convMatch[1].trim();
    }

    // 3. From inner element with [data-id]
    var innerDataId = boundary.querySelector('[data-id]');
    if (innerDataId) {
      var innerIdVal = innerDataId.getAttribute('data-id');
      if (innerIdVal && innerIdVal.trim() && innerIdVal !== 'null') {
        return innerIdVal.trim();
      }
    }

    return null;
  }

  /**
   * Resolves a stable identifier for a message boundary, falling back to a synthetic ID if missing.
   */
  function extractMessageId(boundary, index) {
    var raw = getRawMessageId(boundary);
    if (raw) return raw;
    return 'msg_' + index + '_' + Date.now();
  }

  /**
   * Checks whether the boundary, its enclosing message row, or any of its descendants
   * (strictly excluding quoted messages) possesses the specified CSS class.
   */
  function hasClassOutsideQuotes(boundary, className) {
    if (!boundary) return false;

    // 1. Check boundary element itself
    if (boundary.classList && boundary.classList.contains(className)) {
      return true;
    }

    // 2. Check enclosing message row (ancestor)
    if (boundary.closest) {
      var ancestor = boundary.closest('.' + className);
      if (ancestor) {
        var insideQuote = false;
        if (ancestor.closest && ancestor.closest(SEL.quotedMessage)) {
          insideQuote = true;
        }
        var isPanel = false;
        if (ancestor.matches) {
          isPanel = ancestor.matches(SEL.conversationPanel) || ancestor.matches(SEL.mainPane);
        } else if (ancestor.getAttribute) {
          isPanel = (ancestor.getAttribute('data-testid') === 'conversation-panel-messages') || (ancestor.id === 'main');
        }
        if (!insideQuote && !isPanel) {
          return true;
        }
      }
    }

    // 3. Check descendants, strictly excluding any inside quoted-message containers
    var elements = Array.from(boundary.querySelectorAll('.' + className));
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.closest) {
        if (!el.closest(SEL.quotedMessage)) {
          return true;
        }
      } else {
        var curr = el.parentElement;
        var inQuote = false;
        while (curr && curr !== boundary) {
          if (
            (curr.getAttribute && (curr.getAttribute('data-testid') || '').includes('quoted')) ||
            (curr.classList && curr.classList.contains('quoted-mention'))
          ) {
            inQuote = true;
            break;
          }
          curr = curr.parentElement;
        }
        if (!inQuote) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Determines message direction using two-tiered evidence:
   *
   * Tier 1 (Primary - Highest Priority):
   *   - Only tail-out exists -> 'sent'
   *   - Only tail-in exists  -> 'received'
   *   - Both tails exist     -> 'unknown' (ambiguous/conflict)
   *
   * Tier 2 (Secondary - When Neither Tail Exists):
   *   - Checked for clustered/intermediate bubbles where speech tails are omitted.
   *   - Inspects .message-out and .message-in outside quoted message containers.
   *   - Only message-out found -> 'sent'
   *   - Only message-in found  -> 'received'
   *   - Both or neither found  -> 'unknown'
   *
   * Does not use sender names, text, alignment, or color to infer direction.
   */
  function determineDirection(boundary) {
    if (!boundary) return 'unknown';

    // Find enclosing message row container if boundary is nested (e.g., div[data-testid^="conv-msg-"])
    var row = null;
    if (boundary.closest) {
      row = boundary.closest('.message-out, .message-in, [data-id]');
      if (row) {
        var isPanel = false;
        if (row.matches) {
          isPanel = row.matches(SEL.conversationPanel) || row.matches(SEL.mainPane);
        } else if (row.getAttribute) {
          isPanel = (row.getAttribute('data-testid') === 'conversation-panel-messages') || (row.id === 'main');
        }
        if (isPanel) {
          row = null;
        }
      }
    }
    var searchRoot = row || boundary;

    function hasTail(container, tailSelector, tailKeyword) {
      if (!container) return false;
      if (container.getAttribute) {
        var tid = container.getAttribute('data-testid') || '';
        if (tid.includes(tailKeyword)) return true;
      }
      var tails = Array.from(container.querySelectorAll(tailSelector));
      for (var i = 0; i < tails.length; i++) {
        var t = tails[i];
        if (t.closest) {
          if (!t.closest(SEL.quotedMessage)) {
            return true;
          }
        } else {
          return true;
        }
      }
      return false;
    }

    // Tier 1: Tail-based detection (highest priority)
    var hasTailOut = hasTail(boundary, SEL.tailOut, 'tail-out') || (searchRoot !== boundary && hasTail(searchRoot, SEL.tailOut, 'tail-out'));
    var hasTailIn = hasTail(boundary, SEL.tailIn, 'tail-in') || (searchRoot !== boundary && hasTail(searchRoot, SEL.tailIn, 'tail-in'));

    if (hasTailOut && !hasTailIn) {
      return 'sent';
    }
    if (hasTailIn && !hasTailOut) {
      return 'received';
    }
    if (hasTailOut && hasTailIn) {
      return 'unknown';
    }

    // Tier 2: Class-based fallback for intermediate bubbles without tails
    var hasMsgOut = hasClassOutsideQuotes(boundary, 'message-out');
    var hasMsgIn = hasClassOutsideQuotes(boundary, 'message-in');

    if (hasMsgOut && !hasMsgIn) {
      return 'sent';
    }
    if (hasMsgIn && !hasMsgOut) {
      return 'received';
    }

    // Neither exists, or both exist outside quotes
    return 'unknown';
  }

  /**
   * Determines active conversation chat type based strictly on positive evidence.
   * Only classifies 'group' when reliable positive group evidence is present.
   * Never classifies 'individual' from absence of group indicators or generic presence alone.
   * Otherwise returns 'unknown'.
   */
  function detectChatType(scope, boundaries) {
    // 1. Check message boundaries in scope for verified bubble-level author elements
    if (boundaries && boundaries.length > 0) {
      for (var i = 0; i < boundaries.length; i++) {
        if (boundaries[i].querySelector(SEL.author)) {
          return 'group';
        }
      }
    }

    // 2. Check active conversation header for reliable positive group indicators
    var main = document.querySelector(SEL.mainPane);
    var header = (main && main.querySelector('header')) || document.querySelector(SEL.chatHeader) || document.querySelector('header');
    if (header) {
      if (
        header.querySelector(SEL.groupIcon) ||
        header.querySelector('[data-testid="default-group"]') ||
        header.querySelector('[data-icon="default-group"]') ||
        header.querySelector('[data-testid="avatar-group"]')
      ) {
        return 'group';
      }
      var subtitleEl = header.querySelector(SEL.chatSubtitle) || header.querySelector('[data-testid="chat-subtitle"]');
      if (subtitleEl) {
        var subText = (subtitleEl.innerText || subtitleEl.textContent || '').trim();
        // Reliable group subtitle pattern: member count (e.g. "5 members") or participant list ("You, Alice, ...")
        if (/\b\d+\s+members\b/i.test(subText) || /,\s+/.test(subText)) {
          return 'group';
        }
      }
    }

    // 3. Fallback check inside scope for positive group markers
    if (scope) {
      if (
        scope.querySelector(SEL.groupIcon) ||
        scope.querySelector('[data-testid="default-group"]') ||
        scope.querySelector('[data-icon="default-group"]') ||
        scope.querySelector('[data-testid="avatar-group"]')
      ) {
        return 'group';
      }
    }

    // Default: strictly unknown without guessing or assuming individual
    return 'unknown';
  }

  /**
   * Safely gets the displayed conversation title from the active header.
   */
  function getConversationTitle() {
    var header = document.querySelector(SEL.chatHeader);
    if (!header) return null;
    var titleEl =
      header.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
      header.querySelector('span[title]') ||
      header.querySelector('[role="button"] span[dir="auto"]');
    if (titleEl) {
      var title = titleEl.getAttribute('title') || (titleEl.innerText || titleEl.textContent || '').trim();
      if (title && title.length > 0) return title;
    }
    return null;
  }

  /**
   * Resolves sender name without fabricating.
   *
   * Logic:
   *   1. Explicit parsed sender from data-pre-plain-text takes priority.
   *   2. Explicit outgoing direction ('sent') resolves to 'You' (never header title).
   *   3. For incoming group messages ('received' + 'group'), check verified bubble-level author element.
   *   4. Default: explicit 'unknown'. Never use header title as incoming sender fallback yet.
   */
  function determineSender(parsedSender, direction, chatType, boundary) {
    if (parsedSender) {
      if (parsedSender.toLowerCase() === 'you') return 'You';
      return parsedSender;
    }
    if (direction === 'sent') {
      return 'You';
    }
    if (direction === 'received' && chatType === 'group' && boundary) {
      var authorEl = boundary.querySelector(SEL.author);
      if (authorEl) {
        var authorText = (authorEl.innerText || authorEl.textContent || '').trim();
        if (authorText) {
          return authorText;
        }
      }
    }
    // Explicitly unknown — do not invent "Contact" or derive from header
    return 'unknown';
  }

  /**
   * Extracts text strictly from the message boundary's own content.
   * Avoids extracting twice by prioritizing selectable-text/document-caption
   * and ignoring enclosing .copyable-text wrappers once captured.
   * Excludes all descendants of [data-testid="quoted-message"] and .quoted-mention.
   * Excludes reactions and metadata.
   */
  function extractCleanText(boundary) {
    var rawCheck = (boundary.innerText || boundary.textContent || '').trim();
    if (!boundary || !rawCheck) {
      return '';
    }

    // 1. Primary: Look for genuine text-bearing elements (selectable-text and document-caption)
    var primaryEls = Array.from(boundary.querySelectorAll(
      SEL.selectableText + ', ' + SEL.documentCaption
    ));

    // Exclude any element inside quoted messages, reactions, or metadata
    var validPrimaryEls = primaryEls.filter(function (el) {
      if (isDescendantOf(el, EXCLUDE_SELECTORS)) {
        return false;
      }
      if (el.classList && el.classList.contains('quoted-mention')) {
        return false;
      }
      // Deduplicate nested selectables: exclude if nested inside another candidate in primaryEls
      var isNested = primaryEls.some(function (other) {
        return other !== el && other.contains(el);
      });
      return !isNested;
    });

    if (validPrimaryEls.length > 0) {
      var parts = validPrimaryEls.map(function (el) {
        return (el.innerText || el.textContent || '').trim();
      }).filter(Boolean);

      if (parts.length > 0) {
        // Successfully extracted from primary selectable elements — do NOT also read .copyable-text
        return parts.join('\n');
      }
    }

    // 2. Secondary: If no selectable-text elements, inspect .copyable-text (excluding quotes/reactions)
    var copyableEls = Array.from(boundary.querySelectorAll(SEL.copyableText));
    var validCopyables = copyableEls.filter(function (el) {
      if (isDescendantOf(el, EXCLUDE_SELECTORS)) return false;
      if (el.classList && el.classList.contains('quoted-mention')) return false;
      var isNested = copyableEls.some(function (other) {
        return other !== el && other.contains(el);
      });
      return !isNested;
    });

    if (validCopyables.length > 0) {
      for (var i = 0; i < validCopyables.length; i++) {
        var clone = validCopyables[i].cloneNode(true);
        // Strip any residual quoted or reaction elements
        EXCLUDE_SELECTORS.forEach(function (sel) {
          clone.querySelectorAll(sel).forEach(function (r) { r.remove(); });
        });
        var cText = (clone.innerText || clone.textContent || '').trim();
        if (cText) return cText;
      }
    }

    // 3. Fallback: If neither primary nor secondary text selectors isolated reliable message text,
    // do NOT blindly return raw boundary innerText or textContent which leaks timestamps,
    // delivery ticks, sender headers, or UI metadata. Return empty string so skip handling
    // properly classifies captionless media or empty containers.
    return '';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Extracts messages from the active conversation panel.
   * Triggered only on explicit user action.
   */
  window.WACI.extractMessages = function () {
    var mainEl = document.querySelector(SEL.mainPane);
    var allPanels = document.querySelectorAll(SEL.conversationPanel);
    var panelsInMain = mainEl ? mainEl.querySelectorAll(SEL.conversationPanel) : [];

    var result = {
      messages: [],
      meta: {
        extractorVersion: '2.1.0',
        extractedAt: new Date().toISOString(),
        panelMethod: null,
        panelTag: null,
        panelInsideMain: false,
        totalPanelsInDom: allPanels.length,
        panelsInsideMain: panelsInMain.length,
        convMsgPrefixCount: 0,
        divConvMsgPrefixCount: 0,
        dataIdCount: 0,
        selectableTextCount: 0,
        messageBoundariesFound: 0,
        validTextMessagesExtracted: 0,
        incomingCount: 0,
        outgoingCount: 0,
        unknownDirectionCount: 0,
        quotedMessagesExcluded: 0,
        mediaOnlyMessagesSkipped: 0,
        systemMessagesSkipped: 0,
        duplicateMessagesSkipped: 0,
        // Backward-compatibility aliases:
        candidateContainersFound: 0,
        validTextMessagesFound: 0,
        mediaOnlySkipped: 0,
        duplicateSkipped: 0,
        systemSkipped: 0,
        domMessageCount: 0,
        deduplicatedCount: 0,
        skippedNoText: 0,
        skippedSystem: 0,
        candidateDiagnostics: [],
        extractionFailures: [],
        warnings: [],
        limitations: [
          'Only messages currently rendered in the DOM are captured. WhatsApp virtualises the DOM.',
          'Media-only messages without captions are skipped.',
          'Unknown senders or directions are explicitly marked as "unknown" without guessing.',
        ],
      },
    };

    var panelResult = findConversationPanel();
    if (!panelResult) {
      result.meta.warnings.push(
        'Active conversation panel not found. Ensure WhatsApp Web is open and a conversation is actively selected.'
      );
      return result;
    }

    result.meta.panelMethod = panelResult.method;
    var scope = panelResult.el;
    result.meta.panelTag = scope ? scope.tagName : null;
    result.meta.panelInsideMain = (mainEl && scope) ? (scope === mainEl || mainEl.contains(scope)) : false;

    // Log actual result counts for diagnostic verification
    result.meta.convMsgPrefixCount = scope.querySelectorAll('[data-testid^="conv-msg-"]').length;
    result.meta.divConvMsgPrefixCount = scope.querySelectorAll('div[data-testid^="conv-msg-"]').length;
    result.meta.dataIdCount = scope.querySelectorAll('[data-id]').length;
    result.meta.selectableTextCount = scope.querySelectorAll('[data-testid="selectable-text"]').length;

    var boundaries = getMessageBoundaries(scope);
    result.meta.messageBoundariesFound = boundaries.length;
    result.meta.candidateContainersFound = boundaries.length;
    result.meta.domMessageCount = boundaries.length;

    if (boundaries.length === 0) {
      result.meta.warnings.push(
        'No message boundaries found in active conversation panel. Ensure chat has visible messages.'
      );
      return result;
    }

    var seenStableIds = new Set();
    var seenFallbackKeys = new Set();
    var convChatType = detectChatType(scope, boundaries);
    result.meta.conversationTitle = getConversationTitle();
    result.meta.chatType = convChatType;

    boundaries.forEach(function (boundary, index) {
      var rawId = getRawMessageId(boundary);
      var isStableId = rawId !== null;
      var messageId = isStableId ? rawId : ('msg_' + index + '_' + Date.now());

      // Chat type detection (strictly from positive evidence)
      var chatType = convChatType;
      if (chatType === 'unknown') {
        if (boundary.querySelector(SEL.author) || (messageId && messageId.includes('@g.us'))) {
          chatType = 'group';
        }
      }

      // Primary deduplication check by stable WhatsApp message ID
      if (isStableId) {
        if (seenStableIds.has(messageId)) {
          result.meta.duplicateMessagesSkipped++;
          result.meta.duplicateSkipped++;
          result.meta.candidateDiagnostics.push({
            index: index,
            status: 'rejected',
            reason: 'Duplicate message ID',
          });
          result.meta.extractionFailures.push({
            index: index,
            reason: 'Duplicate message ID',
          });
          return;
        }
      }

      // Metadata from data-pre-plain-text if available
      var metaEl = boundary.hasAttribute('data-pre-plain-text')
        ? boundary
        : boundary.querySelector(SEL.prePlainText);
      var rawMeta = metaEl ? metaEl.getAttribute('data-pre-plain-text') : null;
      var parsed = parsePrePlainText(rawMeta);

      // Determine direction strictly from tail markers
      var direction = determineDirection(boundary);

      // Determine sender without fabricating
      var sender = determineSender(parsed.sender, direction, chatType, boundary);

      // Timestamp
      var timestamp = parsed.timestamp || null;

      // Check for quoted message presence before text extraction
      var quotedEl = boundary.querySelector(SEL.quotedMessage);
      var hasQuotedContext = quotedEl !== null;
      if (hasQuotedContext) {
        result.meta.quotedMessagesExcluded++;
      }

      // Extract clean text strictly excluding quotes, reactions, meta
      var text = extractCleanText(boundary);

      // If no text, classify why
      if (!text) {
        var isMedia = boundary.querySelector(SEL.mediaIndicators) !== null;
        if (isMedia) {
          result.meta.mediaOnlyMessagesSkipped++;
          result.meta.mediaOnlySkipped++;
          result.meta.skippedNoText++;
          result.meta.candidateDiagnostics.push({
            index: index,
            status: 'rejected',
            reason: 'Media-only message (audio/image/video/sticker without extractable caption)',
          });
          result.meta.extractionFailures.push({
            index: index,
            reason: 'Media-only message (audio/image/video/sticker without extractable caption)',
          });
        } else {
          result.meta.systemMessagesSkipped++;
          result.meta.systemSkipped++;
          result.meta.skippedSystem++;
          result.meta.candidateDiagnostics.push({
            index: index,
            status: 'rejected',
            reason: 'System notice, date divider, or container with no extractable text',
          });
          result.meta.extractionFailures.push({
            index: index,
            reason: 'System notice, date divider, or container with no extractable text',
          });
        }
        return;
      }

      // Deduplication check:
      // If the message has a valid stable ID, it is preserved (already deduplicated by ID above).
      // If message lacks a stable ID, apply cautious fallback deduplication only when
      // there is reliable evidence of duplication (same reliable sender AND same timestamp AND same text).
      if (!isStableId) {
        var hasReliableMeta = sender && sender !== 'unknown' && timestamp && timestamp.trim().length > 0;
        if (hasReliableMeta) {
          var fallbackKey = sender + '|' + timestamp + '|' + text;
          if (seenFallbackKeys.has(fallbackKey)) {
            result.meta.duplicateMessagesSkipped++;
            result.meta.duplicateSkipped++;
            result.meta.candidateDiagnostics.push({
              index: index,
              status: 'rejected',
              reason: 'Duplicate message content without stable ID',
            });
            result.meta.extractionFailures.push({
              index: index,
              reason: 'Duplicate message content without stable ID',
            });
            return;
          }
          seenFallbackKeys.add(fallbackKey);
        }
      } else {
        // Track reliable content key for stable ID messages so duplicate nodes lacking IDs can be matched
        if (sender && sender !== 'unknown' && timestamp && timestamp.trim().length > 0) {
          seenFallbackKeys.add(sender + '|' + timestamp + '|' + text);
        }
        seenStableIds.add(messageId);
      }

      // Count direction
      if (direction === 'sent') {
        result.meta.outgoingCount++;
      } else if (direction === 'received') {
        result.meta.incomingCount++;
      } else {
        result.meta.unknownDirectionCount++;
      }

      var isCaption = boundary.querySelector(SEL.documentCaption) !== null;
      var normDirection = (direction === 'sent') ? 'outgoing' : ((direction === 'received') ? 'incoming' : 'unknown');
      var normTimestamp = normalizeTimestamp(timestamp);

      var messageObj = {
        id: messageId || null,
        text: text,
        sender: sender || 'unknown',
        timestamp: normTimestamp,
        direction: normDirection,
        messageType: isCaption ? 'media_caption' : 'text',
        // Internal metadata preserved for UI & backward compatibility
        chatType: chatType,
        hasQuotedContext: hasQuotedContext,
        rawTimestamp: timestamp || null,
        rawDirection: direction,
      };

      result.messages.push(messageObj);

      result.meta.candidateDiagnostics.push({
        index: index,
        status: 'accepted',
        direction: direction,
        reason: 'Valid text message (length: ' + text.length + ')',
      });
    });

    result.meta.validTextMessagesExtracted = result.messages.length;
    result.meta.validTextMessagesFound = result.messages.length;
    result.meta.deduplicatedCount = result.messages.length;

    if (result.messages.length === 0 && result.meta.messageBoundariesFound > 0) {
      result.meta.warnings.push(
        'Found ' + result.meta.messageBoundariesFound + ' boundaries, but none yielded valid text messages. ' +
        '(' + result.meta.mediaOnlyMessagesSkipped + ' media, ' + result.meta.systemMessagesSkipped + ' system/empty).'
      );
    }

    return result;
  };

  // Expose helpers for testing and modular invocation
  window.WACI.parsePrePlainText = parsePrePlainText;
  window.WACI.normalizeTimestamp = normalizeTimestamp;
  window.WACI.determineDirection = determineDirection;
  window.WACI.determineSender = determineSender;
  window.WACI.detectChatType = detectChatType;
  window.WACI.getConversationTitle = getConversationTitle;
})();
