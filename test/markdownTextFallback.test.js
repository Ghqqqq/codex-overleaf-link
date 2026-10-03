'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Renderer = require('../extension/src/content/markdownDomRenderer.js');
const MathText = require('../extension/src/content/mathText.js');
const LineReferences = require('../extension/src/shared/lineReferences.js');
const markdownIt = require('../extension/vendor/markdown-it/markdown-it.min.js');
const sourcePath = path.join(__dirname, '../extension/src/content/markdownText.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// Exercise the complete production factory in its own realm. Only the browser
// DOM is substituted; no outer `options` binding can mask dependency mistakes.
function createHarness(condition = 'normal', diagnosticMode = 'record') {
  const document = createFakeDocument();
  const diagnostics = [];
  const sandbox = { document, URL, console, markdownit: markdownIt,
    CodexOverleafMarkdownDomRenderer: Renderer, CodexOverleafMathText: MathText };
  sandbox.window = sandbox;
  if (condition === 'renderer-missing') delete sandbox.CodexOverleafMarkdownDomRenderer;
  if (condition === 'renderer-error') delete sandbox.CodexOverleafMathText;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: sourcePath });
  assert.equal(vm.runInContext('typeof options', context), 'undefined');
  const factory = sandbox.CodexOverleafMarkdownText.create({
    LineReferences, MathText,
    tx: english => english,
    callPageBridge: async () => { throw new Error('Rendering text must not invoke Page RPC.'); },
    getCurrentProjectId: () => 'synthetic-project',
    getCurrentProjectReferenceFiles: () => [],
    getCurrentProjectMathSources: () => [],
    showPluginToast: () => {},
    recordRenderingDiagnostic: diagnosticMode === 'absent' ? undefined : detail => {
      diagnostics.push(detail);
      if (diagnosticMode === 'throws') throw new Error('Diagnostic sink unavailable.');
    }
  });
  return { document, diagnostics, factory, sandbox };
}

function render(harness, value, options) {
  const target = harness.document.createElement('section');
  target.textContent = 'previous-content';
  assert.doesNotThrow(() => harness.factory.renderMarkdownBlockText(target, value, options));
  return target;
}

test('complete factory renders ordinary non-streaming text through the DOM renderer', () => {
  const harness = createHarness();
  const target = render(harness, '# Heading\n\nNormal **answer**.');
  assert.equal(target.childNodes[0].tagName, 'H1');
  assert.equal(target.textContent, 'HeadingNormal answer.');
  assert.equal(harness.diagnostics.length, 0);
});

test('streaming uses compatibility rendering without requiring the DOM renderer', () => {
  const harness = createHarness('renderer-missing', 'throws');
  const target = render(harness, '# Heading\n\nNormal **answer**.', { streaming: true });
  assert.equal(target.childNodes[0].tagName, 'P');
  assert.equal(target.textContent, 'HeadingNormal answer.');
  assert.equal(harness.diagnostics.length, 0);
});

const oversizedSource = 'x '.repeat(500_001) + 'x';
const scenarios = [
  { name: 'missing renderer', condition: 'renderer-missing', value: 'Fallback **answer**.',
    visible: 'Fallback answer.', code: 'markdown_dom_dependency_missing' },
  { name: 'real renderer missing a math-rule dependency', condition: 'renderer-error',
    value: 'Fallback **answer**.', visible: 'Fallback answer.', code: 'markdown_math_rule_missing' },
  { name: 'real renderer source limit exceeded', condition: 'normal',
    value: oversizedSource, visible: oversizedSource, code: 'markdown_source_too_large' }
];

for (const scenario of scenarios) {
  for (const diagnosticMode of ['record', 'throws', 'absent']) {
    test(`${scenario.name}: fallback survives first and repeat calls with ${diagnosticMode} diagnostics`, () => {
      const harness = createHarness(scenario.condition, diagnosticMode);
      for (let attempt = 0; attempt < 2; attempt++) {
        const target = render(harness, scenario.value);
        assert.equal(target.textContent, scenario.visible);
        assert.equal(target.childNodes[0].tagName, 'P');
      }
      assert.equal(harness.diagnostics.length, diagnosticMode === 'absent' ? 0 : 1);
      if (diagnosticMode !== 'absent') assert.equal(harness.diagnostics[0].code, scenario.code);
    });
  }
}

test('diagnostic deduplication permits distinct errors and renderer recovery', () => {
  const harness = createHarness('renderer-missing');
  render(harness, '**First**');
  render(harness, '**Second**');
  harness.sandbox.CodexOverleafMarkdownDomRenderer = Renderer;
  delete harness.sandbox.CodexOverleafMathText;
  render(harness, '**Third**');
  assert.deepEqual(harness.diagnostics.map(diagnostic => diagnostic.code), [
    'markdown_dom_dependency_missing', 'markdown_math_rule_missing'
  ]);
  harness.sandbox.CodexOverleafMathText = MathText;
  const target = render(harness, '# Recovered');
  assert.equal(target.childNodes[0].tagName, 'H1');
  assert.equal(target.textContent, 'Recovered');
  assert.equal(harness.diagnostics.length, 2);
});

function createFakeDocument() {
  const document = {
    createElement: tag => new FakeNode(document, String(tag).toUpperCase()),
    createTextNode: value => new FakeNode(document, '', String(value)),
    createDocumentFragment: () => new FakeNode(document, '#FRAGMENT')
  };
  return document;
}

class FakeNode {
  constructor(ownerDocument, tagName, ownText = '') {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName && !tagName.startsWith('#') ? tagName : '';
    this.nodeName = tagName;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this._text = ownText;
    this.classList = {
      add: value => {
        this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), value])].join(' ');
      }
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      if (node.nodeName === '#FRAGMENT') this.childNodes.push(...node.childNodes);
      else this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes) { this.childNodes = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value || ''); this.childNodes = []; }
}
