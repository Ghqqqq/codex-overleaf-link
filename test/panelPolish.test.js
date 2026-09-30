const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');

const repo = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('model picker remains quiet, readable and keyboard-visible without a decorative divider', () => {
  const css = repo('extension/styles/panel.css');
  const selector = '#codex-overleaf-panel .codex-model-config-button';
  const rules = target => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(',').some(value => value.trim() === target))
    .map(([, , body]) => body).join('\n');
  const rest = rules(selector);
  assert.match(rest, /background-color:\s*transparent/);
  assert.match(rest, /border:\s*1px solid transparent/);
  assert.match(rest, /gap:\s*[1-9]\d*px/);
  for (const state of ['[data-active="true"]', '[aria-expanded="true"]', ':hover', ':focus-visible']) {
    assert.match(rules(selector + state), /border-color:\s*var\(--tl-border\)/);
    assert.match(rules(selector + state), /background-color:\s*var\(--tl-hover\)/);
  }
  assert.match(rules(selector + ':focus-visible'), /outline:\s*2px solid var\(--tl-accent\)/);
  const model = rules(selector + ' [data-model-display]');
  const reasoning = rules(selector + ' [data-reasoning-display]');
  assert.match(model, /color:\s*var\(--tl-fg-1\)/);
  assert.match(reasoning, /color:\s*var\(--tl-fg-3\)/);
  assert.match(reasoning, /border-left:\s*0/);
  for (const label of [model, reasoning]) {
    assert.match(label, /text-overflow:\s*ellipsis/);
    assert.match(label, /white-space:\s*nowrap/);
  }
});

test('the empty timeline shows a second hint line for @ and / affordances', () => {
  const view = repo('extension/src/content/runTimelineView.js');
  assert.match(view, /empty-runs-hint/);
  assert.match(view, /tr\('emptyRunsHint'\)/);
  const css = repo('extension/styles/panel.css');
  assert.match(css, /\.empty-runs-hint/);
  const I18n = require('../extension/src/shared/i18n');
  for (const locale of ['en', 'zh']) {
    assert.notEqual(I18n.t(locale, 'emptyRunsHint'), 'emptyRunsHint', `missing ${locale} emptyRunsHint`);
  }
});

test('non-finishRunView run teardowns stop the elapsed tick explicitly', () => {
  const runtime = repo('extension/src/content/contentRuntime.js');
  const finallyBlock = runtime.match(/\} finally \{[\s\S]*?runCancellationRequested = false;/)?.[0] || '';
  assert.match(finallyBlock, /stopRunElapsedTick\(\);/);
  const catchBlock = runtime.match(/runTask\(\)\.catch\(error => \{[\s\S]*?\}\);/)?.[0] || '';
  assert.match(catchBlock, /stopRunElapsedTick\(\);/);
});

test('dead tl-pulse keyframes stay deleted and referenced animations exist', () => {
  const css = repo('extension/styles/panel.css');
  assert.doesNotMatch(css, /tl-pulse/);
  assert.match(css, /@keyframes tl-fade-in/);
  assert.match(css, /@keyframes codex-session-spin/);
});

test('settings panel destroy clears the saved-flash timer', () => {
  const settings = repo('extension/src/content/settingsPanel.js');
  const destroy = extractFunction(settings, 'destroy');
  assert.match(destroy, /clearTimeout\(instance\._savedFlashTimer\)/);
});

test('panel chrome uses one linear SVG icon system without the redundant history clock button', () => {
  const panel = repo('extension/src/content/panelRenderer.js');
  const settings = repo('extension/src/content/settingsPanel.js');
  const css = repo('extension/styles/panel.css');
  const surface = `${panel}\n${settings}`;

  assert.doesNotMatch(panel, /data-change-history/);
  assert.doesNotMatch(surface, /[↻⚙🕘✍🛡🔒🧪🎨🗄⚡]/);
  assert.match(surface, /codex-icon/);
  assert.match(settings, /codexSetIcon/);
  assert.match(css, /\.codex-icon/);
  assert.match(css, /\.codex-set-group-icon/);
});
