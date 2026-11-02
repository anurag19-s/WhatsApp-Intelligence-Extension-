/**
 * WA Corporate Intelligence - DOM Inspector (Diagnostic Mode) v2
 *
 * Structural investigation of the WhatsApp Web DOM.
 * Reports ONLY element structure, attribute presence/shape, and counts.
 * No message content, contact names, phone numbers, or user data is read.
 *
 * v2 changes vs v1:
 *   - Anchors UPWARD from .copyable-text to find the true message container.
 *   - Audits ALL [data-id] elements to classify what they actually represent.
 *   - Scans for ARIA roles that may identify message rows.
 *   - Inventories data-testid values present in the conversation panel.
 *   - Checks whether [data-id] and .copyable-text share a common ancestor path.
 *
 * The previous diagnostic found:
 *   - 16 [data-id] elements with unknown direction/chatType (not true_/false_ prefixed)
 *   - 20 .copyable-text elements that are NOT descendants of those [data-id] elements
 *   This version investigates why and where the real message container is.
 *
 * Loaded before extractor.js. Attaches to window.WACI namespace.
 */

(function () {
  'use strict';

  window.WACI = window.WACI || {};

  // ---------------------------------------------------------------------------
  // Selectors (only documented/stable attributes)
  // ---------------------------------------------------------------------------
  var LANDMARKS = {
    conversationPanel:  '[data-testid="conversation-panel-messages"]',
    mainPane:           '#main',
    composerPrimary:    '[data-testid="conversation-compose-box-input"]',
    composerFallback:   '[contenteditable="true"][data-tab]',
    composerAriaFb:     'footer [role="textbox"]',
    chatHeader:         '[data-testid="conversation-header"]',
    convMsg:            '[data-testid^="conv-msg-"], [data-testid*="conv-msg"]',
    messageRow:         '[data-id]',
    copyableText:       '.copyable-text',
    selectableText:     '[data-testid="selectable-text"]',
    documentCaption:    '[data-testid="document-caption"]',
    quotedMessage:      '[data-testid="quoted-message"]',
  };

  // ARIA roles commonly used on list/row containers in React apps
  var CANDIDATE_ROLES = ['row', 'listitem', 'article', 'group', 'gridcell', 'option', 'presentation'];

  // ---------------------------------------------------------------------------
  // Privacy-safe attribute reporter
  // Reports attribute structure without exposing values that could be PII.
  // ---------------------------------------------------------------------------
  function safeAttr(name, value) {
    if (name === 'data-pre-plain-text') {
      // Shape only — never the actual sender name or timestamp value
      return {
        present: true,
        length: value.length,
        startsWithBracket: value.charAt(0) === '[',
        matchesPattern: /^\[[^\]]+\]\s*.+:\s*$/.test(value),
      };
    }
    if (name === 'data-id') {
      // Format only — never the actual phone number or message ID
      return {
        startsWithTrue:  value.startsWith('true_'),
        startsWithFalse: value.startsWith('false_'),
        containsAtCUs:   value.includes('@c.us'),
        containsAtGUs:   value.includes('@g.us'),
        containsAtBroadcast: value.includes('@broadcast'),
        length: value.length,
      };
    }
    if (name === 'data-testid') {
      return safeTestId(value);
    }
    if (name === 'aria-label' || name === 'title' || name === 'aria-roledescription') {
      // Presence + length only — aria-label on message rows often encodes sender name
      return { present: true, length: value.length };
    }
    if (name === 'class') {
      // CSS classes are structural metadata — safe to report in full
      return value;
    }
    if (name.startsWith('data-') || name === 'id') {
      return { present: true, length: value.length };
    }
    return value;
  }

  function safeTestId(value) {
    if (value.indexOf('conv-msg-') === 0) return 'conv-msg-[message]';
    return value;
  }

  /**
   * Collects safe attribute descriptors for a DOM element.
   * Only reports data-*, role, aria-*, tabindex, dir, class, and id.
   */
  function collectAttrs(el) {
    var out = {};
    var attrs = el.attributes;
    if (!attrs) return out;
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      var n = a.name;
      if (
        n.startsWith('data-') ||
        n === 'role' || n === 'class' || n === 'id' ||
        n === 'tabindex' || n === 'dir' ||
        n.startsWith('aria-')
      ) {
        out[n] = safeAttr(n, a.value);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Investigation 1: Upward anchor scan from .copyable-text
  //
  // For each .copyable-text, walk UP through ancestors to the conversation panel.
  // This reveals WHERE meaningful identifiers (data-id, role, aria-label, etc.)
  // actually live relative to the text content.
  // ---------------------------------------------------------------------------
  function anchorUpFromCopyable(scope) {
    var copyables = Array.from(scope.querySelectorAll(LANDMARKS.copyableText));
    // Sample first 4 to get a representative picture
    var samples = copyables.slice(0, 4);

    return samples.map(function (el, sampleIdx) {
      var chain = [];
      var current = el;
      var depth = 0;
      var MAX_DEPTH = 20;

      while (current && current !== scope && depth < MAX_DEPTH) {
        chain.push({
          depth:            depth,
          tag:              current.tagName,
          childCount:       current.childElementCount,
          attributes:       collectAttrs(current),
          hasDataId:        current.hasAttribute('data-id'),
          hasDataTestId:    current.hasAttribute('data-testid'),
          hasRole:          current.hasAttribute('role'),
          hasCopyableClass: (current.className || '').indexOf('copyable-text') !== -1,
        });

        // Stop early once we hit an element that looks like a message boundary
        // (has data-id with true_/false_ prefix, or role="row"/"listitem"/"article")
        var dataId = current.getAttribute('data-id');
        var role   = current.getAttribute('role');
        var isMessageBoundary =
          (dataId && (dataId.startsWith('true_') || dataId.startsWith('false_'))) ||
          (role && ['row', 'listitem', 'article'].indexOf(role) !== -1);

        current = current.parentElement;
        depth++;

        if (isMessageBoundary && depth > 1) {
          // Note the boundary was found and stop ascending
          chain[chain.length - 1]._messageBoundaryFound = true;
          break;
        }
      }

      // Record whether ANY ancestor had a true_/false_ data-id
      var foundDirectionDataId = chain.some(function (node) {
        var di = node.attributes['data-id'];
        return di && (di.startsWithTrue || di.startsWithFalse);
      });

      // Record the shallowest ancestor depth that has data-id at all
      var firstDataIdDepth = null;
      chain.forEach(function (node) {
        if (node.hasDataId && firstDataIdDepth === null) {
          firstDataIdDepth = node.depth;
        }
      });

      var firstRoleDepth = null;
      chain.forEach(function (node) {
        if (node.hasRole && firstRoleDepth === null) {
          firstRoleDepth = node.depth;
        }
      });

      return {
        sampleIndex:         sampleIdx,
        totalAncestorsWalked: chain.length,
        foundDirectionDataId: foundDirectionDataId,
        firstDataIdDepth:    firstDataIdDepth,
        firstRoleDepth:      firstRoleDepth,
        chain:               chain,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Investigation 2: Audit all [data-id] elements
  //
  // Reports what each [data-id] element actually is — tag name, data-id format,
  // whether it contains .copyable-text, direct child structure, etc.
  // Determines if these are message rows, conversation list items, or other elements.
  // ---------------------------------------------------------------------------
  function auditDataIdElements(scope) {
    var els = Array.from(scope.querySelectorAll(LANDMARKS.messageRow));

    return els.map(function (el, idx) {
      var dataId       = el.getAttribute('data-id') || '';
      var directChildTags = Array.from(el.children)
        .slice(0, 6)
        .map(function (c) { return c.tagName; });

      // Check if any .copyable-text exists inside this element
      var copyableCount = el.querySelectorAll(LANDMARKS.copyableText).length;

      // Check if any [data-pre-plain-text] exists inside
      var prePlainCount = el.querySelectorAll('[data-pre-plain-text]').length;

      // Check children for data-testid hints
      var testIds = Array.from(el.querySelectorAll('[data-testid]'))
        .slice(0, 5)
        .map(function (c) { return safeTestId(c.getAttribute('data-testid') || ''); });

      return {
        index: idx,
        tag:   el.tagName,
        dataIdShape: safeAttr('data-id', dataId),
        elementRole:    el.getAttribute('role') || null,
        elementClass:   el.className || null,
        childElementCount: el.childElementCount,
        directChildTags:   directChildTags,
        copyableTextDescendantCount: copyableCount,
        prePlainTextDescendantCount: prePlainCount,
        dataTestIdDescendants:       testIds,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Investigation 3: ARIA role scan
  //
  // Checks candidate ARIA roles for elements that might be the true message rows.
  // For each role found, reports structure of the first matching element.
  // ---------------------------------------------------------------------------
  function scanAriaRoles(scope) {
    var result = {};

    CANDIDATE_ROLES.forEach(function (role) {
      var matches = scope.querySelectorAll('[role="' + role + '"]');
      if (matches.length === 0) return;

      var first = matches[0];
      var firstCopyableCount = first.querySelectorAll(LANDMARKS.copyableText).length;

      result[role] = {
        totalCount:  matches.length,
        firstTag:    first.tagName,
        firstAttributes: collectAttrs(first),
        firstCopyableTextDescendants: firstCopyableCount,
        firstChildTags: Array.from(first.children)
          .slice(0, 6)
          .map(function (c) { return c.tagName; }),
        // Does the first element with this role look like a message container?
        looksLikeMessageRow:
          firstCopyableCount > 0 ||
          !!first.querySelector('[data-pre-plain-text]'),
      };
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Investigation 4: data-testid inventory
  //
  // Lists all unique data-testid values present in the conversation panel scope.
  // These are the most stable WhatsApp Web identifiers (used by their own QA).
  // ---------------------------------------------------------------------------
  function inventoryTestIds(scope) {
    var allTestIdEls = scope.querySelectorAll('[data-testid]');
    var counts = {};

    Array.from(allTestIdEls).forEach(function (el) {
      var tid = safeTestId(el.getAttribute('data-testid') || '');
      counts[tid] = (counts[tid] || 0) + 1;
    });

    // Also record whether any testid-bearing element has .copyable-text descendants
    var tidsWithCopyable = {};
    Array.from(allTestIdEls).forEach(function (el) {
      var tid = safeTestId(el.getAttribute('data-testid') || '');
      if (!tidsWithCopyable[tid] && el.querySelector(LANDMARKS.copyableText)) {
        tidsWithCopyable[tid] = true;
      }
    });

    return {
      uniqueTestIds: counts,
      testIdsContainingCopyableText: Object.keys(tidsWithCopyable),
    };
  }

  // ---------------------------------------------------------------------------
  // Investigation 5: Direct parent of .copyable-text
  //
  // Quick report: what is the direct parent tag and attributes of each
  // .copyable-text element? This is the shallowest structural relationship.
  // ---------------------------------------------------------------------------
  function copyableParentSurvey(scope) {
    var copyables = Array.from(scope.querySelectorAll(LANDMARKS.copyableText));

    // Group by parent tag to detect patterns
    var parentTagCounts = {};
    var parentAttrSamples = {};

    copyables.forEach(function (el) {
      var parent = el.parentElement;
      if (!parent) return;
      var tag = parent.tagName;
      parentTagCounts[tag] = (parentTagCounts[tag] || 0) + 1;

      if (!parentAttrSamples[tag]) {
        parentAttrSamples[tag] = collectAttrs(parent);
      }
    });

    return {
      parentTagDistribution: parentTagCounts,
      attributeSampleByTag:  parentAttrSamples,
    };
  }

  // ---------------------------------------------------------------------------
  // Main diagnostic entry point (replaces v1 implementation)
  // ---------------------------------------------------------------------------
  window.WACI.runDomDiagnostic = function () {
    var report = {
      _version:     2,
      timestamp:    new Date().toISOString(),
      url:          'https://web.whatsapp.com/',
      isWhatsAppWeb: window.location.hostname === 'web.whatsapp.com',
      // Top-level landmarks (unchanged from v1 — sidepanel.js depends on these)
      landmarks: {},
      // v2 investigations
      investigations: {},
      warnings:       [],
      recommendations: [],
      extractorReady: false,
    };

    if (!report.isWhatsAppWeb) {
      report.warnings.push('Not running on web.whatsapp.com.');
      return report;
    }

    // ---- Landmark checks ----
    var panel = document.querySelector(LANDMARKS.conversationPanel);
    report.landmarks.conversationPanel = { found: !!panel, selector: LANDMARKS.conversationPanel };

    var mainPane = document.querySelector(LANDMARKS.mainPane);
    report.landmarks.mainPane = { found: !!mainPane };

    if (!panel && !mainPane) {
      report.warnings.push('Neither conversation panel nor #main found. WhatsApp Web may still be loading.');
      return report;
    }

    var scope = panel || mainPane || document.body;
    report.landmarks.searchScope = panel ? 'conversationPanel' : '#main';

    var composer =
      document.querySelector(LANDMARKS.composerPrimary) ||
      document.querySelector(LANDMARKS.composerFallback) ||
      document.querySelector(LANDMARKS.composerAriaFb);
    report.landmarks.composer = { found: !!composer };

    var chatHeader = document.querySelector(LANDMARKS.chatHeader);
    report.landmarks.chatHeader = { found: !!chatHeader };

    var allConvMsgs    = scope.querySelectorAll(LANDMARKS.convMsg);
    var allDataIds     = scope.querySelectorAll(LANDMARKS.messageRow);
    var allCopyables   = scope.querySelectorAll(LANDMARKS.copyableText);
    var allSelectables = scope.querySelectorAll(LANDMARKS.selectableText);
    var allCaptions    = scope.querySelectorAll(LANDMARKS.documentCaption);
    var allQuoted      = scope.querySelectorAll(LANDMARKS.quotedMessage);

    report.landmarks.counts = {
      convMsgElements:         allConvMsgs.length,
      selectableTextElements:  allSelectables.length,
      documentCaptionElements: allCaptions.length,
      copyableElements:        allCopyables.length,
      dataIdElements:          allDataIds.length,
      quotedElements:          allQuoted.length,
    };

    // ---- Mismatch detection ----
    if (allDataIds.length > 0 && allCopyables.length > 0) {
      // Check how many [data-id] elements actually contain a .copyable-text
      var dataIdsWithCopyable = Array.from(allDataIds).filter(function (el) {
        return el.querySelector(LANDMARKS.copyableText) !== null;
      }).length;

      report.landmarks.counts.dataIdElementsWithCopyableDescendant = dataIdsWithCopyable;

      if (dataIdsWithCopyable === 0) {
        report.warnings.push(
          'MISMATCH: ' + allDataIds.length + ' [data-id] elements found but NONE contain a .copyable-text descendant. ' +
          '[data-id] is likely not on the message bubble element. Ancestry investigation required.'
        );
      }
    }

    // ---- v2 Investigations ----

    report.investigations.dataIdAudit = auditDataIdElements(scope);

    report.investigations.anchorUpFromCopyable = anchorUpFromCopyable(scope);

    report.investigations.ariaRoleScan = scanAriaRoles(scope);

    report.investigations.dataTestIdInventory = inventoryTestIds(scope);

    report.investigations.copyableParentSurvey = copyableParentSurvey(scope);

    // ---- Derive recommendations from investigations ----

    // Does any role look like a reliable message row?
    var rolesWithCopyable = Object.keys(report.investigations.ariaRoleScan).filter(function (role) {
      return report.investigations.ariaRoleScan[role].looksLikeMessageRow;
    });
    if (rolesWithCopyable.length > 0) {
      report.recommendations.push(
        'ARIA role(s) containing .copyable-text found: [' + rolesWithCopyable.join(', ') + ']. ' +
        'These may be the true message row containers. Inspect ariaRoleScan for details.'
      );
    }

    // Did any copyable-text ancestor chain find a true_/false_ data-id?
    var ancestorDataIdFinds = report.investigations.anchorUpFromCopyable.filter(function (s) {
      return s.foundDirectionDataId;
    });
    if (ancestorDataIdFinds.length > 0) {
      report.recommendations.push(
        'true_/false_ prefixed data-id found in ancestry of .copyable-text at sample(s): ' +
        ancestorDataIdFinds.map(function (s) { return s.sampleIndex; }).join(', ') + '. ' +
        'Check anchorUpFromCopyable[n].firstDataIdDepth for which ancestor level carries it.'
      );
    } else if (allCopyables.length > 0) {
      report.recommendations.push(
        'No true_/false_ data-id found in any .copyable-text ancestor chain. ' +
        'The direction identifier may use a different attribute or pattern. ' +
        'Check dataTestIdInventory and ariaRoleScan for alternative message identifiers.'
      );
    }

    // Are there any data-testid values that co-locate with .copyable-text?
    var tidsNearCopyable = report.investigations.dataTestIdInventory.testIdsContainingCopyableText;
    if (tidsNearCopyable.length > 0) {
      report.recommendations.push(
        'data-testid value(s) found on elements that contain .copyable-text: [' +
        tidsNearCopyable.join(', ') + ']. ' +
        'These are strong candidates for the stable message container selector.'
      );
    }

    report.extractorReady =
      !!composer &&
      (allConvMsgs.length > 0 || allSelectables.length > 0 || allCopyables.length > 0) &&
      (allConvMsgs.length > 0 || dataIdsWithCopyable > 0 || rolesWithCopyable.length > 0 || ancestorDataIdFinds.length > 0 || tidsNearCopyable.length > 0);

    if (!report.extractorReady) {
      report.warnings.push(
        'Extractor is NOT ready. The message container structure is not yet resolved. ' +
        'Review investigations to identify the correct message row selector before proceeding.'
      );
    }

    return report;
  };

})();
