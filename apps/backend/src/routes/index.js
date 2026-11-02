'use strict';

const { RequestValidationError, AnalysisServiceError } = require('../services');

const MAX_BODY_BYTES = 1024 * 1024;

function handleAnalyzeRequest(req, res, analyze, sendJson) {
  let body = '';
  let bodyBytes = 0;
  let responded = false;

  req.on('data', (chunk) => {
    bodyBytes += Buffer.byteLength(chunk);
    if (bodyBytes > MAX_BODY_BYTES) {
      responded = true;
      sendJson(res, 413, { ok: false, error: 'Request body exceeds the 1 MB limit.' });
      req.resume();
      return;
    }
    if (!responded) body += chunk;
  });

  req.on('end', async () => {
    if (responded || res.writableEnded) return;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON request payload.' });
      return;
    }

    try {
      const report = await analyze(payload);
      sendJson(res, 200, { ok: true, data: report });
    } catch (error) {
      if (error instanceof RequestValidationError) {
        sendJson(res, error.statusCode, { ok: false, error: error.message });
        return;
      }
      if (error instanceof AnalysisServiceError) {
        sendJson(res, error.statusCode, { ok: false, error: error.message });
        return;
      }
      sendJson(res, 500, { ok: false, error: 'Analysis failed due to an internal server error.' });
    }
  });

  req.on('error', () => {
    if (!responded && !res.writableEnded) {
      sendJson(res, 400, { ok: false, error: 'Unable to read request body.' });
    }
  });
}

module.exports = { handleAnalyzeRequest, MAX_BODY_BYTES };
