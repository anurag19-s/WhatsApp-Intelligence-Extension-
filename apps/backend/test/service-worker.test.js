'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const sourcePath = path.resolve(__dirname, '../../extension/src/background/service-worker.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadWorker(options) {
  const settings = options || {};
  let onMessage;
  let tabQueries = 0;
  const chrome = {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    runtime: {
      lastError: null,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (listener) => { onMessage = listener; } },
    },
    storage: {
      local: {
        get: (defaults, callback) => callback({
          backendBaseUrl: settings.backendBaseUrl || defaults.backendBaseUrl,
        }),
      },
    },
    tabs: {
      query: async () => {
        tabQueries += 1;
        return [{ id: 8, url: settings.activeUrl || 'https://web.whatsapp.com/' }];
      },
      sendMessage: () => {},
    },
  };
  vm.runInNewContext(source, {
    chrome,
    fetch: settings.fetch || (async () => { throw new Error('Unexpected fetch'); }),
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    console: { log() {}, warn() {} },
    Date,
  });
  return {
    tabQueries: () => tabQueries,
    dispatch: (message) => new Promise((resolve) => {
      const keepOpen = onMessage(message, {}, resolve);
      if (keepOpen === false) resolve({ ok: true });
    }),
  };
}

test('service worker forwards only selected analysis fields and handles backend success', async () => {
  let requested;
  const worker = loadWorker({
    fetch: async (url, options) => {
      requested = { url, payload: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          data: { executiveSummary: 'Mock report', meta: { provider: 'mock', isMock: true } },
        }),
      };
    },
  });
  const response = await worker.dispatch({
    type: 'ANALYZE_SELECTED_MESSAGES',
    payload: {
      conversation: { title: 'Planning', chatType: 'group' },
      unselectedMessages: [{ id: 'm2', text: 'Not selected' }],
      messages: [{
        id: 'm1',
        text: 'Selected',
        sender: 'Asha',
        timestamp: null,
        direction: 'unknown',
        rawDirection: 'private metadata',
        hasQuotedContext: true,
      }],
    },
  });
  assert.equal(response.ok, true);
  assert.equal(requested.url, 'http://127.0.0.1:3001/api/analyze');
  assert.deepEqual(Object.keys(requested.payload.messages[0]).sort(), [
    'direction', 'id', 'sender', 'text', 'timestamp',
  ]);
  assert.equal(requested.payload.messages.length, 1);
  assert.equal(Object.hasOwn(requested.payload, 'unselectedMessages'), false);
});

test('service worker uses a saved loopback backend URL and surfaces provider health', async () => {
  const requestedUrls = [];
  const worker = loadWorker({
    backendBaseUrl: 'http://localhost:3010/',
    fetch: async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', provider: 'ollama', model: 'qwen2.5:3b' }),
        text: async () => JSON.stringify({
          ok: true,
          data: { meta: { provider: 'ollama', model: 'qwen2.5:3b', isMock: false } },
        }),
      };
    },
  });
  const health = await worker.dispatch({ type: 'CHECK_BACKEND_HEALTH' });
  assert.equal(health.connected, true);
  assert.equal(health.data.provider, 'ollama');
  const analysis = await worker.dispatch({
    type: 'ANALYZE_SELECTED_MESSAGES',
    payload: {
      conversation: { title: 'Planning', chatType: 'group' },
      messages: [{ id: 'm1', text: 'Selected', sender: 'Asha', timestamp: null, direction: 'unknown' }],
    },
  });
  assert.equal(analysis.data.meta.provider, 'ollama');
  assert.deepEqual(requestedUrls, [
    'http://localhost:3010/health',
    'http://localhost:3010/api/analyze',
  ]);
});

test('service worker rejects a non-loopback backend URL without sending requests', async () => {
  let fetchCalls = 0;
  const worker = loadWorker({
    backendBaseUrl: 'http://example.com',
    fetch: async () => { fetchCalls += 1; },
  });
  const response = await worker.dispatch({
    type: 'ANALYZE_SELECTED_MESSAGES',
    payload: {
      conversation: { title: 'Planning', chatType: 'group' },
      messages: [{ id: 'm1', text: 'Selected', sender: 'Asha', timestamp: null, direction: 'unknown' }],
    },
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /localhost or 127\.0\.0\.1/);
  assert.equal(fetchCalls, 0);
});

test('service worker propagates backend validation errors and hides malformed response bodies', async () => {
  const invalid = loadWorker({
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, error: 'Invalid message structure.' }),
    }),
  });
  assert.equal((await invalid.dispatch({
    type: 'ANALYZE_SELECTED_MESSAGES',
    payload: { conversation: {}, messages: [{ id: 'm1', text: 'x', sender: 'A', direction: 'unknown' }] },
  })).error, 'Invalid message structure.');

  const malformed = loadWorker({
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => 'secret internal response body',
    }),
  });
  const malformedResponse = await malformed.dispatch({
    type: 'ANALYZE_SELECTED_MESSAGES',
    payload: { conversation: {}, messages: [{ id: 'm1', text: 'x', sender: 'A', direction: 'unknown' }] },
  });
  assert.equal(malformedResponse.ok, false);
  assert.equal(malformedResponse.error.includes('secret internal'), false);
});

test('extraction is restricted to the active WhatsApp tab', async () => {
  const worker = loadWorker({ activeUrl: 'https://example.com/' });
  const response = await worker.dispatch({ type: 'EXTRACT_MESSAGES' });
  assert.equal(response.ok, false);
  assert.match(response.error, /active tab is not WhatsApp Web/);
  assert.equal(worker.tabQueries(), 1);
});
