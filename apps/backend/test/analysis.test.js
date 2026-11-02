'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  SYSTEM_PROMPT,
  REPORT_JSON_SCHEMA,
  buildPrompt,
  parseAnthropicResponse,
  parseOllamaResponse,
  contextualizeOllamaApprovals,
  createAnthropicProvider,
  createOllamaProvider,
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
  assert.match(SYSTEM_PROMPT, /use that sender as the action owner/);
  assert.match(SYSTEM_PROMPT, /Preserve every explicitly stated day or date/);
  assert.match(SYSTEM_PROMPT, /confidence value spelled exactly High, Medium, or Low/);
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

test('validates Ollama report JSON and preserves evidence and legacy aliases', () => {
  const parsed = parseOllamaResponse(JSON.stringify({
    message: { content: JSON.stringify(validReport()) },
  }), 1);
  assert.deepEqual(parsed.keyDiscussionPoints[0].sourceIndices, [1]);
  assert.deepEqual(parsed.confirmedDecisions, []);
  assert.deepEqual(parsed.proposedDecisions, []);
  assert.deepEqual(parsed.pendingApprovals, []);
  assert.deepEqual(parsed.importantRisks, []);

  const invalid = validReport();
  invalid.actionItems[0].sourceIndices = [2];
  assert.throws(() => parseOllamaResponse(JSON.stringify({
    message: { content: JSON.stringify(invalid) },
  }), 1), /source message indices/);
  assert.throws(() => parseOllamaResponse('{', 1), /malformed JSON/);
  assert.throws(() => parseOllamaResponse(JSON.stringify({ message: {} }), 1), /malformed chat response/);
  assert.throws(() => parseOllamaResponse(JSON.stringify({
    message: { content: 'not json' },
  }), 1), /not valid JSON/);
});

test('contextualizes short Ollama approvals only from cited prior action evidence', () => {
  const report = validReport();
  report.decisions.confirmed = [{
    text: 'Approved. Please proceed.',
    sourceIndices: [3],
    confidence: 'High',
  }];
  report.actionItems[0].task = 'Publish the campaign';
  report.actionItems[0].deadline = 'Friday';
  report.actionItems[0].sourceIndices = [1];
  report.actionItems.push({
    task: 'Prepare the creatives',
    owner: 'Priya',
    deadline: 'Wednesday',
    status: 'confirmed',
    sourceIndices: [2],
    confidence: 'High',
  });
  const parsed = parseOllamaResponse(JSON.stringify({
    message: { content: JSON.stringify(report) },
  }), 3);
  const resolved = contextualizeOllamaApprovals(parsed, [
    { text: 'We need to publish the campaign by Friday.', sender: 'Rahul' },
    { text: "I'll prepare the creatives by Wednesday.", sender: 'Priya' },
    { text: 'Approved. Please proceed.', sender: 'Rahul' },
  ]);
  assert.match(resolved.decisions.confirmed[0].text, /Rahul approved the plan/);
  assert.match(resolved.decisions.confirmed[0].text, /Friday/);
  assert.match(resolved.decisions.confirmed[0].text, /Wednesday/);
  assert.deepEqual(resolved.decisions.confirmed[0].sourceIndices, [1, 2, 3]);
  assert.equal(resolved.confirmedDecisions[0], resolved.decisions.confirmed[0].text);

  const unrelated = contextualizeOllamaApprovals(parsed, [
    { text: 'Unrelated prior conversation.', sender: 'Asha' },
    { text: 'Approved. Please proceed.', sender: 'Rahul' },
    { text: 'Latest message.', sender: 'Priya' },
  ]);
  assert.equal(unrelated.decisions.confirmed[0].text, 'Approved. Please proceed.');
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

test('Ollama provider uses local chat API with structured selected-message JSON output', async () => {
  let capturedOptions;
  let capturedBody = '';
  const provider = createOllamaProvider({
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
          message: { content: JSON.stringify(validReport()) },
        }));
        res.emit('end');
      };
      req.destroy = (error) => req.emit('error', error);
      return req;
    },
  });
  const config = {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5:3b',
    timeoutMs: 120000,
  };
  const payload = requestPayload();
  payload.unselectedMessages = [{ text: 'PRIVATE UNSELECTED MESSAGE' }];
  const result = await provider(config, payload.conversation, normalizeRequest(payload).messages);
  const body = JSON.parse(capturedBody);
  assert.equal(capturedOptions.hostname, '127.0.0.1');
  assert.equal(capturedOptions.port, '11434');
  assert.equal(capturedOptions.path, '/api/chat');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(body.model, 'qwen2.5:3b');
  assert.equal(body.stream, false);
  assert.equal(body.format.type, 'object');
  assert.equal(body.options.temperature, 0);
  assert.deepEqual(body.format.required, [
    'executiveSummary',
    'keyDiscussionPoints',
    'decisions',
    'actionItems',
    'approvals',
    'unresolvedIssues',
    'risks',
    'recommendedNextSteps',
  ]);
  assert.deepEqual(body.format.properties.decisions.required, ['confirmed', 'proposed', 'ambiguous']);
  assert.deepEqual(body.format.properties.actionItems.items.properties.confidence.enum, ['High', 'Medium', 'Low']);
  assert.equal(REPORT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[1].content, /Ravi will send the draft tomorrow/);
  assert.equal(body.messages[1].content.includes('PRIVATE UNSELECTED MESSAGE'), false);
  assert.equal(result.actionItems.length, 1);
});

