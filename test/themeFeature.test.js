const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repo = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const manifest = require('../extension/manifest.json');
const { DEFAULT_PANEL_STATE, normalizePanelState, prepareStateForStorage } = require('../extension/src/shared/sessionState');
const { getContentBundleSourceOrder } = require('./_helpers/contentBundleEntry');

test('themeController loads before contentRuntime in the bundle entry', () => {
  const js = getContentBundleSourceOrder();
  assert.ok(js.includes('src/content/themeController.js'), 'themeController must be a bundled content module');
  assert.ok(
    js.indexOf('src/content/themeController.js') < js.indexOf('src/content/contentRuntime.js'),
    'themeController must load before contentRuntime (which calls it)'
  );
});

test('panel.css defines a light theme overriding the core tokens, plus wash tokens', () => {
  const css = repo('extension/styles/panel.css');
  assert.match(css, /#codex-overleaf-panel\[data-theme="light"\]\s*\{/, 'light theme override block must exist');
  const light = css.match(/#codex-overleaf-panel\[data-theme="light"\]\s*\{[^}]*\}/)[0];
  assert.match(light, /--tl-surface-1:\s*#ffffff/, 'light remaps the content surface to white');
  assert.match(light, /--tl-fg-1:\s*#1f2328/, 'light remaps primary text to near-black');
  assert.match(light, /--tl-accent:\s*#2f6fb0/, 'light darkens the accent for contrast');
  // New tokens introduced by the theme work.
  assert.match(css, /--tl-surface-0:/);
  assert.match(css, /--tl-border-strong:/);
  assert.match(css, /--tl-ok-wash:/);
  // The panel root now reads tokens (themeable), not a raw hex background.
  assert.match(css, /#codex-overleaf-panel\s*\{[\s\S]*?background:\s*var\(--tl-surface-0\)/);
});

test('settingsPanel renders a wired theme selector (dark/light/auto)', () => {
  const src = repo('extension/src/content/settingsPanel.js');
  assert.match(src, /data-theme-select/);
  for (const value of ['dark', 'light', 'auto']) {
    assert.match(src, new RegExp(`value="${value}"`), `theme option ${value} must exist`);
  }
  assert.match(src, /'\[data-theme-select\]'/, 'theme select must be in the auto-save change loop');
  assert.match(src, /theme: scope\?\.querySelector\('\[data-theme-select\]'\)/, 'readState must read the theme');
  assert.match(src, /setValue\(scope, '\[data-theme-select\]', state\.theme/, 'loadState must set the theme');
});

test('contentRuntime applies the theme on render and persists the global preference', () => {
  const runtime = repo('extension/src/content/contentRuntime.js');
  const settingsCoordinator = repo('extension/src/content/projectSettingsCoordinator.js');
  assert.match(settingsCoordinator, /function applyPanelTheme\(/);
  assert.match(runtime, /applyPanelTheme\(getThemePreference\(\)\)/, 'theme must apply in applyStateToPanel');
  assert.match(settingsCoordinator, /CodexOverleafTheme\.applyTheme/);
  assert.match(runtime, /state\.theme = themePref/, 'settings change must persist theme onto state');
  assert.match(runtime, /theme:\s*\['dark', 'light', 'auto'\]\.includes\(prefs\.theme\)/, 'scoped hydration must restore the saved theme');
  assert.match(runtime, /theme:\s*\['dark', 'light', 'auto'\]\.includes\(fallback\.theme\)/, 'fallback hydration must restore the saved theme');
});

test('panel state defaults, normalizes, and persists the theme preference', () => {
  assert.equal(DEFAULT_PANEL_STATE.theme, 'dark');
  assert.equal(normalizePanelState({}).theme, 'dark');
  assert.equal(normalizePanelState({ theme: 'light' }).theme, 'light');
  assert.equal(normalizePanelState({ theme: 'auto' }).theme, 'auto');
  assert.equal(normalizePanelState({ theme: 'neon' }).theme, 'dark', 'invalid theme falls back to dark');
  assert.equal(normalizePanelState({ reasoningEffort: 'max' }).reasoningEffort, 'max');
  assert.equal(normalizePanelState({ reasoningEffort: 'ultra' }).reasoningEffort, 'ultra');
  // It is a global preference and must survive the storage round-trip (like skill toggles).
  assert.equal(prepareStateForStorage({ ...DEFAULT_PANEL_STATE, theme: 'auto' }).theme, 'auto');
  assert.equal(prepareStateForStorage({ ...DEFAULT_PANEL_STATE, theme: 'bogus' }).theme, 'dark');
});
