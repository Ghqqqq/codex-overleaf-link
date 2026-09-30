const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const projectFiles = require('../extension/src/shared/projectFiles');

const source = fs.readFileSync(path.join(__dirname, '../extension/src/pageBridge.js'), 'utf8');
// The function's own boundary is independent of whichever helper follows it.
const jumpSource = source.match(/^  async function jumpToPosition\([\s\S]*?\n  \}/m)?.[0];
assert.ok(jumpSource, 'the jumpToPosition RPC implementation must be available');

function createHarness({ exists = true, visible = false, openable = true } = {}) {
  const target = 'example/test.tex';
  const state = { active: 'main.tex', visible, opened: [], focused: [] };
  const jump = vm.runInNewContext('(' + jumpSource + ')', {
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    projectPathExists: file => file === target && exists && state.visible,
    getActiveFilePath: () => state.active,
    getActiveEditorIdentity: () => ({ path: state.active }),
    async openFileByPath(file) {
      state.opened.push(file);
      if (!exists || !openable) return { ok: false, reason: 'Target unavailable' };
      state.visible = true;
      state.active = file;
      return { ok: true };
    },
    waitForActiveEditorAfterNavigation: async () => ({ ok: true }),
    waitForActiveEditorText: async () => ({ ok: true }),
    readActiveEditorText: () => 'header\nsecond line\n',
    resolveJumpToPositionRange: () => ({ ok: true, from: 0, to: 6, line: 1 }),
    editorAdapter: {
      focusActiveEditorRange(from, to) {
        state.focused.push({ path: state.active, from, to });
        return { ok: true, method: 'fixture-editor-focus' };
      }
    },
    buildPageBridgeFailure: (code, details) => ({ code, ...details }),
    delay: async () => {}
  });
  return { target, state, jump };
}

test('reference navigation attempts to open a nested target before declaring it missing', async () => {
  const h = createHarness();
  const result = await h.jump({ path: h.target, line: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.opened, [h.target]);
  assert.ok(h.state.focused.length > 0);
  assert.ok(h.state.focused.every(focus => focus.path === h.target && focus.from === 0 && focus.to === 6));
});

test('reference navigation still reports a genuinely missing file after the open attempt', async () => {
  const h = createHarness({ exists: false });
  const result = await h.jump({ path: h.target, line: 1 });
  assert.equal(result.code, 'path_not_found');
  assert.equal(result.failure.code, 'target_file_not_found');
  assert.deepEqual(h.state.opened, [h.target]);
  assert.equal(h.state.focused.length, 0);
});

test('reference navigation distinguishes an existing but unopenable file', async () => {
  const h = createHarness({ visible: true, openable: false });
  const result = await h.jump({ path: h.target, line: 1 });
  assert.equal(result.code, 'file_open_failed');
  assert.equal(result.failure.code, 'target_file_open_failed');
  assert.equal(h.state.focused.length, 0);
});

test('reference navigation refuses unsafe paths before opening any file', async () => {
  const h = createHarness();
  const result = await h.jump({ path: '../main.tex', line: 1 });
  assert.equal(result.code, 'invalid_path');
  assert.equal(h.state.opened.length, 0);
  assert.equal(h.state.focused.length, 0);
});
