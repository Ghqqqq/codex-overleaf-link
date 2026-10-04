const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const SessionState = require('../extension/src/shared/sessionState');
const StorageDb = require('../extension/src/shared/storageDb');
const References = require('../extension/src/shared/lineReferences');
const ComposerDraft = require('../extension/src/shared/composerAttachmentDraft');
const { createMemoryDraftDb } = require('./_helpers/memoryDraftDb');
const { extractFunction } = require('./_helpers/extractFunction');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const tray = fs.readFileSync(path.join(__dirname, '../extension/src/content/contextTray.js'), 'utf8');
const files = [{ path: 'main.tex', kind: 'text' }, { path: 'sections/intro.tex', kind: 'text' }, { path: 'figures/a.png', kind: 'binary' }];

test('reference inventory survives record serialization and the actual runtime hydration mapper', async () => {
  const session = SessionState.createSession({ projectReferenceFiles: files });
  const record = StorageDb.buildSessionRecord({ ...session, projectId: 'project', accountScopeId: 'account' });
  assert.deepEqual(record.projectReferenceFiles, files);
  const draftStore = ComposerDraft.createStore(createMemoryDraftDb().openDb);
  const draft = ComposerDraft.createController({ getScope: () => ({ accountScopeId: 'account', projectId: 'project' }),
    getAttachments: () => [], read: draftStore.read });
  const sandbox = vm.createContext({
    cachedAccountScopeId: 'account', storageKey: 'legacy', PANEL_DEFAULT_WIDTH: 380,
    getCurrentProjectId: () => 'project', normalizeGovernanceRulesByProject: value => value || {},
    getComposerDraftPersistence: () => draft, tx: en => en,
    appendPlainLog: message => { throw new Error(message); },
    chrome: { storage: { local: { get: async () => ({}) } } },
    Modules: { StorageDb, StorageMigration: { runMigrationIfNeeded: async () => ({ prefs: {}, sessions: [record], activeSessionId: record.id }) } }
  });
  for (const name of ['buildScopedFallbackStorageKey', 'isScopedPersistenceIdentityFailure',
    'loadComposerAttachmentsForProject', 'loadStoredStateForProject']) {
    vm.runInContext(extractFunction(runtime, name), sandbox);
  }
  const restored = SessionState.normalizePanelState(await sandbox.loadStoredStateForProject('account'));
  assert.deepEqual(restored.session.projectReferenceFiles, files);
  assert.equal(References.resolveProjectReference({ rawPath: 'sections/intro.tex', projectFiles: restored.session.projectReferenceFiles }).path, 'sections/intro.tex');
  assert.equal(References.resolveProjectReference({ rawPath: 'figures/a.png', projectFiles: restored.session.projectReferenceFiles }), null);
  assert.deepEqual(StorageDb.buildSessionRecord(record).projectReferenceFiles, files);
});

test('reference persistence stores bounded safe metadata, never file bodies or absolute local paths', () => {
  const record = StorageDb.buildSessionRecord({ id: 'safe', accountScopeId: 'account', projectReferenceFiles: [
    { path: 'main.tex', kind: 'text', content: 'PRIVATE_BODY', contentBase64: 'PRIVATE_BYTES' },
    './main.tex', '../escape.tex', '/Users/private.tex', 'C:\\private.tex',
    { path: 'sections\\intro.tex', kind: 'text' }, ...files
  ] });
  assert.deepEqual(record.projectReferenceFiles, files);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_BODY|PRIVATE_BYTES|private\.tex|escape\.tex/);
  const many = StorageDb.buildSessionRecord({ accountScopeId: 'account', projectReferenceFiles: Array.from({ length: 5002 }, (_, index) => `p${index}.tex`) });
  assert.equal(many.projectReferenceFiles.length, 5000);
  assert.deepEqual(StorageDb.buildSessionRecord({}).projectReferenceFiles, []);
});

for (const busy of ['idle', 'run', 'review']) {
  test(`fresh verified inventory repairs old history without rebuilding busy UI: ${busy}`, () => {
    const session = SessionState.createSession();
    let saves = 0, renders = 0;
    const scope = {
      state: SessionState.normalizePanelState({ sessions: [session], activeSessionId: session.id }),
      getCurrentProjectId: () => 'project', updateActiveSession: SessionState.updateActiveSession,
      captureProjectReferenceFiles: project => project.files,
      currentRunView: busy === 'run' ? { runProjectId: 'project' } : null,
      trackedChangeInFlight: new Map(busy === 'review' ? [['run', true]] : []),
      saveStateSoon: () => { saves++; }, renderRunHistory: () => { renders++; }
    };
    const refresh = vm.runInNewContext('(' + extractFunction(runtime, 'refreshHistoricalProjectReferences') + ')', scope);
    refresh({ id: 'other-project', files });
    assert.equal(saves, 0);
    refresh({ id: 'project', files });
    assert.deepEqual(scope.state.session.projectReferenceFiles, files);
    assert.equal(saves, 1);
    assert.equal(renders, busy === 'idle' ? 1 : 0);
  });
}

test('context inventory arrival notifies history only after an exact list is obtained', async () => {
  const notifications = [];
  const exact = { ok: true, id: 'project', files, capabilities: { method: 'overleaf-zip-file-list' } };
  const scope = {
    contextProject: null, contextLoadId: 0, contextSyncState: 'idle',
    getPanel: () => ({ querySelector: () => ({ textContent: '' }) }),
    isContextFileListProject: value => Boolean(value?.ok),
    isExactContextFileListProject: value => value?.capabilities?.method === 'overleaf-zip-file-list',
    renderContextFiles() {}, setContextSyncState() {}, setContextStatus() {}, tr: key => key,
    requestContextFiles: async () => exact, enhanceContextFilesFromExactSnapshot() {},
    onProjectFilesReady: project => notifications.push(project)
  };
  const load = vm.runInNewContext('(' + extractFunction(tray, 'loadContextFiles') + ')', scope);
  await load();
  assert.deepEqual(notifications, [exact]);
  await load();
  assert.equal(notifications.length, 2);
  scope.contextProject = null;
  scope.requestContextFiles = async () => ({ ...exact, capabilities: { method: 'dom-file-tree' } });
  await load();
  assert.equal(notifications.length, 2);
});
