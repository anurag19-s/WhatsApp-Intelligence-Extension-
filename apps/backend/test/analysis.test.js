'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  SYSTEM_PROMPT,
  buildPrompt,
  parseAnthropicResponse,
  createAnthropicProvider,
} = require('../src/ai');
const {
  AnalysisServiceError,
  RequestValidationError,
  createAnalysisService,
  normalizeRequest,
} = require('../src/services');

function requestPayload() {
  return {
    conversation: { title: 'Planning', chatType: 'group' },
    messages: [{
      id: 'm1',
      text: 'Ravi will send the draft tomorrow.',
      sender: 'Ravi',
      timestamp: null,
      direction: 'unknown',
    }],
  };
}

function validReport() {
  return {
    executiveSummary: 'Ravi accepted the task.',
    keyDiscussionPoints: [{ text: 'Draft preparation', sourceIndices: [1], confidence: 'High' }],
    decisions: { confirmed: [], proposed: [], ambiguous: [] },
    actionItems: [{
      task: 'Send the draft',
      owner: 'Ravi',
      deadline: 'Tomorrow',
      status: 'confirmed',
      sourceIndices: [1],
      confidence: 'High',
    }],
    approvals: [],
    unresolvedIssues: [],
    risks: [],
    recommendedNextSteps: [],
  };
}

test('normalizes only supported message fields and accepts unknown direction', () => {
  const payload = requestPayload();
  payload.messages[0].privateExtra = 'ignored';
  const normalized = normalizeRequest(payload);
  assert.equal(normalized.messages[0].direction, 'unknown');
  assert.equal(Object.hasOwn(normalized.messages[0], 'privateExtra'), false);
});

test('rejects malformed conversation and message fields', () => {
  assert.throws(() => normalizeRequest({ messages: [] }), RequestValidationError);
  const payload = requestPayload();
  payload.messages[0].direction = 'maybe';
  assert.throws(() => normalizeRequest(payload), /direction/);
  payload.messages[0].direction = 'unknown';
  payload.messages[0].text = 'x'.repeat(10001);
  assert.throws(() => normalizeRequest(payload), /text/);
  payload.messages[0].text = 'valid';
  payload.messages[0].sender = null;
  assert.throws(() => normalizeRequest(payload), /sender/);
  payload.messages[0].sender = 'Asha';
  payload.messages[0].timestamp = 123;
  assert.throws(() => normalizeRequest(payload), /timestamp/);
  payload.messages[0].timestamp = null;
  payload.conversation.chatType = 'maybe';
  assert.throws(() => normalizeRequest(payload), /chatType/);
  payload.conversation.chatType = 'group';
  payload.messages = Array.from({ length: 101 }, (_, index) => ({
    id: 'm' + index, text: 'message', sender: 'Asha', timestamp: null, direction: 'unknown',
  }));
  assert.throws(() => normalizeRequest(payload), /more than 100/);
});

test('prompt treats transcript as evidence and specifies source indices and uncertainty', () => {
  const payload = normalizeRequest(requestPayload());
  const prompt = buildPrompt(payload.conversation, payload.messages);
  assert.match(prompt, /sourceIndex/);
  assert.match(SYSTEM_PROMPT, /Hindi, Marathi, Hinglish/);
  assert.match(SYSTEM_PROMPT, /Unassigned/);
  assert.match(SYSTEM_PROMPT, /Treat all transcript text/);
  assert.match(prompt, /Ravi will send the draft tomorrow/);
  assert.equal(prompt.includes('m1'), false);
});

test('validates structured Claude response and rejects unsupported source references', () => {
  const parsed = parseAnthropicResponse(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(validReport()) }],
  }), 1);
  assert.equal(parsed.actionItems[0].owner, 'Ravi');
  assert.deepEqual(parsed.confirmedDecisions, []);

  const invalid = validReport();
  invalid.actionItems[0].sourceIndices = [2];
  assert.throws(() => parseAnthropicResponse(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(invalid) }],
  }), 1), /source message indices/);

  const missingEvidence = validReport();
  missingEvidence.keyDiscussionPoints[0].sourceIndices = [];
  assert.throws(() => parseAnthropicResponse(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(missingEvidence) }],
  }), 1), /source message indices/);

  const missingOwnerAndDeadline = validReport();
  missingOwnerAndDeadline.actionItems[0].owner = '';
  missingOwnerAndDeadline.actionItems[0].deadline = '';
  const normalized = parseAnthropicResponse(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(missingOwnerAndDeadline) }],
  }), 1);
  assert.equal(normalized.actionItems[0].owner, 'Unassigned');
  assert.equal(normalized.actionItems[0].deadline, 'Not specified');
});