test('Ollama connection failures and timeouts are surfaced without Mock fallback', async () => {
  const failingProvider = createOllamaProvider({
    request() {
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = () => {};
      req.end = () => req.emit('error', new Error('connection refused'));
      req.destroy = (error) => req.emit('error', error);
      return req;
    },
  });
  await assert.rejects(failingProvider(
    { ollamaBaseUrl: 'http://localhost:11434', ollamaModel: 'qwen2.5:3b', timeoutMs: 1000 },
    requestPayload().conversation,
    normalizeRequest(requestPayload()).messages
  ), /Could not connect to Ollama/);

  const timeoutProvider = createOllamaProvider({
    request() {
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = (timeout, callback) => setImmediate(callback);
      req.end = () => {};
      req.destroy = (error) => req.emit('error', error);
      return req;
    },
  });
  const timeoutConfig = {
    provider: 'ollama',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5:3b',
    timeoutMs: 1000,
    allowFallback: true,
  };
  const timedOut = createAnalysisService(timeoutConfig, { callOllama: timeoutProvider });
  await assert.rejects(timedOut(requestPayload()), (error) => {
    assert.ok(error instanceof AnalysisServiceError);
    assert.equal(error.statusCode, 504);
    assert.match(error.message, /Ollama analysis timed out/);
    return true;
  });

  const unavailable = createAnalysisService(timeoutConfig, {
    callOllama: async () => { throw new Error('Could not connect to Ollama.'); },
  });
  await assert.rejects(unavailable(requestPayload()), (error) => {
    assert.ok(error instanceof AnalysisServiceError);
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /Could not connect to Ollama/);
    return true;
  });
});

test('Ollama analysis reports provider metadata and never falls back to Mock', async () => {
  const analyze = createAnalysisService({
    provider: 'ollama',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5:3b',
    timeoutMs: 120000,
    allowFallback: true,
  }, {
    callOllama: async () => parseOllamaResponse(JSON.stringify({
      message: { content: JSON.stringify(validReport()) },
    }), 1),
  });
  const result = await analyze(requestPayload());
  assert.equal(result.meta.provider, 'ollama');
  assert.equal(result.meta.model, 'qwen2.5:3b');
  assert.equal(result.meta.isMock, false);
  assert.equal(result.meta.selectedCount, 1);
  assert.deepEqual(result.confirmedDecisions, []);
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
