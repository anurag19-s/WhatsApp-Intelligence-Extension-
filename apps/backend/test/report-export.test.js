'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCsv, buildMarkdown } = require('../../extension/src/sidepanel/report-export');

const report = {
  executiveSummary: 'A plan was discussed.',
  keyDiscussionPoints: [{ text: 'Send a draft', sourceIndices: [1], confidence: 'High' }],
  decisions: {
    confirmed: [],
    proposed: [{ text: 'Use the new template', sourceIndices: [1], confidence: 'Medium' }],
    ambiguous: [],
  },
  actionItems: [{
    task: '=HYPERLINK("https://example.test","open")',
    owner: 'Asha, "Team"',
    deadline: 'Not specified',
    status: 'pending',
    confidence: 'Medium',
    sourceIndices: [1],
  }],
  approvals: [],
  unresolvedIssues: [],
  risks: [],
  recommendedNextSteps: [],
  meta: {
    provider: 'mock',
    model: 'local-mock-v1',
    isMock: true,
    warning: 'No AI interpretation was performed.',
    selectedCount: 1,
  },
};

test('Markdown export includes all report sections, source evidence, and mock disclosure', () => {
  const markdown = buildMarkdown(report, 'Planning');
  for (const section of [
    'Executive Summary',
    'Key Discussion Points',
    'Decisions and Agreements',
    'Action Items',
    'Approvals',
    'Unresolved Issues',
    'Risks and Watchpoints',
    'Recommended Next Steps',
    'Provider:** mock',
    'MOCK OUTPUT',
    'Sources: #1',
  ]) {
    assert.ok(markdown.includes(section), 'expected markdown to include ' + section);
  }
});

test('CSV export quotes fields, protects spreadsheet formulas, and includes source references', () => {
  const csv = buildCsv(report);
  assert.ok(csv.startsWith('"Task","Owner","Deadline","Status","Confidence","Source references"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.test"",""open"")"'));
  assert.ok(csv.includes('"Asha, ""Team"""'));
  assert.ok(csv.includes('"#1"'));
});
