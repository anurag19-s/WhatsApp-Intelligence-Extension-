'use strict';

const { createAnthropicProvider } = require('../ai');

const MAX_MESSAGES = 100;
const MAX_TEXT_LENGTH = 10000;
const DIRECTIONS = new Set(['incoming', 'outgoing', 'unknown', 'sent', 'received']);
const CHAT_TYPES = new Set(['group', 'individual', 'unknown']);

class RequestValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestValidationError';
    this.statusCode = 400;
  }
}

class AnalysisServiceError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AnalysisServiceError';
    this.statusCode = statusCode || 502;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequest(payload) {
  if (!isRecord(payload) || !isRecord(payload.conversation)) {
    throw new RequestValidationError('Request must include conversation metadata and a messages array.');
  }
  const title = payload.conversation.title;
  const chatType = payload.conversation.chatType;
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
    throw new RequestValidationError('conversation.title must be a non-empty string of at most 200 characters.');
  }
  if (!CHAT_TYPES.has(chatType)) {
    throw new RequestValidationError('conversation.chatType must be group, individual, or unknown.');
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new RequestValidationError('messages must be a non-empty array.');
  }
  if (payload.messages.length > MAX_MESSAGES) {
    throw new RequestValidationError('messages cannot contain more than ' + MAX_MESSAGES + ' selected items.');
  }

  const messages = payload.messages.map((message, index) => {
    const prefix = 'messages[' + index + ']';
    if (!isRecord(message)) throw new RequestValidationError(prefix + ' must be an object.');
    if (typeof message.id !== 'string' || message.id.trim().length === 0 || message.id.length > 256) {
      throw new RequestValidationError(prefix + '.id must be a non-empty string of at most 256 characters.');
    }
    if (typeof message.text !== 'string' || message.text.trim().length === 0 || message.text.length > MAX_TEXT_LENGTH) {
      throw new RequestValidationError(prefix + '.text must be a non-empty string of at most ' + MAX_TEXT_LENGTH + ' characters.');
    }
    if (typeof message.sender !== 'string' || message.sender.length > 200) {
      throw new RequestValidationError(prefix + '.sender must be a string of at most 200 characters.');
    }
    if (message.timestamp !== null && (typeof message.timestamp !== 'string' || message.timestamp.length > 100)) {
      throw new RequestValidationError(prefix + '.timestamp must be null or a string of at most 100 characters.');
    }
    if (!DIRECTIONS.has(message.direction)) {
      throw new RequestValidationError(prefix + '.direction must be incoming, outgoing, or unknown.');
    }

    return {
      id: message.id,
      text: message.text,
      sender: message.sender || 'unknown',
      timestamp: message.timestamp,
      direction: message.direction === 'sent'
        ? 'outgoing'
        : message.direction === 'received'
          ? 'incoming'
          : message.direction,
    };
  });

  return {
    conversation: { title: title.trim(), chatType },
    messages,
  };
}

function createMockReport(conversation, messages, warning) {
  const participants = Array.from(new Set(messages.map((message) => message.sender || 'unknown')));
  const generatedAt = new Date().toISOString();
  return {
    executiveSummary: 'Mock mode does not interpret message content. ' + messages.length +
      ' selected message(s) from "' + conversation.title + '" were received; no AI-generated findings are provided.',
    keyDiscussionPoints: [],
    decisions: { confirmed: [], proposed: [], ambiguous: [] },
    actionItems: [],
    approvals: [],
    unresolvedIssues: [],
    risks: [],
    recommendedNextSteps: [],
    confirmedDecisions: [],
    proposedDecisions: [],
    pendingApprovals: [],
    importantRisks: [],
    meta: {
      analyzedAt: generatedAt,
      generatedAt,
      selectedCount: messages.length,
      participantCount: participants.length,
      conversationTitle: conversation.title,
      provider: 'mock',
      model: 'local-mock-v1',
      isMock: true,
      warning: warning || 'This report is a non-interpretive mock response. Configure the Anthropic provider to generate findings.',
    },
  };
}

function createAnalysisService(config, options) {
  const settings = options || {};
  const callAnthropic = settings.callAnthropic || createAnthropicProvider();

  return async function analyze(payload) {
    const normalized = normalizeRequest(payload);
    if (config.provider === 'mock') {
      return createMockReport(normalized.conversation, normalized.messages);
    }
    if (!config.apiKey) {
      throw new AnalysisServiceError('Anthropic is selected but ANTHROPIC_API_KEY is not configured.', 503);
    }

    try {
      const report = await callAnthropic(config, normalized.conversation, normalized.messages);
      const generatedAt = new Date().toISOString();
      return Object.assign({}, report, {
        meta: {
          analyzedAt: generatedAt,
          generatedAt,
          selectedCount: normalized.messages.length,
          conversationTitle: normalized.conversation.title,
          provider: 'anthropic',
          model: config.model,
          isMock: false,
        },
      });
    } catch (error) {
      if (!config.allowFallback) {
        const timedOut = error.message === 'AI request timed out.';
        throw new AnalysisServiceError(
          timedOut ? 'Anthropic analysis timed out.' : error.message,
          timedOut ? 504 : 502
        );
      }
      return createMockReport(
        normalized.conversation,
        normalized.messages,
        'Anthropic analysis failed; this is a non-interpretive mock response. ' + error.message
      );
    }
  };
}

module.exports = {
  MAX_MESSAGES,
  MAX_TEXT_LENGTH,
  RequestValidationError,
  AnalysisServiceError,
  normalizeRequest,
  createMockReport,
  createAnalysisService,
};
