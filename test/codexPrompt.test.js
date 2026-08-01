const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCodexPrompt, buildOutputSchema } = require('../native-host/src/codexPrompt');

test('builds a Codex prompt with task, mode, and file inventory', () => {
  const prompt = buildCodexPrompt({
    mode: 'auto',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    session: {
      id: 'session_abc',
      history: [
        { task: 'Previous task', result: 'Edited main.tex' }
      ]
    },
    task: 'Fix citations',
    focusFiles: ['refs.bib'],
    project: {
      activePath: 'main.tex',
      files: [
        { path: 'main.tex', content: '\\cite{missing}' },
        { path: 'refs.bib', content: '@article{x}' }
      ]
    }
  });

  assert.match(prompt, /Fix citations/);
  assert.match(prompt, /Mode: auto/);
  assert.match(prompt, /Model: gpt-5.4/);
  assert.match(prompt, /Reasoning effort: high/);
  assert.match(prompt, /Session: session_abc/);
  assert.match(prompt, /Previous task/);
  assert.match(prompt, /use null for unused fields/);
  assert.match(prompt, /Always include notes/);
  assert.match(prompt, /one concise user-facing sentence/);
  assert.match(prompt, /Focus files:/);
  assert.match(prompt, /refs\.bib \(primary context/);
  assert.match(prompt, /treat them as the primary context/);
  assert.match(prompt, /main\.tex/);
  assert.match(prompt, /refs\.bib/);
  assert.match(prompt, /Return JSON only/);
  assert.match(prompt, /Return userReport/);
  assert.match(prompt, /natural user-facing language/);
  assert.match(prompt, /Never put raw JSON, schema, stdout, stderr, or implementation details in userReport/);
  assert.match(prompt, /During the run, write short user-facing progress messages/);
});

test('builds a Codex prompt that instructs user reports to cite project-relative locations', () => {
  const prompt = buildCodexPrompt({
    mode: 'ask',
    task: 'Review labels.',
    focusFiles: ['main.tex', 'sections/intro.tex'],
    project: {
      activePath: 'main.tex',
      files: [
        { path: 'main.tex', content: '\\label{sec:intro}' },
        { path: 'sections/intro.tex', content: '\\ref{sec:intro}' }
      ]
    }
  });

  assert.match(prompt, /Overleaf project-relative paths/);
  assert.match(prompt, /path:LINE\[:COLUMN\]/);
  assert.match(prompt, /Do not cite local absolute paths/);
  assert.match(prompt, /file:\/\//);
  assert.match(prompt, /main\.tex/);
  assert.match(prompt, /sections\/intro\.tex/);
  assert.doesNotMatch(prompt, /\/Users\//);
  assert.doesNotMatch(prompt, /C:\\Users\\/);
  assert.doesNotMatch(prompt, /\.codex-overleaf\/projects/);
});

test('builds an output schema for operation results', () => {
  const schema = buildOutputSchema();

  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['status', 'operations', 'notes', 'userReport']);
  assert.equal(schema.properties.notes.type, 'string');
  assert.equal(schema.properties.userReport.type, 'object');
  assert.deepEqual(schema.properties.userReport.required, [
    'conclusion',
    'checked',
    'findings',
    'plannedChanges',
    'appliedChanges',
    'unchangedReason',
    'nextStep'
  ]);
  assert.equal(schema.properties.userReport.properties.conclusion.type, 'string');
  assert.equal(schema.properties.userReport.properties.checked.type, 'array');
  assert.equal(schema.properties.userReport.properties.findings.type, 'array');
  assert.equal(schema.properties.userReport.properties.plannedChanges.type, 'array');
  assert.equal(schema.properties.userReport.properties.appliedChanges.type, 'array');
  assert.equal(schema.properties.userReport.properties.unchangedReason.type, 'string');
  assert.equal(schema.properties.userReport.properties.nextStep.type, 'string');
  assert.equal(schema.properties.operations.type, 'array');
  assert.equal(schema.properties.operations.items.additionalProperties, false);
  assert.deepEqual(schema.properties.operations.items.required, ['type', 'path', 'to', 'find', 'replace', 'replaceAll', 'content', 'reason']);
  assert.deepEqual(schema.properties.operations.items.properties.find.type, ['string', 'null']);
});
