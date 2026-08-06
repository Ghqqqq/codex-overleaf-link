const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectFiles = require('../extension/src/shared/projectFiles');
const reviewing = require('../extension/src/shared/reviewing');
const staleGuard = require('../extension/src/shared/staleGuard');
const { runCodexSession } = require('../native-host/src/codexSessionRunner');

const pageBridgeSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/pageBridge.js'),
  'utf8'
);
const binaryAssetUploaderSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/binaryAssetUploader.js'),
  'utf8'
);
const pageRpcContractSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/shared/pageRpcContract.js'),
  'utf8'
);
const saveStateSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/saveState.js'),
  'utf8'
);
const pageBridgeCapabilitySource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/pageBridgeCapability.js'),
  'utf8'
);
const overleafCapabilitiesSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/overleafCapabilities.js'),
  'utf8'
);
const compileBridgeSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/compileBridge.js'),
  'utf8'
);
const overleafEditorSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/overleafEditor.js'),
  'utf8'
);
const overleafProjectSnapshotSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/overleafProjectSnapshot.js'),
  'utf8'
);
const treeOperationsSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/treeOperations.js'),
  'utf8'
);
const snapshotRouterSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/snapshotRouter.js'),
  'utf8'
);
const writeGuardSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/writeGuard.js'),
  'utf8'
);
const trackedChangesLifecycleSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/trackedChangesLifecycle.js'),
  'utf8'
);
const writebackRouterSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/writebackRouter.js'),
  'utf8'
);

