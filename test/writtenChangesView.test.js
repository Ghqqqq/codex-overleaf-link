const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const View = require('../extension/src/content/writtenChangesView');

function fakeDocument() {
  const make = tag => {
    const el = {
      tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, listeners: {}, className: '', open: false, title: '',
      _text: '',
      get textContent() { return this._text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { this._text = String(value); },
      append(...nodes) { this.children.push(...nodes); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      toggle(open) { this.open = open; (this.listeners.toggle || []).forEach(fn => fn()); }
    };
    return el;
  };
  return { createElement: make, createTextNode: text => ({ textContent: String(text), children: [] }) };
}

const find = (node, cls, out = []) => {
  if (String(node.className || '').split(' ').includes(cls)) out.push(node);
  for (const child of node.children || []) find(child, cls, out);
  return out;
};

test('a paragraph that only gained one sentence highlights just that sentence', () => {
  const before = '奖励回归预测器和约束回归预测器分别输出函数估计 $\\hat f_t$ 和 $\\hat g_t$。';
  const after = 'LOE2D 的完整步骤见算法 \\ref{alg:loe2d}。' + before;
  const parts = View.diffWords(before, after);
  assert.deepEqual(parts.map(part => part.type), ['ins', 'same']);
  assert.equal(parts[0].text, 'LOE2D 的完整步骤见算法 \\ref{alg:loe2d}。');
  assert.equal(parts[1].text, before);
});

test('CJK edits mark single characters, not whole lines', () => {
  const parts = View.diffWords('评分规则很奇怪', '决策指标很奇怪');
  assert.deepEqual(parts, [{ type: 'del', text: '评分规则' }, { type: 'ins', text: '决策指标' }, { type: 'same', text: '很奇怪' }]);
});

test('rows keep one line of context and fold the rest', () => {
  const lines = [
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'context', text: 'a' + i })),
    { type: 'remove', text: 'old' }, { type: 'add', text: 'new' },
    ...Array.from({ length: 4 }, (_, i) => ({ type: 'context', text: 'b' + i }))
  ];
  const rows = View.buildRows(lines);
  assert.deepEqual(rows.map(row => row.kind), ['gap', 'context', 'change', 'context', 'gap']);
  assert.equal(rows[0].count, 4);
  assert.equal(rows[4].count, 3);
});

test('each file folds into one row with line counts, built lazily on open', () => {
  const document = fakeDocument();
  const list = View.render([{
    path: 'tex_v1/Chap_04_ICML_2025.tex',
    diff: [{ startB: 139, lines: [
      { type: 'context', text: '\\label{sec:triple_method}' },
      { type: 'remove', text: '本节介绍 Optimistic$^3$ 算法的设计思路与参数取值。' },
      { type: 'context', text: '\\begin{algorithm}[!htbp]' }
    ] }]
  }, { path: 'empty.tex', diff: [] }], { document, tx: (en, zh) => zh });
  assert.equal(list.children.length, 1, 'files without a diff are skipped');
  const [file] = list.children;
  assert.equal(file.tagName, 'DETAILS');
  assert.equal(file.open, false);
  assert.equal(find(file, 'run-written-file-name')[0].textContent, 'Chap_04_ICML_2025.tex');
  assert.equal(find(file, 'run-written-file-dir')[0].textContent, 'tex_v1');
  assert.equal(find(file, 'run-written-file-counts')[0].textContent, '+0−1');
  assert.equal(find(file, 'run-written-body').length, 0, 'body is not built until opened');
  assert.doesNotMatch(JSON.stringify(Object.keys(file)), /Written|Hunk accepted/);
  file.toggle(true);
  const body = find(file, 'run-written-body')[0];
  assert.match(body.textContent, /第 139 行/);
  assert.match(body.textContent, /本节介绍 Optimistic/);
  file.toggle(true);
  assert.equal(find(file, 'run-written-body').length, 1, 'opening twice does not rebuild');
});

test('auto-mode writes render the receipt; review-mode keeps DiffReviewPanel', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../extension/src/content/diffReviewPanel.js'), 'utf8');
  assert.match(panel, /deps\.renderWrittenChanges\(visibleChanges\)/);
  const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
  assert.match(runtime, /renderWrittenChanges: changes => Modules\.WrittenChangesView\.render\(changes, \{ document, tx \}\)/);
});

test('the scan line under a workflow card stays hidden while it runs', () => {
  const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');
  // The show rule is .transcript-turn[data-status="running"] … .run-scan (0,4,1);
  // the hide rule must outrank it or the sweep floats above the composer.
  assert.match(css, /\.transcript-turn\.run-presentation-workflow\[data-status\] \.run-process summary \.run-scan \{ display: none; \}/);
});
