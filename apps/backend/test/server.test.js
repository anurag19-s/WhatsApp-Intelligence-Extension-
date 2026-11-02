'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer, readConfig } = require('../src/server');
const { createAnalysisService } = require('../src/services');

const validPayload = {
  conversation: { title: 'Test chat', chatType: 'individual' },
  messages: [{
    id: 'm-1',
    text: 'Can you share the proposal?',
    sender: 'Asha',
    timestamp: null,
    direction: 'unknown',
  }],
};

async function withServer(run, overrides) {
  const config = Object.assign({
    host: '127.0.0.1',
    port: 0,
    provider: 'mock',
    model: 'test-model',
    apiKey: '',
    timeoutMs: 1000,
    allowFallback: false,
  }, overrides || {});
  const server = createServer({
    config,
    analyze: createAnalysisService(config),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('loads only loopback host and resolves provider configuration', () => {
  assert.equal(readConfig({}).port, 3001);
  assert.equal(readConfig({}).host, '127.0.0.1');
  assert.equal(readConfig({}).provider, 'mock');
  assert.equal(readConfig({ ANTHROPIC_API_KEY: 'configured' }).provider, 'anthropic');
  assert.equal(readConfig({ AI_PROVIDER: 'auto', ANTHROPIC_API_KEY: 'configured' }).provider, 'anthropic');
  const ollama = readConfig({ AI_PROVIDER: 'ollama', AI_TIMEOUT_MS: '120000' });
  assert.equal(ollama.provider, 'ollama');
  assert.equal(ollama.ollamaBaseUrl, 'http://127.0.0.1:11434');
  assert.equal(ollama.ollamaModel, 'qwen2.5:3b');
  assert.equal(ollama.timeoutMs, 120000);
  assert.equal(readConfig({
    AI_PROVIDER: 'ollama',
    OLLAMA_BASE_URL: 'http://localhost:11434/',
    OLLAMA_MODEL: 'custom-model',
  }).ollamaModel, 'custom-model');
  assert.throws(() => readConfig({ HOST: '0.0.0.0' }), /loopback-only/);
});

test('rejects Ollama URLs outside local HTTP and missing model configuration', () => {
  for (const url of [
    'https://127.0.0.1:11434',
    'http://example.com:11434',
    'http://127.0.0.1.evil.example:11434',
    'http://user@127.0.0.1:11434',
    'http://127.0.0.1:11434/api',
  ]) {
    assert.throws(() => readConfig({ AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: url }), /OLLAMA_BASE_URL/);
  }
  assert.throws(() => readConfig({ AI_PROVIDER: 'ollama', OLLAMA_MODEL: '  ' }), /OLLAMA_MODEL/);
  assert.throws(() => readConfig({ AI_PROVIDER: 'ollama', AI_TIMEOUT_MS: '120001' }), /AI_TIMEOUT_MS/);
});

test('health endpoint reports provider metadata without secrets', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/health');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'mock');
    assert.equal(body.hasAnthropicKey, false);
    assert.equal(Object.hasOwn(body, 'apiKey'), false);
  });
});

test('health endpoint reports configured Ollama provider and model', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/health');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'ollama');
    assert.equal(body.model, 'qwen2.5:3b');
  }, {
    provider: 'ollama',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5:3b',
  });
});

test('valid analysis request returns explicitly labelled mock response', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPayload),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.meta.provider, 'mock');
    assert.equal(body.data.meta.isMock, true);
  });
});

test('rejects malformed, empty, invalid and non-JSON analysis requests', async () => {
  await withServer(async (baseUrl) => {
    const malformed = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);

    const empty = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation: validPayload.conversation, messages: [] }),
    });
    assert.equal(empty.status, 400);

    const invalid = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation: validPayload.conversation,
        messages: [{ ...validPayload.messages[0], direction: 'sideways' }],
      }),
    });
    assert.equal(invalid.status, 400);

    const unsupported = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(validPayload),
    });
    assert.equal(unsupported.status, 415);
  });
});

test('rejects oversized payloads with HTTP 413', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ large: 'x'.repeat(1024 * 1024 + 1) }),
    });
    assert.equal(response.status, 413);
  });
});

test('rejects web-page origins but permits a Chromium extension origin', async () => {
  await withServer(async (baseUrl) => {
    const blocked = await fetch(baseUrl + '/health', {
      headers: { origin: 'https://example.com' },
    });
    assert.equal(blocked.status, 403);

    const allowed = await fetch(baseUrl + '/health', {
      headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    );
  });
});

test('accepts localhost Host headers for configured loopback backends', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/health', {
      headers: { host: 'localhost:' + new URL(baseUrl).port },
    });
    assert.equal(response.status, 200);
  });
});

test('missing Anthropic key and disabled fallback return clear errors, not mock success', async () => {
  const config = {
    host: '127.0.0.1',
    port: 0,
    provider: 'anthropic',
    model: 'test-model',
    apiKey: '',
    timeoutMs: 1000,
    allowFallback: false,
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPayload),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.match(body.error, /ANTHROPIC_API_KEY/);
  }, config);
});