test('mock Codex changes flow from native mirror into the Overleaf page bridge', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-e2e-'));
  const project = {
    files: [
      { path: 'main.tex', content: 'alpha beta gamma\n' }
    ]
  };

  try {
    const nativeResult = await runCodexSession({
      params: {
        projectId: 'project-e2e',
        task: '把 beta 改成 delta',
        mode: 'auto',
        project
      },
      rootDir,
      emit: () => {},
      executeCodex: async ({ workspacePath }) => {
        fs.writeFileSync(path.join(workspacePath, 'main.tex'), 'alpha delta gamma\n', 'utf8');
      }
    });

    assert.equal(nativeResult.status, 'completed');
    assert.equal(nativeResult.syncChanges.length, 1);
    assert.equal(nativeResult.syncChanges[0].path, 'main.tex');
    assert.equal(nativeResult.syncChanges[0].patches.length, 1);

    const bridge = createMinimalPageBridgeHarness({
      activePath: 'main.tex',
      files: {
        'main.tex': 'alpha beta gamma\n'
      }
    });
    const applyResult = await bridge.call('applyOperations', {
      baseFiles: project.files,
      operations: nativeResult.syncChanges.map(change => ({
        type: 'edit',
        path: change.path,
        patches: change.patches
      }))
    });

    assert.equal(applyResult.ok, true);
    assert.equal(applyResult.applied.length, 1);
    assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma\n');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function createMinimalPageBridgeHarness({ activePath, files }) {
  const fileMap = new Map(Object.entries(files));
  let selectedPath = activePath;
  let listener = null;
  let pendingResult = null;
  const bridgeCapability = 'test-page-bridge-capability';
  let capabilityInitialized = false;

  const document = {
    body: {
      innerText: 'Reviewing',
      textContent: 'Reviewing'
    },
    querySelector(selector) {
      if (/\[aria-selected="true"\]|\.selected/.test(selector)) {
        return makeTreeNode(selectedPath);
      }
      return null;
    },
    querySelectorAll(selector) {
      if (/treeitem|role="row"|file-tree|project-tree|data-entity-id|data-doc-id|data-id|data-file-id/.test(selector)) {
        return Array.from(fileMap.keys(), makeTreeNode);
      }
      return [];
    },
    execCommand() {
      return false;
    }
  };

  const window = {
    location: {
      href: 'https://www.overleaf.com/project/project-e2e',
      origin: 'https://www.overleaf.com',
      pathname: '/project/project-e2e'
    },
    CodexOverleafProjectFiles: projectFiles,
    CodexOverleafReviewing: reviewing,
    CodexOverleafStaleGuard: staleGuard,
    _ide: {
      editorView: createEditorView(),
      // Welcome-panel + write-guard v1.3.8 add-on (Task 2): the page-side
      // `getEditorProjectIdPageSide()` reader requires `_ide.project._id`.
      // Match the auto-injected `runProjectId` below so the guard passes.
      project: { _id: 'project-e2e' }
    },
    addEventListener(event, callback) {
      if (event === 'message') {
        listener = callback;
      }
    },
    postMessage(message) {
      if (message.source === 'codex-overleaf/page' && pendingResult) {
        pendingResult(message.result);
      }
    },
    setTimeout,
    clearTimeout
  };

  const context = vm.createContext({
    window,
    document,
    Node: class Node {},
    EventTarget: class EventTarget {},
    MouseEvent: class MouseEvent {},
    InputEvent: class InputEvent {},
    Event: class Event {},
    setTimeout,
    clearTimeout,
    console
  });
  vm.runInContext(overleafCapabilitiesSource, context, { filename: 'overleafCapabilities.js' });
  vm.runInContext(saveStateSource, context, { filename: 'saveState.js' });
  vm.runInContext(compileBridgeSource, context, { filename: 'compileBridge.js' });
  vm.runInContext(overleafEditorSource, context, { filename: 'overleafEditor.js' });
  vm.runInContext(treeOperationsSource, context, { filename: 'treeOperations.js' });
  vm.runInContext(snapshotRouterSource, context, { filename: 'snapshotRouter.js' });
  vm.runInContext(binaryAssetUploaderSource, context, { filename: 'binaryAssetUploader.js' });
  vm.runInContext(overleafProjectSnapshotSource, context, { filename: 'overleafProjectSnapshot.js' });
  vm.runInContext(writeGuardSource, context, { filename: 'writeGuard.js' });
  vm.runInContext(trackedChangesLifecycleSource, context, { filename: 'trackedChangesLifecycle.js' });
  vm.runInContext(writebackRouterSource, context, { filename: 'writebackRouter.js' });
  vm.runInContext(pageBridgeCapabilitySource, context, { filename: 'pageBridgeCapability.js' });
  vm.runInContext(pageRpcContractSource, context, { filename: 'pageRpcContract.js' });
  vm.runInContext(pageBridgeSource, context, { filename: 'pageBridge.js' });

  return {
    async initializeCapability() {
      if (capabilityInitialized) {
        return { ok: true, alreadyInitialized: true };
      }
      const result = await sendPageBridgeRequest('initializeCapability', {}, {
        capability: bridgeCapability
      });
      capabilityInitialized = true;
      return result;
    },
    async call(method, params) {
      await this.initializeCapability();
      // Welcome-panel + write-guard v1.3.8 add-on (Task 2): auto-inject
      // runProjectId on guarded methods so legacy e2e tests pass the
      // page-side write guard. Mirrors contentRuntime's behavior.
      const guardedMethods = new Set(['applyOperations', 'acceptTrackedChanges', 'rejectTrackedChanges']);
      let nextParams = params;
      if (guardedMethods.has(method)
        && params
        && typeof params === 'object'
        && typeof params.runProjectId !== 'string') {
        nextParams = { ...params, runProjectId: 'project-e2e' };
      }
      return sendPageBridgeRequest(method, nextParams, {
        capability: bridgeCapability
      });
    },
    getFile(filePath) {
      return fileMap.get(filePath);
    }
  };

  async function sendPageBridgeRequest(method, params, options = {}) {
    assert.equal(typeof listener, 'function');
    const resultPromise = new Promise(resolve => {
      pendingResult = resolve;
    });
    const data = {
      source: 'codex-overleaf/content',
      id: `test-call-${method}`,
      method,
      params
    };
    if (typeof options.capability === 'string') {
      data.capability = options.capability;
    }
    await listener({
      source: window,
      origin: window.location.origin,
      data
    });
    return resultPromise;
  }

  function createEditorView() {
    const doc = {
      toString() {
        return fileMap.get(selectedPath) || '';
      },
      get length() {
        return (fileMap.get(selectedPath) || '').length;
      }
    };
    return {
      state: { doc },
      dispatch(transaction) {
        const changes = Array.isArray(transaction.changes)
          ? transaction.changes
          : [transaction.changes];
        for (const change of changes.slice().sort((left, right) => right.from - left.from)) {
          const text = fileMap.get(selectedPath) || '';
          fileMap.set(selectedPath, text.slice(0, change.from) + change.insert + text.slice(change.to));
        }
      }
    };
  }

  function makeTreeNode(filePath) {
    return {
      textContent: filePath,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'data-path' || attribute === 'aria-label' || attribute === 'title') {
          return filePath;
        }
        return '';
      },
      dispatchEvent() {
        selectedPath = filePath;
        return true;
      }
    };
  }
}
