'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const extractorPath = path.resolve(__dirname, '../../extension/src/content/extractor.js');
const extractorSource = fs.readFileSync(extractorPath, 'utf8');

function makeTextNode(text, quoted) {
  return {
    innerText: text,
    textContent: text,
    classList: { contains: () => false },
    closest(selector) {
      return quoted && selector.indexOf('quoted') >= 0 ? this : null;
    },
    contains: () => false,
  };
}

function makeBoundary(id, textNodes, options) {
  const settings = options || {};
  const classes = new Set(settings.classes || []);
  const boundary = {
    tagName: 'DIV',
    innerText: textNodes.map((node) => node.innerText).join('\n') || settings.rawText || '',
    textContent: textNodes.map((node) => node.textContent).join('\n') || settings.rawText || '',
    classList: { contains: (name) => classes.has(name) },
    matches: () => false,
    hasAttribute: () => false,
    getAttribute(name) {
      if (name === 'data-testid') return settings.testId || (id ? 'conv-msg-' + id : '');
      return null;
    },
    closest(selector) {
      if (selector.indexOf('.message-out') >= 0 && classes.has('message-out')) return this;
      if (selector.indexOf('.message-in') >= 0 && classes.has('message-in')) return this;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.indexOf('selectable-text') >= 0 || selector.indexOf('document-caption') >= 0) return textNodes;
      if (selector.indexOf('tail-out') >= 0 && settings.tailOut) return [{ closest: () => null }];
      if (selector.indexOf('tail-in') >= 0 && settings.tailIn) return [{ closest: () => null }];
      if (selector === '.message-out' && classes.has('message-out')) return [this];
      if (selector === '.message-in' && classes.has('message-in')) return [this];
      return [];
    },
    querySelector(selector) {
      if (selector.indexOf('media') >= 0 && settings.media) return {};
      if (selector.indexOf('author') >= 0 && settings.author) {
        return { innerText: settings.author, textContent: settings.author };
      }
      return null;
    },
  };
  return boundary;
}

function loadExtractor(boundaries) {
  const scope = {
    tagName: 'MAIN',
    contains: (element) => element === scope,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector.indexOf('conv-msg-') >= 0) return boundaries;
      if (selector === '[data-id]') return [];
      if (selector.indexOf('selectable-text') >= 0) {
        return boundaries.reduce((all, boundary) => all.concat(
          boundary.querySelectorAll('[data-testid="selectable-text"]')
        ), []);
      }
      return [];
    },
  };
  const document = {
    querySelector: (selector) => selector === '#main' ? scope : null,
    querySelectorAll: () => [],
  };
  const window = {};
  vm.runInNewContext(extractorSource, { window, document });
  return window.WACI;
}

test('parses WhatsApp sender metadata and does not fabricate a timestamp', () => {
  const waci = loadExtractor([]);
  const parsed = waci.parsePrePlainText('[9:41 AM, 10/31/2026] Meera: ');
  assert.equal(parsed.timestamp, '9:41 AM, 10/31/2026');
  assert.equal(parsed.sender, 'Meera');
  assert.equal(waci.normalizeTimestamp(null), null);
  assert.equal(waci.determineSender(null, 'sent', 'individual', null), 'You');
  assert.equal(waci.determineSender(null, 'unknown', 'individual', null), 'unknown');
  assert.equal(waci.determineSender(null, 'received', 'group', makeBoundary('group', [], { author: 'Meera' })), 'Meera');
});

test('direction requires positive DOM evidence and preserves unknown', () => {
  const waci = loadExtractor([]);
  assert.equal(waci.determineDirection(makeBoundary('out', [], { classes: ['message-out'] })), 'sent');
  assert.equal(waci.determineDirection(makeBoundary('in', [], { tailIn: true })), 'received');
  assert.equal(waci.determineDirection(makeBoundary('unknown', [])), 'unknown');
  assert.equal(waci.determineDirection(makeBoundary('conflict', [], { tailIn: true, tailOut: true })), 'unknown');
});

test('keeps distinct identical messages, skips duplicate IDs, and excludes quoted text', () => {
  const boundaries = [
    makeBoundary('first', [makeTextNode('Same text', false), makeTextNode('Quoted words', true)], { classes: ['message-out'] }),
    makeBoundary('second', [makeTextNode('Same text', false)]),
    makeBoundary('second', [makeTextNode('Duplicate DOM copy', false)]),
  ];
  const result = loadExtractor(boundaries).extractMessages();
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].text, 'Same text');
  assert.equal(result.messages[1].text, 'Same text');
  assert.equal(result.messages[0].direction, 'outgoing');
  assert.equal(result.messages[1].direction, 'unknown');
  assert.equal(result.meta.unknownDirectionCount, 1);
  assert.equal(result.meta.duplicateMessagesSkipped, 1);
  assert.equal(JSON.stringify(result.meta).includes('first'), false);
  assert.equal(JSON.stringify(result.meta).includes('second'), false);
});

test('reports media-only and empty/system boundaries without fabricating message text', () => {
  const result = loadExtractor([
    makeBoundary('media', [], { rawText: 'Photo', media: true }),
    makeBoundary('system', [], { rawText: '' }),
  ]).extractMessages();
  assert.equal(result.messages.length, 0);
  assert.equal(result.meta.mediaOnlyMessagesSkipped, 1);
  assert.equal(result.meta.systemMessagesSkipped, 1);
});
