const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const projectFiles = require('../extension/src/shared/projectFiles');
const { createStoredZip } = require('./_helpers/storedZip');
const routerSource = fs.readFileSync(path.join(__dirname, '../extension/src/page/snapshotRouter.js'), 'utf8');

function createHarness({ text = '', identity = null, readError = false, onFetch, ready = null } = {}) {
  let currentIdentity = identity;
  const zip = createStoredZip({ 'main.tex': 'old server text', 'other.tex': 'other text' });
  const window = {
    location: { href: 'https://snapshot.invalid/project/test-project', origin: 'https://snapshot.invalid' },
    CodexOverleafProjectFiles: projectFiles, setTimeout, clearTimeout
  };
  const fetch = async endpoint => {
    assert.match(endpoint, /^https:\/\/snapshot\.invalid\/(?:project\/test-project\/download\/zip|download\/project\/test-project)/);
    onFetch?.(value => { currentIdentity = value; });
    return { ok: true, headers: { get: () => 'application/zip' }, arrayBuffer: async () => zip };
  };
  // snapshotRouter's fetch binding is global. Provide it inside a separate VM;
  // neither the test nor the production module can reach Node's real fetch.
  const context = vm.createContext({ window, fetch, TextDecoder, AbortController, setTimeout, clearTimeout });
  vm.runInContext(routerSource, context, { filename: 'snapshotRouter.js' });
  const router = window.CodexOverleafSnapshotRouter.create({
    readActiveEditorText() { if (readError) throw new Error('editor unavailable'); return text; },
    getActiveEditorIdentity: () => currentIdentity,
    normalizePath: projectFiles.normalizeSafeProjectPath,
    treeOperations: {
      getProjectId: () => 'test-project', getActiveFilePath: () => 'main.tex', getEditorStoreFilePath: () => 'main.tex',
      collectDocRecords: () => [], collectProjectTextPaths: () => ['main.tex', 'other.tex'],
      waitForActiveEditorText: async () => ready || { ok: false, reason: 'not ready' }
    },
    window
  });
  return { snapshot: params => router.buildProjectSnapshot({ zipOnly: true, ...params }) };
}

for (const text of ['', ' \t\n']) {
  for (const [kind, identity] of [
    ['codemirror-view', { type: 'codemirror-view', doc: { toString: () => text } }],
    ['textarea', { type: 'textarea', node: { value: text } }],
    ['contenteditable', { type: 'contenteditable', node: { innerText: text, textContent: text } }],
    ['contenteditable with only innerText', { type: 'contenteditable', node: { innerText: text } }]
  ]) {
    test('readable ' + kind + ' preserves blank text: ' + JSON.stringify(text), async () => {
      const result = await createHarness({ text, identity }).snapshot();
      assert.equal(result.files.find(file => file.path === 'main.tex').content, text);
    });
  }

  test('successful lightweight blank read survives ZIP merge: ' + JSON.stringify(text), async () => {
    const result = await createHarness({ ready: { ok: true, text } }).snapshot({
      zipOnly: false, preferLightweight: true, requireFullProject: true, allowEditorNavigation: false
    });
    assert.equal(result.capabilities.fullProjectSnapshot, true);
    assert.equal(result.files.find(file => file.path === 'main.tex').content, text);
    assert.equal(result.files.find(file => file.path === 'other.tex').content, 'other text');
  });
}

for (const [label, options] of [
  ['missing identity', {}],
  ['unready CodeMirror document', { identity: { type: 'codemirror-view', doc: null } }],
  ['non-string textarea value', { identity: { type: 'textarea', node: {} } }],
  ['contenteditable without text reader', { identity: { type: 'contenteditable', node: {} } }],
  ['unknown identity type', { identity: { type: 'unknown', node: { value: '' } } }],
  ['mismatching readable document', { identity: { type: 'codemirror-view', doc: { toString: () => 'another document' } } }],
  ['reader throws', { readError: true }],
  ['identity reader throws', { identity: { type: 'codemirror-view', doc: { toString() { throw new Error('unready'); } } } }],
  ['Loading placeholder', { text: 'Loading...', identity: { type: 'textarea', node: { value: 'Loading...' } } }]
]) {
  test('ZIP content remains when blank overlay is unproven: ' + label, async () => {
    const result = await createHarness(options).snapshot();
    assert.equal(result.files.find(file => file.path === 'main.tex').content, 'old server text');
  });
}

test('blank validity is captured before the ZIP await', async () => {
  const ready = { type: 'textarea', node: { value: '' } };
  const unreadyBefore = await createHarness({ onFetch: setIdentity => setIdentity(ready) }).snapshot();
  assert.equal(unreadyBefore.files.find(file => file.path === 'main.tex').content, 'old server text');
  const readyBefore = await createHarness({ identity: ready, onFetch: setIdentity => setIdentity(null) }).snapshot();
  assert.equal(readyBefore.files.find(file => file.path === 'main.tex').content, '');
});

test('nonempty overlay retains compatibility without an identity callback result', async () => {
  const result = await createHarness({ text: 'current text' }).snapshot();
  assert.equal(result.files.find(file => file.path === 'main.tex').content, 'current text');
});

test('undefined text in a claimed successful lightweight result cannot erase ZIP content', async () => {
  const result = await createHarness({ ready: { ok: true } }).snapshot({
    zipOnly: false, preferLightweight: true, requireFullProject: true, allowEditorNavigation: false
  });
  assert.equal(result.files.find(file => file.path === 'main.tex').content, 'old server text');
});