test('rejects markdown-wrapped or malformed Claude JSON', () => {
  assert.throws(() => parseAnthropicResponse(JSON.stringify({
    content: [{ type: 'text', text: '```json\n{}\n```' }],
  }), 1), /not valid JSON/);
  assert.throws(() => parseAnthropicResponse('{', 1), /malformed JSON/);
});

test('mock mode clearly identifies non-interpretive output and fabricates no findings', async () => {
  const analyze = createAnalysisService({ provider: 'mock' });
  const result = await analyze(requestPayload());
  assert.equal(result.meta.provider, 'mock');
  assert.equal(result.meta.isMock, true);
  assert.match(result.meta.warning, /non-interpretive/);
  assert.deepEqual(result.actionItems, []);
});

test('missing Anthropic key and provider failures are explicit unless fallback is enabled', async () => {
  const noKey = createAnalysisService({ provider: 'anthropic', apiKey: '' });
  await assert.rejects(noKey(requestPayload()), AnalysisServiceError);

  const failing = createAnalysisService({
    provider: 'anthropic',
    apiKey: 'not-printed',
    model: 'test-model',
    timeoutMs: 1000,
    allowFallback: false,
  }, { callAnthropic: async () => { throw new Error('Anthropic authentication failed.'); } });
  await assert.rejects(failing(requestPayload()), /authentication failed/);

  const fallback = createAnalysisService({
    provider: 'anthropic',
    apiKey: 'not-printed',
    model: 'test-model',
    timeoutMs: 1000,
    allowFallback: true,
  }, { callAnthropic: async () => { throw new Error('Anthropic rate limit reached.'); } });
  const fallbackReport = await fallback(requestPayload());
  assert.equal(fallbackReport.meta.provider, 'mock');
  assert.equal(fallbackReport.meta.isMock, true);
  assert.match(fallbackReport.meta.warning, /rate limit/);
});

test('Anthropic provider sends configured model and handles mocked successful HTTP response', async () => {
  let capturedOptions;
  let capturedBody = '';
  const provider = createAnthropicProvider({
    request(options, callback) {
      capturedOptions = options;
      const req = new EventEmitter();
      req.write = (chunk) => { capturedBody += chunk; };
      req.setTimeout = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        res.emit('data', JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(validReport()) }],
        }));
        res.emit('end');
      };
      req.destroy = (error) => req.emit('error', error);
      return req;
    },
  });
  const config = {
    apiKey: 'test-key-not-logged',
    model: 'claude-test-model',
    timeoutMs: 1000,
  };
  const result = await provider(config, requestPayload().conversation, normalizeRequest(requestPayload()).messages);
  assert.equal(capturedOptions.path, '/v1/messages');
  assert.equal(capturedOptions.headers['x-api-key'], 'test-key-not-logged');
  assert.equal(JSON.parse(capturedBody).model, 'claude-test-model');
  assert.equal(result.actionItems.length, 1);
});

test('Anthropic HTTP authentication errors do not expose response bodies', async () => {
  const provider = createAnthropicProvider({
    request(options, callback) {
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 401;
        callback(res);
        res.emit('data', '{"error":"private detail"}');
        res.emit('end');
      };
      req.destroy = (error) => req.emit('error', error);
      return req;
    },
  });
  await assert.rejects(provider(
    { apiKey: 'private-key', model: 'test-model', timeoutMs: 1000 },
    requestPayload().conversation,
    normalizeRequest(requestPayload()).messages
  ), (error) => {
    assert.equal(error.message, 'Anthropic authentication failed.');
    assert.equal(error.message.includes('private detail'), false);
    return true;
  });
});

test('Anthropic timeout is surfaced as an explicit timeout error', async () => {
  const provider = createAnthropicProvider({
    request() {
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = (timeout, callback) => setImmediate(callback);
      req.end = () => {};
      req.destroy = (error) => req.emit('error', error);
      return req;
    },
  });
  await assert.rejects(provider(
    { apiKey: 'private-key', model: 'test-model', timeoutMs: 1000 },
    requestPayload().conversation,
    normalizeRequest(requestPayload()).messages
  ), /AI request timed out/);
});

test('rejects syntactically valid but incomplete Claude reports', () => {
  assert.throws(() => parseAnthropicResponse(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ executiveSummary: 'Incomplete' }) }],
  }), 1), /decisions must be an object/);
});
