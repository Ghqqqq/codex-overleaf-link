'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MathText = require('../extension/src/content/mathText.js');
const { buildCodexTurnPrompt } = require('../native-host/src/codexPromptAssembly.js');
const { buildManagedExtensionTree } = require('../native-host/src/managedInstall.js');
const { getContentBundleSourceOrder } = require('./_helpers/contentBundleEntry');

test('math parser recognizes explicit inline and display delimiters', () => {
  const segments = MathText.parseMathSegments('Inline $x_1^2$ and display $$\\sum_i x_i$$.');
  assert.deepEqual(
    segments.filter(segment => segment.type === 'math').map(segment => ({
      value: segment.value,
      display: segment.display
    })),
    [
      { value: 'x_1^2', display: false },
      { value: '\\sum_i x_i', display: true }
    ]
  );
});

test('math parser preserves inline code, escaped dollars, and unmatched delimiters', () => {
  const source = 'Keep `$not_math$`, \\$5, and unmatched $text; render \\(a+b\\).';
  const segments = MathText.parseMathSegments(source);
  assert.deepEqual(
    segments.filter(segment => segment.type === 'math').map(segment => segment.value),
    ['a+b']
  );
  assert.equal(segments.map(segment => segment.raw || segment.value).join(''), source);
});

test('math renderer uses bounded untrusted KaTeX options and keeps text order', () => {
  const calls = [];
  const document = createFakeDocument();
  const nodes = MathText.buildMathNodes('A $x^2$ B', {
    document,
    katex: {
      render(value, node, options) {
        calls.push({ value, options });
        node.textContent = `rendered:${value}`;
      }
    },
    renderText: value => [{ textContent: value }]
  });
  assert.deepEqual(nodes.map(node => node.textContent), ['A ', 'rendered:x^2', ' B']);
  assert.equal(calls[0].options.trust, false);
  assert.equal(calls[0].options.throwOnError, true);
  assert.equal(calls[0].options.maxExpand, 200);
  assert.equal(calls[0].options.output, 'htmlAndMathml');
});

test('math renderer falls back to readable delimited source when KaTeX rejects input', () => {
  const document = createFakeDocument();
  const nodes = MathText.buildMathNodes('$\\unsupported{x}$', {
    document,
    katex: { render() { throw new Error('unsupported'); } },
    renderText: value => [{ textContent: value }]
  });
  assert.equal(nodes[0].textContent, '$\\unsupported{x}$');
  assert.equal(nodes[0].dataset.mathRendered, 'false');
  assert.match(nodes[0].className, /run-math--fallback/);
});

test('extension loads local KaTeX before the isolated math and markdown renderers', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  const scripts = getContentBundleSourceOrder();
  const styles = manifest.content_scripts[0].css;
  assert.ok(scripts.indexOf('vendor/katex/katex.min.js') < scripts.indexOf('src/content/mathText.js'));
  assert.ok(scripts.indexOf('vendor/markdown-it/markdown-it.min.js') < scripts.indexOf('src/content/mathText.js'));
  assert.ok(scripts.indexOf('src/content/mathText.js') < scripts.indexOf('src/content/markdownDomRenderer.js'));
  assert.ok(scripts.indexOf('src/content/markdownDomRenderer.js') < scripts.indexOf('src/content/markdownText.js'));
  assert.ok(styles.indexOf('vendor/katex/katex.min.css') < styles.indexOf('styles/panel.css'));
  assert.equal(fs.existsSync(path.join(root, 'extension/vendor/katex/katex.min.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'extension/vendor/markdown-it/markdown-it.min.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'extension/vendor/katex/fonts/KaTeX_Main-Regular.woff2')), true);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(packageJson.files.includes('extension/vendor/'));
});

test('source and managed KaTeX CSS resolve every font from their actual package roots', () => {
  const root = path.join(__dirname, '..');
  const sourceCss = fs.readFileSync(path.join(root, 'extension/vendor/katex/katex.min.css'), 'utf8');
  const sourcePrefix = 'chrome-extension://__MSG_@@extension_id__/vendor/katex/fonts/';
  const sourceUrls = extractCssUrls(sourceCss);
  assert.ok(sourceUrls.length > 10);
  assert.equal(sourceUrls.every(url => url.startsWith(sourcePrefix)), true);
  for (const url of sourceUrls) {
    assert.equal(fs.existsSync(path.join(root, 'extension/vendor/katex/fonts', url.slice(sourcePrefix.length))), true);
  }

  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-managed-css-'));
  buildManagedExtensionTree({
    packageRoot: root,
    targetRoot: managedRoot,
    version: '2.2.0',
    releaseRef: 'v2.2.0-rc.999',
    releaseChannel: 'prerelease'
  });
  const managedCss = fs.readFileSync(path.join(managedRoot, 'runtime/vendor/katex/katex.min.css'), 'utf8');
  const managedPrefix = 'chrome-extension://__MSG_@@extension_id__/runtime/vendor/katex/fonts/';
  const managedUrls = extractCssUrls(managedCss);
  assert.equal(managedUrls.length, sourceUrls.length);
  assert.equal(managedUrls.every(url => url.startsWith(managedPrefix)), true);
  fs.rmSync(managedRoot, { recursive: true, force: true });
});

test('Codex prompt requires explicit math delimiters and reserves backticks for source', () => {
  const { systemPrompt } = buildCodexTurnPrompt({ task: 'Explain the proof.' });
  assert.match(systemPrompt, /format inline mathematics as \$\.\.\.\$/);
  assert.match(systemPrompt, /display mathematics as \$\$\.\.\.\$\$/);
  assert.match(systemPrompt, /Never wrap mathematical expressions in backticks/);
});

function createFakeDocument() {
  return {
    createElement(tagName) {
      const node = {
        tagName: String(tagName).toUpperCase(),
        className: '',
        dataset: {},
        textContent: ''
      };
      node.classList = {
        add(name) {
          const names = new Set(node.className.split(/\s+/).filter(Boolean));
          names.add(name);
          node.className = [...names].join(' ');
        }
      };
      return node;
    },
    createTextNode(value) {
      return { textContent: String(value) };
    }
  };
}

function extractCssUrls(css) {
  return [...css.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)].map(match => match[2]);
}
