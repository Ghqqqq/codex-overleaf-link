'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const markdownIt = require('../extension/vendor/markdown-it/markdown-it.min.js');
const MathText = require('../extension/src/content/mathText.js');
const Renderer = require('../extension/src/content/markdownDomRenderer.js');

test('bounded DOM renderer preserves rich Markdown structure and math flow', () => {
  const document = createFakeDocument();
  const target = document.createElement('section');
  Renderer.renderMarkdown(target, [
    '# Heading',
    '',
    '> Quoted **claim**',
    '',
    '- parent',
    '  - child',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    'Inline $x^2$ text.',
    '',
    '$$y = 1$$'
  ].join('\n'), rendererOptions(document));

  const tags = collectTags(target);
  for (const tag of ['H1', 'BLOCKQUOTE', 'UL', 'TABLE', 'PRE', 'CODE']) {
    assert.ok(tags.includes(tag), `${tag} should be preserved`);
  }
  assert.ok(tags.filter(tag => tag === 'UL').length >= 2, 'nested lists should stay nested');
  const mathNodes = collectNodes(target, node => node.dataset?.mathRendered === 'true');
  assert.equal(mathNodes.length, 2);
  assert.equal(mathNodes.some(node => node.dataset.mathDisplay === 'block'), true);
});

test('raw HTML and images remain inert visible text', () => {
  const document = createFakeDocument();
  const target = document.createElement('section');
  Renderer.renderMarkdown(
    target,
    '<script>alert(1)</script>\n\n![diagram](https://example.com/secret.png)',
    rendererOptions(document)
  );
  const tags = collectTags(target);
  assert.equal(tags.includes('SCRIPT'), false);
  assert.equal(tags.includes('IMG'), false);
  assert.match(target.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(target.textContent, /diagram/);
});

test('display math containing a standalone equals line wins over Setext heading parsing', () => {
  const document = createFakeDocument();
  const target = document.createElement('section');
  Renderer.renderMarkdown(target, [
    '$$',
    '\\mathbb E\\!\\left[',
    'Q_t g_{\\pi_0}(x_t)\\mid\\mathcal F_{t-1}',
    '\\right]',
    '=',
    'Q_t\\,\\mathbb E_{x\\sim P}[g_{\\pi_0}(x)]',
    '\\le-\\varepsilon Q_t.',
    '$$'
  ].join('\n'), rendererOptions(document));

  const mathNodes = collectNodes(target, node => node.dataset?.mathRendered === 'true');
  assert.equal(mathNodes.length, 1);
  assert.equal(mathNodes[0].dataset.mathDisplay, 'block');
  assert.equal(collectTags(target).includes('H1'), false);
  assert.match(mathNodes[0].textContent, /Q_t g_\{\\pi_0\}/);
  assert.match(mathNodes[0].textContent, /\\le-\\varepsilon Q_t/);
});

test('renderer leaves the live target untouched when a structural token is unsupported', () => {
  const document = createFakeDocument();
  const target = document.createElement('section');
  target.textContent = 'existing';
  assert.throws(() => Renderer.renderMarkdown(target, 'new', {
    ...rendererOptions(document),
    parser: { parse: () => [{ type: 'plugin_widget', nesting: 0 }] }
  }), /Unsupported Markdown token/);
  assert.equal(target.textContent, 'existing');
});

test('renderer enforces source and recursively counted token limits', () => {
  const document = createFakeDocument();
  const target = document.createElement('section');
  assert.throws(() => Renderer.renderMarkdown(target, '12345', {
    ...rendererOptions(document),
    limits: { maxChars: 4 }
  }), error => error.code === 'markdown_source_too_large');
  assert.equal(Renderer.countTokens([{ children: [{ children: [{}] }] }]), 3);
});

test('standalone inline code delegates to the line-reference-compatible callback', () => {
  const document = createFakeDocument();
  const target = document.createElement('section');
  let delegated = '';
  Renderer.renderMarkdown(target, '`main.tex:12`', {
    ...rendererOptions(document),
    renderCodeNodes(value) {
      delegated = value;
      const button = document.createElement('button');
      button.textContent = value;
      return [button];
    }
  });
  assert.equal(delegated, 'main.tex:12');
  assert.ok(collectTags(target).includes('BUTTON'));
});

test('panel CSS shares readable geometry across streaming and final Markdown', () => {
  const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');
  assert.match(css, /\.run-stream-text\.run-stream-text[\s\S]*font-size:\s*14px/);
  assert.match(css, /\.run-final-answer\.run-final-answer[\s\S]*line-height:\s*1\.6/);
  assert.match(css, /\.run-markdown-table/);
  assert.match(css, /\.run-math--display\.run-math--display[\s\S]*overflow-x:\s*auto/);
});

function rendererOptions(document) {
  return {
    document,
    markdownIt,
    mathText: MathText,
    sanitizeText: value => String(value || ''),
    renderTextNodes: value => [document.createTextNode(value)],
    renderLinkNodes: label => [document.createTextNode(label)],
    createMathNode(segment) {
      const node = document.createElement('span');
      node.dataset.mathRendered = 'true';
      node.dataset.mathDisplay = segment.display ? 'block' : 'inline';
      node.textContent = segment.value;
      return node;
    }
  };
}

function collectTags(root) {
  return collectNodes(root, node => Boolean(node.tagName)).map(node => node.tagName);
}

function collectNodes(root, predicate) {
  const result = [];
  const visit = node => {
    if (predicate(node)) result.push(node);
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
  return result;
}

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
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        values.add(value);
        this.className = [...values].join(' ');
      }
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      if (node.nodeName === '#FRAGMENT') {
        this.childNodes.push(...node.childNodes);
      } else {
        this.childNodes.push(node);
      }
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this._text = '';
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  get textContent() {
    return this._text + this.childNodes.map(node => node.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value || '');
    this.childNodes = [];
  }
}
