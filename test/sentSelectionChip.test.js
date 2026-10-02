const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const SelectionContextView = require('../extension/src/content/selectionContextView');

function fakeDocument() {
  const make = tagName => ({
    tagName: tagName.toUpperCase(), children: [], attributes: {}, className: '', textContent: '', hidden: false, open: false,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = String(value); }
  });
  return { createElement: make };
}

const text = (node) => [node.textContent, ...(node.children || []).map(text)].join('');
const selection = {
  projectId: 'p1', path: 'Tex/Chap_02.tex', from: 10, to: 18, text: '这种说法有点怪',
  lineStart: 42, lineEnd: 44, documentHash: 'a'.repeat(64), mode: 'edit', capturedAt: '2026-10-01T09:00:00Z'
};
selection.to = selection.from + selection.text.length;

test('a sent message keeps the selection chip it was submitted with', () => {
  const document = fakeDocument();
  const host = document.createElement('div');
  host.hidden = true;
  SelectionContextView.renderSent(host, selection, { document, tx: (en, zh) => zh });
  assert.equal(host.hidden, false);
  const [details] = host.children;
  assert.equal(details.tagName, 'DETAILS');
  assert.equal(details.open, false, 'the selected text stays folded');
  assert.match(text(details.children[0]), /^Chap_02\.tex:42-44仅此处$/);
  assert.equal(details.children[1].textContent, '这种说法有点怪');
  assert.equal(host.children.some(node => node.tagName === 'BUTTON'), false, 'a sent chip cannot be removed');
});

test('runs without a selection render no chip', () => {
  const document = fakeDocument();
  const host = document.createElement('div');
  SelectionContextView.renderSent(host, null, { document });
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
  SelectionContextView.renderSent(host, { ...selection, path: '../escape.tex' }, { document });
  assert.equal(host.hidden, true, 'an invalid stored selection is ignored');
});

test('run cards render the selection from the run execution snapshot', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/runTimelineView.js'), 'utf8');
  assert.match(source, /data-run-selection hidden/);
  assert.match(source, /renderSentSelection\?\.\(root\.querySelector\('\[data-run-selection\]'\), run\.executionSnapshot\?\.selectionContext/);
  const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
  assert.match(runtime, /renderSentSelection: Modules\.SelectionContextView\.renderSent/);
});
