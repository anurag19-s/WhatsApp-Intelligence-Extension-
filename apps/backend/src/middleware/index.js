'use strict';

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function setCorsHeaders(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

module.exports = { isAllowedOrigin, setCorsHeaders };
