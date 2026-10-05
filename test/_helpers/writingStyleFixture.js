'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Style = require('../../native-host/src/writingStyleRuntime');
const scope = { accountScopeId: 'synthetic-style-account', projectId: 'style-target' };
const quote = 'The synthetic analysis describes a modest result with clear conditions and a carefully bounded interpretation.';
function params(large = false) {
  const snapshot = { projectId: 'reference', capturedAt: new Date().toISOString(), capabilities: { referenceTextComplete: true },
    files: [{ path: large ? 'references/' + 'long-directory-'.repeat(6) + '/' + 'chapter-name-'.repeat(9) + '.tex' : 'main.tex',
      content: [quote, ...Array(large ? 6000 : 30).fill(large ? 'A result holds.' : 'A controlled example supports a precise and limited claim.')].join('\n') }] };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  return { ...scope, locale: 'en', attachments: [{ id: 'reference', name: 'reference.json', size: bytes.length, contentBase64: bytes.toString('base64') }],
    writingStyleBuild: { requestId: crypto.randomUUID(), enableAfterBuild: true, sources: [{ kind: 'project', projectId: 'reference', name: 'Synthetic reference', attachmentId: 'reference' }] } };
}
function model(input) {
  const first = fs.readFileSync(path.join(input.workspacePath, 'corpus/source-1.txt'), 'utf8').split('\n')[0].replace(/^\d+ \| /, '');
  return { assistantMessage: JSON.stringify({ label: 'Synthetic bounded style', evidenceLimits: 'Synthetic references support only the narrow expression observations described here.',
    sections: [{ key: 'general', title: 'General', examples: [{ id: 'example-one', sourceId: 'source-1', fromLine: 1, toLine: 1, quote: first,
      pattern: 'State a bounded result in a clear sentence.', application: 'Use only facts supplied by the current task.' }] }],
    traits: ['voice', 'syntax', 'rhythm'].map((dimension, index) => ({ id: 'trait-' + ['one', 'two', 'three'][index], dimension,
      title: 'Bounded expression ' + dimension, observation: 'The example states a result using explicit conditions and restrained language.',
      application: 'Describe a supported target finding with its qualifications and requested language.', template: 'The [analysis] describes [result] under [conditions].',
      limits: 'Skip when a different expression is required.', exampleIds: ['example-one'] })) }) };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writing-style-regression-'));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = environment(root);
  const scopeRoot = path.join(env.CODEX_OVERLEAF_WRITING_STYLE_ROOT, crypto.createHash('sha256').update(scope.accountScopeId).digest('hex').slice(0, 32), scope.projectId);
  return { root, env, scopeRoot, configPath: path.join(scopeRoot, 'config.json'), read: () => JSON.parse(fs.readFileSync(path.join(scopeRoot, 'config.json'), 'utf8')),
    build: (input = params(), execute = model) => Style.build({ params: input, env, execute: async value => execute(value) }) };
}
function environment(root) { return { HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), CODEX_OVERLEAF_WRITING_STYLE_ROOT: path.join(root, 'styles') }; }
module.exports = { fixture, environment, params, model, scope, Style };
