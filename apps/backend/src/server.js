'use strict';

const http = require('node:http');
const path = require('node:path');
const dotenv = require('dotenv');
const { createAnalysisService } = require('./services');
const { handleAnalyzeRequest } = require('./routes');
const { isAllowedOrigin, setCorsHeaders } = require('./middleware');

const envPath = path.resolve(__dirname, '..', '.env');
const envResult = dotenv.config({ path: envPath });
if (envResult.error && envResult.error.code !== 'ENOENT') {
  throw envResult.error;
}

function readConfig(env) {
  const apiKey = (env.ANTHROPIC_API_KEY || '').trim();
  const configuredProvider = env.AI_PROVIDER || 'auto';
  const provider = configuredProvider === 'auto'
    ? (apiKey ? 'anthropic' : 'mock')
    : configuredProvider;
  const port = Number(env.PORT || 3000);
  const host = env.HOST || '127.0.0.1';
  const timeoutMs = Number(env.AI_TIMEOUT_MS || 45000);
  const allowFallback = env.AI_ALLOW_MOCK_FALLBACK === 'true';

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }
  if (host !== '127.0.0.1') {
    throw new Error('HOST must be 127.0.0.1 to keep the backend loopback-only.');
  }
  if (provider !== 'anthropic' && provider !== 'mock') {
    throw new Error('AI_PROVIDER must be auto, anthropic, or mock.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('AI_TIMEOUT_MS must be between 1000 and 120000.');
  }

  return {
    host,
    port,
    provider,
    apiKey,
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    timeoutMs,
    allowFallback,
  };
}

const config = readConfig(process.env);
const analyze = createAnalysisService(config);

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function requestHostIsLoopback(hostHeader) {
  if (!hostHeader) return false;
  return /^127\.0\.0\.1(?::\d{1,5})?$/.test(hostHeader);
}

function createServer(options) {
  const settings = options || {};
  const analysis = settings.analyze || analyze;
  const serverConfig = settings.config || config;

  return http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      sendJson(res, 403, { ok: false, error: 'Request origin is not allowed.' });
      return;
    }

    if (!requestHostIsLoopback(req.headers.host)) {
      sendJson(res, 403, { ok: false, error: 'Backend accepts loopback requests only.' });
      return;
    }

    setCorsHeaders(res, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'Invalid request URL.' });
      return;
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'wa-corporate-intelligence-backend',
        timestamp: new Date().toISOString(),
        provider: serverConfig.provider,
        model: serverConfig.provider === 'anthropic' ? serverConfig.model : 'local-mock-v1',
        hasAnthropicKey: Boolean(serverConfig.apiKey),
      });
      return;
    }

    if (url.pathname !== '/api/analyze' || req.method !== 'POST') {
      sendJson(res, 404, { ok: false, error: 'Not found.' });
      return;
    }

    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json.' });
      return;
    }

    handleAnalyzeRequest(req, res, analysis, sendJson);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log('[WA Corporate Intelligence Backend] Listening on http://' + config.host + ':' + config.port);
  });
  server.on('error', (error) => {
    console.error('[WA Corporate Intelligence Backend] Failed to start: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer, readConfig, config };
