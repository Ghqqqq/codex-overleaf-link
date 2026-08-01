const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectFiles = require('../extension/src/shared/projectFiles');
const overleafEditor = require('../extension/src/page/overleafEditor');
const reviewing = require('../extension/src/shared/reviewing');
const staleGuard = require('../extension/src/shared/staleGuard');
const pageRpcContractSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/shared/pageRpcContract.js'),
  'utf8'
);

const pageBridgeSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/pageBridge.js'),
  'utf8'
);
const saveStateSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/saveState.js'),
  'utf8'
);
const pageBridgeCapabilityPath = path.join(__dirname, '../extension/src/page/pageBridgeCapability.js');
const pageBridgeCapabilitySource = fs.existsSync(pageBridgeCapabilityPath)
  ? fs.readFileSync(pageBridgeCapabilityPath, 'utf8')
  : '';
const otTextSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/shared/otText.js'),
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
const overleafRealtimeObserverSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/overleafRealtimeObserver.js'),
  'utf8'
);

test('page bridge save-state source requires tri-state positive verification', () => {
  assert.doesNotMatch(saveStateSource, /assume saved/i);
  assert.match(saveStateSource, /verified_saved/);
  assert.match(saveStateSource, /unknown_timeout/);
  assert.match(saveStateSource, /unavailable/);
  assert.match(pageBridgeSource, /CodexOverleafSaveState/);
});

test('page bridge capability helper validates tokens and locks initialization', () => {
  assert.notEqual(pageBridgeCapabilitySource, '', 'pageBridgeCapability.js should exist');

  const window = {};
  const context = vm.createContext({ window, globalThis: window });
  vm.runInContext(pageBridgeCapabilitySource, context, { filename: 'pageBridgeCapability.js' });

  const capabilityHelper = window.CodexOverleafPageBridgeCapability;
  assert.equal(capabilityHelper.isValidPageBridgeCapability('short'), false);
  assert.equal(capabilityHelper.isValidPageBridgeCapability(`valid-capability-${'x'.repeat(16)}`), true);
  const unauthorized = capabilityHelper.buildUnauthorizedBridgeResult();
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, 'page_bridge_unauthorized');
  assert.equal(unauthorized.error, 'Page bridge request is not authorized');

  const guard = capabilityHelper.create();
  const first = guard.initializePageBridgeCapability('valid-capability-1234567890');
  const repeat = guard.initializePageBridgeCapability('valid-capability-1234567890');
  const conflict = guard.initializePageBridgeCapability('valid-capability-conflict');

  assert.equal(first.ok, true);
  assert.equal(first.alreadyInitialized, undefined);
  assert.equal(repeat.ok, true);
  assert.equal(repeat.alreadyInitialized, true);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'page_bridge_capability_already_initialized');
  assert.equal(guard.hasValidPageBridgeCapability('valid-capability-1234567890'), true);
  assert.equal(guard.hasValidPageBridgeCapability('valid-capability-conflict'), false);
});

test('page bridge maps a missing save indicator to unknown timeout', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('waitForSaveState', { deadlineMs: 1, pollIntervalMs: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'unknown_timeout');
  assert.match(result.reason, /save/i);
});

test('page bridge can opt into stable editor evidence when the save indicator is absent', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: { 'main.tex': 'stable content' }
  });

  const result = await bridge.call('waitForSaveState', {
    deadlineMs: 20,
    pollIntervalMs: 1,
    allowQuietEditorFallback: true,
    quietFallbackMs: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'verified_quiet');
  assert.equal(result.evidence, 'stable_editor_snapshot_without_save_indicator');
});

test('page bridge only returns ok true for a verified saved indicator', async () => {
  const verifiedIndicators = [
    'All changes saved',
    'Changes saved',
    'Saved'
  ];

  for (const saveIndicatorText of verifiedIndicators) {
    const bridge = createPageBridgeHarness({
      activePath: 'main.tex',
      saveIndicatorText,
      files: {
        'main.tex': 'alpha'
      }
    });

    const result = await bridge.call('waitForSaveState', { deadlineMs: 1, pollIntervalMs: 1 });

    assert.equal(result.ok, true, saveIndicatorText);
    assert.equal(result.state, 'verified_saved', saveIndicatorText);
  }
});

test('page bridge verifies visible saved text with generic save accessibility labels', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    saveIndicatorText: 'All changes saved',
    saveIndicatorAriaLabel: 'Save project',
    saveIndicatorTitle: 'Save project',
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('waitForSaveState', { deadlineMs: 1, pollIntervalMs: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'verified_saved');
});

test('page bridge ignores hidden saved indicators when visible save state is not verified', async () => {
  const hiddenSavedIndicators = [
    { label: 'hidden attribute', node: { text: 'All changes saved', hidden: true } },
    { label: 'aria-hidden', node: { text: 'All changes saved', ariaHidden: true } },
    { label: 'display none', node: { text: 'All changes saved', display: 'none' } },
    { label: 'visibility hidden', node: { text: 'All changes saved', visibility: 'hidden' } },
    { label: 'inert', node: { text: 'All changes saved', inert: true } }
  ];
  const visibleIndicators = [
    'Saving...',
    'Not saved'
  ];

  for (const { label, node } of hiddenSavedIndicators) {
    for (const visibleText of visibleIndicators) {
      const message = `${label}: ${visibleText}`;
      const bridge = createPageBridgeHarness({
        activePath: 'main.tex',
        saveIndicatorNodes: [
          node,
          { text: visibleText }
        ],
        files: {
          'main.tex': 'alpha'
        }
      });

      const result = await bridge.call('waitForSaveState', { deadlineMs: 1, pollIntervalMs: 1 });

      assert.equal(result.ok, false, message);
      assert.equal(result.state, 'unknown_timeout', message);
    }
  }
});

test('page bridge prefers visible unverified save state over hidden stale saved state', async () => {
  for (const visibleText of ['Saving...', 'Not saved']) {
    const bridge = createPageBridgeHarness({
      activePath: 'main.tex',
      saveIndicatorNodes: [
        { text: 'All changes saved', hidden: true },
        { text: visibleText }
      ],
      files: {
        'main.tex': 'alpha'
      }
    });

    const result = await bridge.call('waitForSaveState', { deadlineMs: 1, pollIntervalMs: 1 });

    assert.equal(result.ok, false, visibleText);
    assert.equal(result.state, 'unknown_timeout', visibleText);
  }
});

test('page bridge scans all visible save indicators before verifying saved state', async () => {
  for (const visibleText of ['Not saved', 'Saving...']) {
    const bridge = createPageBridgeHarness({
      activePath: 'main.tex',
      saveIndicatorNodes: [
        { text: 'All changes saved' },
        { text: visibleText }
      ],
      files: {
        'main.tex': 'alpha'
      }
    });

    const result = await bridge.call('waitForSaveState', { deadlineMs: 1, pollIntervalMs: 1 });

    assert.equal(result.ok, false, visibleText);
    assert.equal(result.state, 'unknown_timeout', visibleText);
  }
});

test('page bridge does not verify negative save indicators', async () => {
  const negativeIndicators = [
    'Not saved',
    'Not all changes saved',
    'Changes not saved',
    'Save failed',
    '未保存',
    '保存失败'
  ];

  for (const saveIndicatorText of negativeIndicators) {
    const bridge = createPageBridgeHarness({
      activePath: 'main.tex',
      saveIndicatorText,
      files: {
        'main.tex': 'alpha'
      }
    });

    const result = await bridge.call('waitForSaveState', { deadlineMs: 1, pollIntervalMs: 1 });

    assert.equal(result.ok, false, saveIndicatorText);
    assert.equal(result.state, 'unknown_timeout', saveIndicatorText);
  }
});

test('page bridge allows multiple successful edits to the same fresh file', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'one' },
      { type: 'edit', path: 'main.tex', find: 'gamma', replace: 'three' }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.applied.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'one beta three');
});

test('page bridge blocks stale file-tree deletes before mutating Overleaf state', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'user changed'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'base snapshot' }
    ],
    operations: [
      { type: 'delete', path: 'main.tex', reason: 'remove stale file' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'stale_snapshot');
  assert.equal(bridge.getFile('main.tex'), 'user changed');
});

test('page bridge blocks creates that collide with files added after the task snapshot', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'base',
      'new.tex': 'user-created content'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'base' }
    ],
    operations: [
      { type: 'create', path: 'new.tex', content: 'codex content' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'path_created_since_snapshot');
  assert.equal(bridge.getFile('new.tex'), 'user-created content');
});

test('page bridge keeps safe nested operation paths working', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'sections/main.tex',
    files: {
      'sections/main.tex': 'alpha'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'sections/main.tex', content: 'alpha' }
    ],
    operations: [
      { type: 'edit', path: 'sections/main.tex', find: 'alpha', replace: 'beta' }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(bridge.getFile('sections/main.tex'), 'beta');
});

test('page bridge opens nested same-basename files before writeback', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'test.tex',
    basenameOnlyTreeLabels: true,
    exposeInternalDocTree: true,
    files: {
      'test.tex': 'root alpha',
      'example/test.tex': 'nested alpha'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'test.tex', content: 'root alpha' },
      { path: 'example/test.tex', content: 'nested alpha' }
    ],
    operations: [
      { type: 'edit', path: 'example/test.tex', find: 'nested', replace: 'initialized' }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(bridge.getFile('test.tex'), 'root alpha');
  assert.equal(bridge.getFile('example/test.tex'), 'initialized alpha');
  assert.equal(bridge.getEditorPath(), 'example/test.tex');
});

test('page bridge rejects spoofed mutating requests without the content capability', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha beta'
    }
  });

  await bridge.initializeCapability();

  const result = await bridge.spoofCall('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'page_bridge_unauthorized');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta');
  assert.equal(bridge.getDispatchCount(), 0);
});

test('page bridge rejects spoofed tracked-change rejection and compile requests without the content capability', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha beta'
    }
  });

  await bridge.initializeCapability();

  for (const [method, params] of [
    ['rejectTrackedChanges', { trackedChanges: [{ key: 'id:change-1', id: 'change-1', path: 'main.tex' }] }],
    ['triggerCompile', {}]
  ]) {
    const result = await bridge.spoofCall(method, params);
    assert.equal(result.ok, false, method);
    assert.equal(result.code, 'page_bridge_unauthorized', method);
  }
});

test('page bridge rejects unsafe project paths before mutating the active file', async () => {
  const unsafePaths = [
    '../x',
    '.',
    '..',
    '/abs.tex',
    'C:\\tmp\\x.tex',
    'folder\\file.tex',
    'folder/%2e%2e/file.tex',
    'bad\u0000name.tex'
  ];

  for (const unsafePath of unsafePaths) {
    const bridge = createPageBridgeHarness({
      activePath: 'main.tex',
      files: {
        'main.tex': 'alpha beta'
      }
    });

    const result = await bridge.call('applyOperations', {
      baseFiles: [
        { path: 'main.tex', content: 'alpha beta' }
      ],
      operations: [
        { type: 'edit', path: unsafePath, find: 'alpha', replace: 'omega' }
      ]
    });

    assert.equal(result.ok, false, unsafePath);
    assert.equal(result.applied.length, 0, unsafePath);
    assert.equal(result.skipped.length, 1, unsafePath);
    assert.equal(result.skipped[0].result.code, 'invalid_project_path', unsafePath);
    assert.equal(bridge.getFile('main.tex'), 'alpha beta', unsafePath);
  }
});

test('page bridge applies edit patches as local CodeMirror changes', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].result.method, 'codemirror-view-patch');
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
  assert.deepEqual(bridge.getLastDispatchChanges(), [
    { from: 6, to: 10, insert: 'delta' }
  ]);
});

test('page bridge jumpToPosition opens target file and records CodeMirror selection', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'main file content',
      'refs.bib': '@book{key,\n  title = {Old}\n}'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'refs.bib',
    from: 7,
    to: 10
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codemirror-view-selection');
  assert.equal(result.path, 'refs.bib');
  assert.equal(result.from, 7);
  assert.equal(result.to, 10);
  assert.equal(bridge.getFile('main.tex'), 'main file content');
  assert.equal(bridge.getFile('refs.bib'), '@book{key,\n  title = {Old}\n}');
  assert.deepEqual(bridge.getLastSelection(), { anchor: 7, head: 10 });
  assert.equal(bridge.getLastDispatchChanges(), null);
});

test('page bridge jumpToPosition selects requested one-based line content', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'first line\nsecond line\nthird line'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 2,
    selectLine: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codemirror-view-selection');
  assert.equal(result.path, 'main.tex');
  assert.deepEqual(bridge.getLastSelection(), { anchor: 11, head: 22 });
  assert.equal(bridge.getLastScrollIntoView(), true);
});

test('page bridge jumpToPosition selectLine wins over requested column', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'first line\nsecond line\nthird line'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 2,
    column: 1,
    selectLine: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codemirror-view-selection');
  assert.equal(result.path, 'main.tex');
  assert.equal(result.from, 11);
  assert.equal(result.to, 22);
  assert.deepEqual(bridge.getLastSelection(), { anchor: 11, head: 22 });
});

test('page bridge jumpToPosition line_out_of_range includes requested line and lineCount', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'first line\nsecond line'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 3
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'line_out_of_range');
  assert.equal(result.path, 'main.tex');
  assert.equal(result.line, 3);
  assert.equal(result.lineCount, 2);
});

test('page bridge jumpToPosition column_out_of_range includes requested line, column, and lineLength', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'abc\ndef'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 2,
    column: 5
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'column_out_of_range');
  assert.equal(result.path, 'main.tex');
  assert.equal(result.line, 2);
  assert.equal(result.column, 5);
  assert.equal(result.lineLength, 3);
});

test('page bridge jumpToPosition places cursor at requested one-based column', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'abc\ndef'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 2,
    column: 2,
    selectLine: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codemirror-view-selection');
  assert.equal(result.path, 'main.tex');
  assert.deepEqual(bridge.getLastSelection(), { anchor: 5, head: 5 });
});

test('page bridge jumpToPosition rejects out-of-range line requests', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'abc\ndef'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 3,
    selectLine: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'line_out_of_range');
  assert.equal(result.path, 'main.tex');
  assert.deepEqual(bridge.getLastSelection(), null);
});

test('page bridge jumpToPosition rejects out-of-range column requests', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'abc\ndef'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 2,
    column: 5,
    selectLine: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'column_out_of_range');
  assert.equal(result.path, 'main.tex');
  assert.deepEqual(bridge.getLastSelection(), null);
});

test('page bridge jumpToPosition accounts for CRLF line endings when selecting a line', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'aa\r\nbbb\r\nc'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 2,
    selectLine: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codemirror-view-selection');
  assert.equal(result.path, 'main.tex');
  assert.deepEqual(bridge.getLastSelection(), { anchor: 4, head: 7 });
});

test('page bridge jumpToPosition selects the last line without a trailing newline', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'one\ntwo'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    line: 2,
    selectLine: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codemirror-view-selection');
  assert.equal(result.path, 'main.tex');
  assert.deepEqual(bridge.getLastSelection(), { anchor: 4, head: 7 });
});

test('page bridge jumpToPosition keeps offset ranges unchanged when line mode is absent', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'abcdef'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    from: 2,
    to: 4
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codemirror-view-selection');
  assert.equal(result.path, 'main.tex');
  assert.equal(result.from, 2);
  assert.equal(result.to, 4);
  assert.deepEqual(bridge.getLastSelection(), { anchor: 2, head: 4 });
});

test('page bridge jumpToPosition opens target file before resolving line positions', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'main file content',
      'refs.bib': 'top\nmiddle\nbottom'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'refs.bib',
    line: 2,
    selectLine: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codemirror-view-selection');
  assert.equal(result.path, 'refs.bib');
  assert.deepEqual(bridge.getLastSelection(), { anchor: 4, head: 10 });
});

test('page bridge jumpToPosition rejects out-of-range offsets without modifying content', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'main.tex',
    from: 0,
    to: 99
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'range_out_of_bounds');
  assert.match(result.reason, /out of range/i);
  assert.equal(result.path, 'main.tex');
  assert.equal(bridge.getFile('main.tex'), 'alpha');
  assert.equal(bridge.getDispatchCount(), 0);
  assert.equal(bridge.getLastSelection(), null);
});

test('page bridge jumpToPosition waits for delayed editor document switch before range validation', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorSwitchDelayMs: 360,
    files: {
      'main.tex': 'main file content is long enough for a stale selection',
      'refs.bib': 'short'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'refs.bib',
    from: 0,
    to: 10
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'range_out_of_bounds');
  assert.equal(result.path, 'refs.bib');
  assert.equal(result.length, 5);
  assert.equal(bridge.getDispatchCount(), 0);
  assert.equal(bridge.getLastSelection(), null);
});

test('page bridge jumpToPosition succeeds after delayed switch when target content matches previous file', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorSwitchDelayMs: 360,
    files: {
      'main.tex': 'identical content',
      'refs.bib': 'identical content'
    }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'refs.bib',
    from: 0,
    to: 9
  });

  assert.equal(result.ok, true, result.reason || JSON.stringify(result));
  assert.equal(result.path, 'refs.bib');
  assert.equal(bridge.getEditorPath(), 'refs.bib');
  assert.deepEqual(bridge.getLastSelection(), { anchor: 0, head: 9 });
  assert.equal(bridge.getLastDispatchChanges(), null);
});

test('editor adapter contenteditable fallback does not hard-bound range by rendered DOM text length', () => {
  let focused = false;
  const adapter = overleafEditor.create({
    findEditorContentNode(selector) {
      if (selector === '.cm-content') {
        return {
          innerText: 'visible',
          focus() {
            focused = true;
          }
        };
      }
      return null;
    },
    findEditorTextArea() {
      return null;
    },
    getCodeMirrorEditorView() {
      return null;
    },
    getDeepActiveElement() {
      return null;
    }
  });

  const result = adapter.focusActiveEditorRange(0, 99);

  assert.equal(result.ok, true);
  assert.equal(result.method, 'selection-fallback');
  assert.equal(focused, true);
});

test('page bridge waits for editor document after opening target file before stale guarding patches', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorSwitchDelayMs: 360,
    files: {
      'main.tex': 'main file content that must not receive checklist edits',
      'checklist.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'main file content that must not receive checklist edits' },
      { path: 'checklist.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'checklist.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(bridge.getFile('main.tex'), 'main file content that must not receive checklist edits');
  assert.equal(bridge.getFile('checklist.tex'), 'alpha delta gamma');
});

test('page bridge rejects stale patch expected text before editing', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha user gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha user gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].result.code, 'stale_patch');
  assert.equal(bridge.getFile('main.tex'), 'alpha user gamma');
});

test('page bridge rejects edits when Overleaf readback does not match the intended content', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    dispatchApplies: false,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'write_verification_failed');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
});

test('page bridge can activate Reviewing before write operations', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: false,
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('ensureReviewing', {});

  assert.equal(result.ok, true);
  assert.equal(result.activated, true);
  assert.equal(bridge.getReviewingClickCount(), 1);
});

test('page bridge can activate Reviewing through the current Editing mode dropdown', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: false,
    reviewingClickBehavior: 'menu',
    reviewingButtonShowsCurrentMode: true,
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('ensureReviewing', {});

  assert.equal(result.ok, true, result.reason || JSON.stringify(result));
  assert.equal(result.activated, true);
  assert.equal(bridge.getReviewingClickCount(), 1);
  assert.equal(bridge.getModeOptionClickCount(), 1);
  assert.equal(bridge.isReviewingActive(), true);
});

test('page bridge can activate Reviewing from a roleless dropdown item', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: false,
    reviewingClickBehavior: 'menu',
    reviewingButtonShowsCurrentMode: true,
    modeOptionRole: '',
    modeOptionClassName: 'dropdown-item',
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('ensureReviewing', {});

  assert.equal(result.ok, true, result.reason || JSON.stringify(result));
  assert.equal(bridge.getReviewingClickCount(), 1);
  assert.equal(bridge.getModeOptionClickCount(), 1);
  assert.equal(bridge.isReviewingActive(), true);
});

test('page bridge does not treat internal Reviewing permission flags as active write-safe mode', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: false,
    reviewingClickActivates: false,
    reviewingClickBehavior: 'noop',
    reviewingButtonShowsCurrentMode: true,
    internalReviewingState: true,
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('ensureReviewing', { waitMs: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'reviewing_not_enabled');
  assert.equal(result.activated, undefined);
  assert.equal(bridge.getReviewingClickCount(), 1);
  assert.equal(bridge.isReviewingActive(), false);
});

test('page bridge blocks required Reviewing writes at the final apply boundary', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: false,
    reviewingClickBehavior: 'noop',
    reviewingButtonShowsCurrentMode: true,
    internalReviewingState: true,
    files: {
      'main.tex': 'alpha beta'
    }
  });

  const result = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'reviewing_not_enabled');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta');
});

test('page bridge switches to Editing before untracked write operations', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    reviewingClickBehavior: 'menu',
    reviewingButtonShowsCurrentMode: true,
    files: {
      'main.tex': 'alpha beta'
    }
  });

  const result = await bridge.call('applyOperations', {
    requireEditing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(bridge.getFile('main.tex'), 'omega beta');
  assert.equal(bridge.getReviewingClickCount(), 1);
  assert.equal(bridge.getModeOptionClickCount(), 1);
  assert.equal(bridge.isReviewingActive(), false);
  assert.equal(result.reviewingPolicy.policy, 'editing-write');
  assert.equal(result.reviewingPolicy.disabled, true);
  assert.equal(result.reviewingPolicy.leftEditing, true);
});

test('page bridge blocks untracked writes when Editing cannot be confirmed', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    reviewingClickBehavior: 'noop',
    reviewingButtonShowsCurrentMode: true,
    files: {
      'main.tex': 'alpha beta'
    }
  });

  const result = await bridge.call('applyOperations', {
    requireEditing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'editing_not_confirmed');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta');
  assert.equal(bridge.isReviewingActive(), true);
});

test('page bridge rejects write-safety confirmation when Reviewing click does not activate', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: false,
    reviewingClickActivates: false,
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('ensureReviewing', { waitMs: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'reviewing_not_enabled');
  assert.equal(bridge.getReviewingClickCount(), 1);
});

test('page bridge applies undo operations with Reviewing disabled and leaves Editing active', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingClickBehavior: 'toggle',
    reviewingOk: true,
    files: {
      'main.tex': 'alpha delta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ],
    reviewingPolicy: 'no-trace-undo',
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 11, expected: 'delta', insert: 'beta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getReviewingClickCount(), 1);
  assert.equal(bridge.isReviewingActive(), false);
  assert.equal(result.reviewingPolicy.policy, 'no-trace-undo');
  assert.equal(result.reviewingPolicy.disabled, true);
  assert.equal(result.reviewingPolicy.restored, false);
  assert.equal(result.reviewingPolicy.leftEditing, true);
});

test('page bridge applies all no-trace undo patches for one file in a single call', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingClickBehavior: 'toggle',
    reviewingOk: true,
    files: {
      'main.tex': 'alpha delta theta'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha delta theta' }
    ],
    reviewingPolicy: 'no-trace-undo',
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 12, to: 17, expected: 'theta', insert: 'gamma' }
        ]
      },
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 11, expected: 'delta', insert: 'beta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.applied.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getDispatchCount(), 2);
});

test('page bridge no-trace undo waits when active path switches before editor content catches up', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    initialEditorPath: 'refs.bib',
    initialEditorCatchUpDelayMs: 180,
    reviewingClickBehavior: 'toggle',
    reviewingOk: true,
    files: {
      'main.tex': 'alpha delta gamma',
      'refs.bib': '@book{stale}'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ],
    reviewingPolicy: 'no-trace-undo',
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        replaceAll: 'alpha beta gamma'
      }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getDispatchCount(), 1);
});

test('page bridge records and rejects Overleaf tracked changes for Reviewing writes', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
  assert.equal(write.trackedChanges.length, 1);
  assert.equal(write.trackedChanges[0].path, 'main.tex');

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: write.trackedChanges,
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 1);
  assert.equal(undo.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getDispatchCount(), 1);
  assert.equal(bridge.getTrackedChangeCount(), 0);
  assert.equal(bridge.getRejectClickCount(), 1);
});

test('page bridge waits for delayed Overleaf tracked-change markers after a Reviewing write', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    trackedChangeRenderDelayMs: 250,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
  assert.equal(write.trackedChanges.length, 1);
  assert.equal(write.trackedChanges[0].path, 'main.tex');
});

test('page bridge routes acceptTrackedChanges to the writeback router: editor-undo then untracked replay', async () => {
  // Accept All no longer hunts per-change Accept controls. It editor-undoes the
  // run's tracked writeback back to its pre-write content, then re-applies the
  // post-write content as a plain (untracked) edit. The harness's editor-undo
  // button restores editorUndoTargets[path] (the pre-write content); the
  // mode button toggles so Editing-mode replay + Reviewing restore both work.
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    reviewingClickBehavior: 'toggle',
    trackChangesOnDispatch: true,
    editorUndoTargets: {
      'main.tex': 'alpha beta gamma'
    },
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
  assert.equal(write.trackedChanges.length, 1);
  assert.equal(write.trackedChanges[0].path, 'main.tex');

  const accept = await bridge.call('acceptTrackedChanges', {
    trackedChanges: write.trackedChanges,
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ]
  });

  assert.equal(accept.ok, true, accept.error || JSON.stringify(accept));
  assert.ok(accept.applied.length >= 1);
  assert.equal(accept.skipped.length, 0);
  // The run's post-write content is in the document as plain text.
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
  // The editor-undo cleared the run's tracked changes; the replay was untracked.
  assert.equal(bridge.getTrackedChangeCount(), 0);
  assert.equal(bridge.getEditorUndoClickCount(), 1);
  // No per-change Accept / Reject control hunting.
  assert.equal(bridge.getAcceptClickCount(), 0);
  assert.equal(bridge.getRejectClickCount(), 0);
  // Accept All intentionally leaves Overleaf in Editing after the replay to
  // avoid re-tracking races; the prior Reviewing mode is NOT auto-restored.
  assert.equal(bridge.isReviewingActive(), false);
});

test('page bridge acceptTrackedChanges preserves a unique unrelated suffix while replaying the run', async () => {
  // The editor-undo cannot reach the pre-write content after a reload or a
  // later edit. When the exact post-write checkpoint still occurs once, the
  // snapshot fallback may safely preserve its surrounding prefix/suffix while
  // accepting only this run's change.
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    reviewingClickBehavior: 'toggle',
    trackChangesOnDispatch: true,
    editorUndoTargets: {
      'main.tex': 'alpha beta gamma'
    },
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });
  assert.equal(write.ok, true, write.error || JSON.stringify(write));

  // The user appends unrelated content after the run. The run checkpoint is
  // still present exactly once, so it can be rebased without guessing.
  bridge.setFile('main.tex', 'alpha delta gamma plus user edit');

  const accept = await bridge.call('acceptTrackedChanges', {
    trackedChanges: write.trackedChanges,
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ]
  });

  assert.equal(accept.ok, true, JSON.stringify(accept));
  assert.equal(accept.skipped.length, 0, JSON.stringify(accept));
  // The tracked run edit is replayed untracked while the later suffix remains.
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma plus user edit');
  assert.equal(bridge.getEditorUndoClickCount(), 0, 'snapshot fallback is used when native undo cannot prove the checkpoint');
});

test('page bridge rejects unsafe tracked-change paths before clicking reject controls', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(write.trackedChanges.length, 1);

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: [
      {
        ...write.trackedChanges[0],
        path: '../main.tex'
      }
    ]
  });

  assert.equal(undo.ok, false);
  assert.equal(undo.applied.length, 0);
  assert.equal(undo.skipped.length, 1);
  assert.equal(undo.skipped[0].result.code, 'invalid_project_path');
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
  assert.equal(bridge.getRejectClickCount(), 0);
  assert.equal(bridge.getTrackedChangeCount(), 1);
});

test('page bridge records tracked changes for each edited file in a Reviewing write', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    files: {
      'main.tex': 'alpha beta gamma',
      'refs.bib': 'title = {Old}'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' },
      { path: 'refs.bib', content: 'title = {Old}' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      },
      {
        type: 'edit',
        path: 'refs.bib',
        patches: [
          { from: 9, to: 12, expected: 'Old', insert: 'New' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.deepEqual(Array.from(write.trackedChanges, change => change.path).sort(), ['main.tex', 'refs.bib']);
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
  assert.equal(bridge.getFile('refs.bib'), 'title = {New}');

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: write.trackedChanges,
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' },
      { path: 'refs.bib', content: 'title = {Old}' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 2);
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getFile('refs.bib'), 'title = {Old}');
  assert.equal(bridge.getTrackedChangeCount(), 0);
  assert.equal(bridge.getRejectClickCount(), 2);
});

test('page bridge rejects multiple tracked changes in one file newest first', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      },
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 12, to: 17, expected: 'gamma', insert: 'theta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(bridge.getFile('main.tex'), 'alpha delta theta');
  assert.equal(write.trackedChanges.length, 2);

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: write.trackedChanges,
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 2);
  assert.equal(undo.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getRejectClickCount(), 2);
  assert.deepEqual(bridge.getRejectedChangeIds(), ['change-2', 'change-1']);
});

test('page bridge uses Overleaf editor undo to revert a tracked-change batch in one call', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    editorUndoTargets: {
      'main.tex': 'alpha beta gamma'
    },
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' },
          { from: 11, to: 16, expected: 'gamma', insert: 'theta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(bridge.getFile('main.tex'), 'alpha delta theta');
  assert.equal(write.trackedChanges.length, 1);

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: write.trackedChanges,
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'alpha delta theta' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 1);
  assert.equal(undo.skipped.length, 0);
  assert.equal(undo.applied[0].result.method, 'overleaf-editor-undo');
  assert.equal(undo.applied[0].result.verified, true);
  assert.equal(undo.applied[0].result.verifiedContent, 'alpha beta gamma');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getEditorUndoClickCount(), 1);
  assert.equal(bridge.getRejectClickCount(), 0);
});

test('page bridge native undo waits when active path switches before editor content catches up', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    initialEditorPath: 'refs.bib',
    initialEditorCatchUpDelayMs: 180,
    reviewingOk: true,
    editorUndoTargets: {
      'main.tex': 'alpha beta gamma'
    },
    files: {
      'main.tex': 'alpha delta gamma',
      'refs.bib': '@book{stale}'
    }
  });

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: [],
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 1);
  assert.equal(undo.skipped.length, 0);
  assert.equal(undo.applied[0].result.method, 'overleaf-editor-undo');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getEditorUndoClickCount(), 1);
});

test('page bridge native undo force-reopens a selected path whose editor document is still stale', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    initialEditorPath: 'refs.bib',
    reviewingOk: true,
    editorUndoTargets: {
      'main.tex': 'alpha beta gamma'
    },
    files: {
      'main.tex': 'alpha delta gamma',
      'refs.bib': '@book{stale}'
    }
  });

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: [],
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 1);
  assert.equal(undo.skipped.length, 0);
  assert.equal(bridge.getEditorPath(), 'main.tex');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getEditorUndoClickCount(), 1);
});

test('page bridge does not use editor undo after user edits change the post-run content', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    editorUndoTargets: {
      'main.tex': 'alpha beta gamma'
    },
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  bridge.setFile('main.tex', 'alpha delta theta user edit');

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: write.trackedChanges,
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(bridge.getEditorUndoClickCount(), 0);
  assert.equal(bridge.getRejectClickCount(), 1);
});

test('page bridge can undo a reviewing write with no captured tracked-change refs', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    editorUndoTargets: {
      'main.tex': 'alpha beta gamma'
    },
    files: {
      'main.tex': 'alpha delta gamma'
    }
  });

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: [],
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 1);
  assert.equal(undo.skipped.length, 0);
  assert.equal(undo.applied[0].result.method, 'overleaf-editor-undo');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getEditorUndoClickCount(), 1);
  assert.equal(bridge.getRejectClickCount(), 0);
});

test('page bridge continues tracked-change undo after Overleaf rerenders review ids', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    rerenderTrackedChangeIdsOnReject: true,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      },
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 12, to: 17, expected: 'gamma', insert: 'theta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(write.trackedChanges.length, 2);
  assert.equal(bridge.getFile('main.tex'), 'alpha delta theta');

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: write.trackedChanges,
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getTrackedChangeCount(), 0);
  assert.equal(bridge.getRejectClickCount(), 2);
});

test('page bridge rejects remaining tracked changes when stored refs are incomplete', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      },
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 12, to: 17, expected: 'gamma', insert: 'theta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(write.trackedChanges.length, 2);
  assert.equal(bridge.getFile('main.tex'), 'alpha delta theta');

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: [
      write.trackedChanges[1]
    ],
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ]
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 2);
  assert.equal(undo.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getTrackedChangeCount(), 0);
  assert.equal(bridge.getRejectClickCount(), 2);
});

test('page bridge sweeps remaining tracked changes for old undo records without expected files', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      },
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 12, to: 17, expected: 'gamma', insert: 'theta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(write.trackedChanges.length, 2);
  assert.equal(bridge.getFile('main.tex'), 'alpha delta theta');

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: [
      write.trackedChanges[1]
    ],
    expectedFiles: []
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 2);
  assert.equal(undo.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getTrackedChangeCount(), 0);
  assert.equal(bridge.getRejectClickCount(), 2);
});

test('page bridge sweeps active file tracked changes when old undo refs have no path', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    trackChangesOnDispatch: true,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const write = await bridge.call('applyOperations', {
    requireReviewing: true,
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 10, expected: 'beta', insert: 'delta' }
        ]
      },
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 12, to: 17, expected: 'gamma', insert: 'theta' }
        ]
      }
    ]
  });

  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(write.trackedChanges.length, 2);

  const undo = await bridge.call('rejectTrackedChanges', {
    trackedChanges: [
      {
        ...write.trackedChanges[1],
        path: ''
      }
    ],
    expectedFiles: []
  });

  assert.equal(undo.ok, true, undo.error || JSON.stringify(undo));
  assert.equal(undo.applied.length, 2);
  assert.equal(undo.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getTrackedChangeCount(), 0);
  assert.equal(bridge.getRejectClickCount(), 2);
});

test('page bridge refuses tracked-change undo when the Overleaf review marker cannot be found', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    files: {
      'main.tex': 'alpha delta gamma'
    }
  });

  const result = await bridge.call('rejectTrackedChanges', {
    trackedChanges: [
      { key: 'missing-change', path: 'main.tex' }
    ],
    expectedFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'tracked_change_not_found');
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
});

test('page bridge disables Reviewing through an Overleaf mode dropdown before undo', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingClickBehavior: 'menu',
    reviewingOk: true,
    files: {
      'main.tex': 'alpha delta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ],
    reviewingPolicy: 'no-trace-undo',
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 11, expected: 'delta', insert: 'beta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getReviewingClickCount(), 1);
  assert.equal(bridge.getModeOptionClickCount(), 1);
  assert.equal(bridge.isReviewingActive(), false);
  assert.equal(result.reviewingPolicy.disabled, true);
  assert.equal(result.reviewingPolicy.restored, false);
  assert.equal(result.reviewingPolicy.leftEditing, true);
});

test('page bridge blocks no-trace undo when Reviewing cannot be disabled', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingClickBehavior: 'noop',
    reviewingOk: true,
    files: {
      'main.tex': 'alpha delta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ],
    reviewingPolicy: 'no-trace-undo',
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 11, expected: 'delta', insert: 'beta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'reviewing_disable_failed');
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
  assert.equal(bridge.isReviewingActive(), true);
});

test('page bridge blocks no-trace undo when Editing mode is not positively confirmed', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: false,
    reviewingClickBehavior: 'noop',
    exposeReviewingActiveState: false,
    files: {
      'main.tex': 'alpha delta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ],
    reviewingPolicy: 'no-trace-undo',
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 11, expected: 'delta', insert: 'beta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'editing_not_confirmed');
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
});

test('page bridge does not treat a loose Editing button as confirmed no-trace undo mode', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    reviewingClickBehavior: 'noop',
    exposeReviewingActiveState: false,
    includeLooseEditingButton: true,
    files: {
      'main.tex': 'alpha delta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [
      { path: 'main.tex', content: 'alpha delta gamma' }
    ],
    reviewingPolicy: 'no-trace-undo',
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 11, expected: 'delta', insert: 'beta' }
        ]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'editing_not_confirmed');
  assert.equal(bridge.getFile('main.tex'), 'alpha delta gamma');
});

test('page bridge probe reports capabilities for explicit degradation messages', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha'
    }
  });

  const result = await bridge.call('probe', {});

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.capabilities.editor.read, true);
  assert.equal(result.capabilities.editor.write, true);
  assert.equal(result.capabilities.fileTree.write, true);
  assert.equal(result.capabilities.compile.capture, false);
  assert.ok(Array.isArray(result.capabilities.warnings));
});

test('page bridge starts, drains, and stops the read-only OT observer', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha'
    }
  });

  const startStatus = await bridge.call('startOtObserver', { projectId: 'test-project' });

  assert.equal(startStatus.status, 'observing');
  assert.equal(startStatus.state, 'observing');
  assert.equal(startStatus.running, true);
  assert.equal(startStatus.activePath, 'main.tex');

  bridge.setFile('main.tex', 'alpha beta');
  bridge.fireDocumentEvent('input');

  const activeStatus = await bridge.call('getOtStatus', {});
  assert.equal(activeStatus.status, 'observing');
  assert.equal(activeStatus.state, 'observing');
  assert.equal(activeStatus.queuedEventCount, 1);

  const drained = await bridge.call('drainOtEvents', {});
  const drainedEvents = JSON.parse(JSON.stringify(drained.events));
  assert.equal(drained.ok, true);
  assert.equal(drainedEvents.length, 1);
  assert.equal(drainedEvents[0].path, 'main.tex');
  assert.equal(drainedEvents[0].nextContent, 'alpha beta');
  assert.equal(Object.prototype.hasOwnProperty.call(drainedEvents[0], 'ops'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(drainedEvents[0], 'previousContent'), false);

  const empty = await bridge.call('drainOtEvents', {});
  assert.equal(empty.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(empty.events)), []);

  const stopStatus = await bridge.call('stopOtObserver', {});
  assert.equal(stopStatus.status, 'off');
  assert.equal(stopStatus.state, 'off');
  assert.equal(stopStatus.running, false);
});

test('page bridge whitelists OT event fields before posting to content', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: {
      'main.tex': 'alpha'
    },
    realtimeObserverFactory() {
      return {
        start() {
          return { status: 'observing', state: 'observing', running: true };
        },
        stop() {
          return { status: 'off', state: 'off', running: false };
        },
        getStatus() {
          return { status: 'observing', state: 'observing', queuedEventCount: 1 };
        },
        drainEvents() {
          return [{
            path: 'main.tex',
            baseHash: 'base-hash',
            nextHash: 'next-hash',
            nextContent: 'alpha beta',
            previousContent: 'alpha secret',
            ops: [{ p: 5, d: ' secret' }],
            observedAt: '2026-05-05T00:00:00.000Z',
            observedVersion: 'doc-version-2',
            source: 'fake-observer',
            rawContent: 'raw secret',
            extraSensitiveField: 'do not expose'
          }];
        }
      };
    }
  });

  const drained = await bridge.call('drainOtEvents', {});
  const drainedEvents = JSON.parse(JSON.stringify(drained.events));

  assert.equal(drained.ok, true);
  assert.deepEqual(drainedEvents, [{
    path: 'main.tex',
    baseHash: 'base-hash',
    nextHash: 'next-hash',
    nextContent: 'alpha beta',
    observedAt: '2026-05-05T00:00:00.000Z',
    observedVersion: 'doc-version-2',
    source: 'fake-observer'
  }]);
});

test('page bridge remains available when OT observer factory throws', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    saveIndicatorText: 'All changes saved',
    files: {
      'main.tex': 'alpha'
    },
    realtimeObserverFactory() {
      throw new Error('observer factory failed');
    }
  });

  const probe = await bridge.call('probe', {});
  assert.equal(probe.ok, true, probe.error || JSON.stringify(probe));

  const saveState = await bridge.call('waitForSaveState', { deadlineMs: 1, pollIntervalMs: 1 });
  assert.equal(saveState.ok, true);
  assert.equal(saveState.state, 'verified_saved');

  const status = await bridge.call('getOtStatus', {});
  assert.equal(status.status, 'unavailable');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.running, false);
  assert.equal(status.lastErrorCode, 'ot_observer_create_failed');

  const stopped = await bridge.call('stopOtObserver', {});
  assert.equal(stopped.status, 'off');
  assert.equal(stopped.state, 'off');
  assert.equal(stopped.running, false);
});

// --- T4: structured FailureReason emit-site assertions ----------------------
//
// Each high-priority page-side emit site (§9 / §15.4) returns its legacy
// `code` + `reason` AND a structured `failure` record that passes
// validateFailureReason. These tests pin every emit site to its catalog
// stage/severity/file and the changedDocument contract from §7.

const failureReasonsModule = require('../extension/src/shared/failureReasons');

test('writebackRouter stale-guard emits structured failure for stale_source_changed (preflight/blocked, changedDocument:false)', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: { 'main.tex': 'user changed' }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [{ path: 'main.tex', content: 'base snapshot' }],
    operations: [{ type: 'edit', path: 'main.tex', find: 'user', replace: 'codex' }]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.equal(skip.result.code, 'stale_snapshot', 'legacy code preserved');
  assert.ok(skip.result.failure, 'structured failure attached');
  assert.equal(skip.result.failure.code, 'stale_source_changed');
  assert.equal(skip.result.failure.stage, 'preflight');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.file, 'main.tex');
  assert.equal(skip.result.failure.changedDocument, false);
  assert.equal(skip.result.failure.retryable, true);
  const validation = failureReasonsModule.validateFailureReason(skip.result.failure);
  assert.equal(validation.ok, true, JSON.stringify(validation));
});

test('writebackRouter patch-anchor mismatch emits structured failure for patch_anchor_not_found (preflight/blocked, changedDocument:false)', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: { 'main.tex': 'alpha user gamma' }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [{ path: 'main.tex', content: 'alpha user gamma' }],
    operations: [{
      type: 'edit',
      path: 'main.tex',
      patches: [{ from: 6, to: 10, expected: 'beta', insert: 'delta' }]
    }]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.equal(skip.result.code, 'stale_patch');
  assert.ok(skip.result.failure);
  assert.equal(skip.result.failure.code, 'patch_anchor_not_found');
  assert.equal(skip.result.failure.stage, 'preflight');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.file, 'main.tex');
  assert.equal(skip.result.failure.changedDocument, false);
  assert.equal(failureReasonsModule.validateFailureReason(skip.result.failure).ok, true);
});

test('writebackRouter readback mismatch emits structured failure for write_observed_mismatch (verify/error, changedDocument:true)', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    dispatchApplies: false,
    files: { 'main.tex': 'alpha beta gamma' }
  });

  const result = await bridge.call('applyOperations', {
    baseFiles: [{ path: 'main.tex', content: 'alpha beta gamma' }],
    operations: [{
      type: 'edit',
      path: 'main.tex',
      patches: [{ from: 6, to: 10, expected: 'beta', insert: 'delta' }]
    }]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.equal(skip.result.code, 'write_verification_failed');
  assert.ok(skip.result.failure);
  assert.equal(skip.result.failure.code, 'write_observed_mismatch');
  assert.equal(skip.result.failure.stage, 'verify');
  assert.equal(skip.result.failure.severity, 'error');
  assert.equal(skip.result.failure.file, 'main.tex');
  assert.equal(skip.result.failure.changedDocument, true, 'write landed; readback differs');
  assert.equal(failureReasonsModule.validateFailureReason(skip.result.failure).ok, true);
});

test('pageBridge jumpToPosition emits structured failure for target_file_not_found (navigation/blocked, changedDocument:false)', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    files: { 'main.tex': 'alpha beta gamma' }
  });

  const result = await bridge.call('jumpToPosition', {
    runProjectId: 'test-project',
    path: 'missing.tex'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'path_not_found');
  assert.ok(result.failure);
  assert.equal(result.failure.code, 'target_file_not_found');
  assert.equal(result.failure.stage, 'navigation');
  assert.equal(result.failure.severity, 'blocked');
  assert.equal(result.failure.file, 'missing.tex');
  assert.equal(result.failure.changedDocument, false);
  assert.equal(failureReasonsModule.validateFailureReason(result.failure).ok, true);
});

test('pageBridge ensureEditing emits structured failure for editing_not_confirmed (reviewing/blocked, changedDocument:false) when toggle attempted but state ambiguous', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    reviewingOk: true,
    reviewingClickActivates: false,
    reviewingButtonShowsCurrentMode: true,
    files: { 'main.tex': 'alpha' }
  });

  const result = await bridge.call('ensureEditing', {});

  assert.equal(result.ok, false);
  assert.equal(result.code, 'editing_not_confirmed');
  assert.ok(result.failure);
  assert.equal(result.failure.code, 'editing_not_confirmed');
  assert.equal(result.failure.stage, 'reviewing');
  assert.equal(result.failure.severity, 'blocked');
  assert.equal(result.failure.changedDocument, false);
  assert.equal(result.failure.retryable, true);
  assert.equal(failureReasonsModule.validateFailureReason(result.failure).ok, true);
});

test('pageBridge ensureReviewing emits structured failure for reviewing_state_unknown when no toggle control found', async () => {
  // Source-level pin: the ensureReviewing emit site maps the legacy
  // reviewing_not_enabled code to reviewing_state_unknown when no toggle
  // attempt was made (no control found), per §14 LEGACY_CODE_MAP. The
  // harness drives the toggle-attempted branch already (other tests assert
  // ensureReviewing.ok===true); this test verifies the source emits the
  // canonical code for both branches.
  const fs = require('node:fs');
  const pageBridgeText = fs.readFileSync(
    path.join(__dirname, '../extension/src/pageBridge.js'),
    'utf8'
  );
  assert.match(pageBridgeText, /reviewing_state_unknown/, 'ensureReviewing emits reviewing_state_unknown code');
  assert.match(pageBridgeText, /reviewing_enable_failed/, 'ensureReviewing emits reviewing_enable_failed code');
  // Both codes are wired through buildPageBridgeFailure (with the toggleAttempted branch).
  assert.match(pageBridgeText, /reviewingFailureCode\s*=\s*switched\.attempted\s*\?\s*'reviewing_enable_failed'\s*:\s*'reviewing_state_unknown'/);
});

// ---------------------------------------------------------------------------
// Welcome-panel + write-guard v1.3.8 add-on (Task 2): page-side writeback
// project-ID guard. Every applyOperations / acceptTrackedChanges /
// rejectTrackedChanges dispatch is gated by `runWriteGuard` which compares
// `params.runProjectId` against the page-side `editorProjectId`. The guard
// runs BEFORE any other readiness / openFile / staleness check — it is the
// first gate. The writebackRouter entries additionally check for a missing
// `runProjectId` as defense-in-depth in case a future caller bypasses the
// pageBridge wrapper.
// ---------------------------------------------------------------------------
test('page-bridge applyOperations aborts with aborted_project_changed when runProjectId mismatches editorProjectId', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: 'editorPID',
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    runProjectId: 'differentPID',
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.failure.code, 'aborted_project_changed');
  assert.equal(result.skipped[0].result.failure.stage, 'write');
  assert.equal(result.skipped[0].result.failure.severity, 'blocked');
  assert.equal(result.skipped[0].result.failure.terminalState, 'blocked');
  // Page-side editor was NOT mutated. The dispatch never ran.
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getDispatchCount(), 0);
});

test('page-bridge applyOperations aborts with editor_project_id_unavailable when editorProjectId is null', async () => {
  // editorProjectId omitted (no `_ide.project`) and no `[data-project-id]` →
  // the guard falls through to the URL fallback. Because the request's
  // runProjectId does not match the URL project id, the fallback is not
  // accepted and the guard fails closed before any dispatch.
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: null,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    runProjectId: 'somePID',
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.failure.code, 'editor_project_id_unavailable');
  assert.equal(result.skipped[0].result.failure.stage, 'write');
  assert.equal(result.skipped[0].result.failure.severity, 'blocked');
  assert.equal(result.skipped[0].result.failure.terminalState, 'blocked');
  assert.equal(bridge.getFile('main.tex'), 'alpha beta gamma');
  assert.equal(bridge.getDispatchCount(), 0);
});

test('page-bridge applyOperations uses same-project URL fallback when Overleaf editor project id is unavailable', async () => {
  // Current Overleaf builds can expose a stable /project/<id> URL while
  // window._ide.project._id remains unavailable. The guard may use the URL as
  // a fallback only when it exactly equals the immutable runProjectId.
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: null,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    runProjectId: 'test-project',
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(bridge.getFile('main.tex'), 'omega beta gamma');
  assert.equal(bridge.getDispatchCount(), 1);
});

test('page-bridge applyOperations waits out the Overleaf hydration window (editorProjectId arrives mid-retry)', async () => {
  // The retry budget is 100 + 300 + 700 = 1100 ms. A 250 ms hydration delay
  // resolves comfortably during the second retry, so the guard MUST succeed
  // and the write MUST land — not abort with editor_project_id_unavailable.
  // Regression for the v1.3.8 polish: pre-fix the guard fired immediately on
  // null, producing misleading 'Refresh Overleaf and retry' errors whenever
  // a user kicked off a run during Overleaf's hydration window.
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: 'hydratedPID',
    hydrationDelayMs: 250,
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('applyOperations', {
    runProjectId: 'hydratedPID',
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied.length, 1, 'write must land after hydration completes');
  assert.equal(result.skipped.length, 0);
  assert.equal(bridge.getFile('main.tex'), 'omega beta gamma');
});

test('applyOperationsCore re-checks editor project before each operation in a multi-op write', () => {
  // Source-grep regression: a multi-op applyOperations call can span 10-45s
  // (openFileByPath + save-state verification per op). If the user SPA-
  // navigates to a different project mid-flight, the remaining operations
  // would land in the wrong project. The fix re-checks runWriteGuard before
  // each op and short-circuits with aborted_project_changed for the rest of
  // the queue. The integration test path (mutating _ide.project._id between
  // op 1 and op 2) needs harness changes; this source-grep belts the
  // structural guarantee.
  const writebackRouterSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'page', 'writebackRouter.js'), 'utf8');
  // The core loop must read options.runProjectId.
  assert.match(writebackRouterSrc, /function applyOperationsCore[\s\S]*?options\.runProjectId/,
    'applyOperationsCore must read options.runProjectId');
  // It must consult CodexOverleafWriteGuard for the per-op re-check.
  assert.match(writebackRouterSrc, /function applyOperationsCore[\s\S]*?CodexOverleafWriteGuard\?\.create/,
    'applyOperationsCore must create a writeGuard surface for the per-op re-check');
  // And it must await writeGuard.runWriteGuard inside the for-of loop.
  assert.match(writebackRouterSrc, /function applyOperationsCore[\s\S]*?for \(const rawOperation of operations\)[\s\S]*?await writeGuardSurface\.runWriteGuard/,
    'applyOperationsCore must await writeGuard.runWriteGuard inside the per-op loop');
});

test('writeGuard module is async with hydration retry constants and the router awaits it', () => {
  // Source-grep belt-and-suspenders so removing the retry loop fails this
  // test even if a future change keeps the function async. The guard surface
  // lives in extension/src/page/writeGuard.js; pageBridge.js dispatches to it
  // via writeGuard.runWriteGuard.
  const writeGuardSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'page', 'writeGuard.js'), 'utf8');
  assert.match(writeGuardSrc, /async function runWriteGuard/, 'runWriteGuard must be async to await retry sleeps');
  assert.match(writeGuardSrc, /WRITE_GUARD_HYDRATION_RETRY_MS\s*=\s*\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\]/,
    'retry-ms constant must be defined as a 3-element array');
  // The router must await the guard call; without await the function returns
  // a Promise that is truthy, so the abort-branch tests would fail closed
  // every time.
  const pageBridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'pageBridge.js'), 'utf8');
  assert.match(pageBridgeSrc, /const blocked\s*=\s*await writeGuard\.runWriteGuard/,
    'router call sites must await writeGuard.runWriteGuard');
});

test('page-bridge ensureReviewing aborts with aborted_project_changed when runProjectId mismatches editorProjectId', async () => {
  // The pre-flight reviewing-mode toggle is gated by the same writeGuard the
  // writeback path uses. Without this gate, a mid-flight SPA navigation could
  // leave the toggle flipping Track Changes / Editing in the wrong project.
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: 'editorPID',
    files: { 'main.tex': 'alpha' }
  });

  const result = await bridge.call('ensureReviewing', {
    waitMs: 100,
    runProjectId: 'differentPID'
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.skipped[0].result.failure.code, 'aborted_project_changed');
  assert.equal(result.skipped[0].result.failure.stage, 'write');
});

test('page-bridge ensureEditing aborts with aborted_project_changed when runProjectId mismatches editorProjectId', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: 'editorPID',
    files: { 'main.tex': 'alpha' }
  });

  const result = await bridge.call('ensureEditing', {
    waitMs: 100,
    runProjectId: 'differentPID'
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.skipped[0].result.failure.code, 'aborted_project_changed');
});

test('page-bridge ensureReviewing passes through when no runProjectId is supplied (defensive)', async () => {
  // Defensive: legacy callers that did not thread runProjectId through must
  // continue to work. The guard only fires when params.runProjectId is set,
  // so an absent value lets the toggle proceed (matching the pre-fix behaviour
  // for backwards compatibility).
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: 'editorPID',
    files: { 'main.tex': 'alpha' }
  });

  const result = await bridge.call('ensureReviewing', { waitMs: 100 });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('page-bridge acceptTrackedChanges runs the same guard', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: 'editorPID',
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('acceptTrackedChanges', {
    runProjectId: 'differentPID',
    trackedChanges: [{ key: 'id:change-1', id: 'change-1', path: 'main.tex' }],
    expectedFiles: [{ path: 'main.tex', content: 'alpha beta gamma' }],
    postFiles: [{ path: 'main.tex', content: 'alpha delta gamma' }]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.failure.code, 'aborted_project_changed');
  assert.equal(result.skipped[0].result.failure.stage, 'write');
  assert.equal(bridge.getEditorUndoClickCount(), 0);
  assert.equal(bridge.getAcceptClickCount(), 0);
});

test('page-bridge rejectTrackedChanges runs the same guard', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: 'editorPID',
    files: {
      'main.tex': 'alpha beta gamma'
    }
  });

  const result = await bridge.call('rejectTrackedChanges', {
    runProjectId: 'differentPID',
    trackedChanges: [{ key: 'id:change-1', id: 'change-1', path: 'main.tex' }],
    expectedFiles: [{ path: 'main.tex', content: 'alpha beta gamma' }]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.failure.code, 'aborted_project_changed');
  assert.equal(result.skipped[0].result.failure.stage, 'write');
  assert.equal(bridge.getRejectClickCount(), 0);
  assert.equal(bridge.getEditorUndoClickCount(), 0);
});

test('writebackRouter.applyOperations rejects payload without runProjectId as editor_project_id_unavailable (defense-in-depth)', async () => {
  // Direct module call, bypassing pageBridge. Even with the page-bridge
  // wrapper absent (or a future caller that goes straight to the router),
  // a missing runProjectId on the params object must block the write.
  const writebackRouter = require('../extension/src/page/writebackRouter');
  const router = writebackRouter.create({
    window: { CodexOverleafProjectFiles: projectFiles, CodexOverleafStaleGuard: staleGuard },
    treeOperations: {
      getProjectId() { return 'editorPID'; }
    }
  });

  const result = await router.applyOperations({
    // runProjectId intentionally absent
    operations: [
      { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'omega' }
    ],
    baseFiles: [
      { path: 'main.tex', content: 'alpha beta' }
    ]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.failure.code, 'editor_project_id_unavailable');
  assert.equal(result.skipped[0].result.failure.stage, 'write');
  assert.equal(result.skipped[0].result.failure.severity, 'blocked');
});

function createPageBridgeHarness({
  activePath,
  files,
  reviewingOk = true,
  reviewingClickActivates = true,
  reviewingClickBehavior = 'activate',
  reviewingButtonShowsCurrentMode = false,
  exposeReviewingActiveState = true,
  includeLooseEditingButton = false,
  modeOptionRole = 'menuitem',
  modeOptionClassName = 'mode-option',
  internalReviewingState = undefined,
  saveIndicatorText = null,
  saveIndicatorAriaLabel = saveIndicatorText,
  saveIndicatorTitle = saveIndicatorAriaLabel,
  saveIndicatorNodes = null,
  dispatchApplies = true,
  trackChangesOnDispatch = false,
  trackedChangeRenderDelayMs = 0,
  realtimeObserverFactory = null,
  rerenderTrackedChangeIdsOnReject = false,
  editorUndoTargets = {},
  initialEditorPath = activePath,
  initialEditorCatchUpDelayMs = null,
  editorSwitchDelayMs = 0,
  basenameOnlyTreeLabels = false,
  exposeInternalDocTree = false,
  // Welcome-panel + write-guard v1.3.8 add-on (Task 2): the page-side
  // `getEditorProjectIdPageSide()` reader looks first at `window._ide.project._id`.
  // The harness defaults to a stable id that matches `bridge.call`'s auto-
  // injected `runProjectId` so legacy tests pass the guard without changes.
  // Tests can override with another string (to assert the project-changed
  // branch) or with explicit `null` (to assert the unavailable branch).
  editorProjectId = 'test-project',
  // Write-guard hydration tolerance (v1.3.8 polish): set a positive number
  // to delay assigning `_ide.project` until this many ms have elapsed —
  // simulates Overleaf's hydration window where the editor module is loaded
  // but `_ide.project._id` is briefly null. The runWriteGuard retry loop
  // (100/300/700 ms) must ride out delays under ~1100 ms.
  hydrationDelayMs = 0
}) {
  const fileMap = new Map(Object.entries(files));
  const trackedChanges = [];
  let nextTrackedChangeId = 1;
  let selectedPath = activePath;
  let editorPath = initialEditorPath;
  let listener = null;
  let pendingResult = null;
  let lastDispatchChanges = null;
  let lastSelection = null;
  let lastScrollIntoView = null;
  let dispatchCount = 0;
  let reviewingActive = reviewingOk;
  let reviewingClickCount = 0;
  let rejectClickCount = 0;
  let acceptClickCount = 0;
  let editorUndoClickCount = 0;
  const bridgeCapability = 'test-page-bridge-capability';
  let capabilityInitialized = false;
  const rejectedChangeIds = [];
  const acceptedChangeIds = [];
  let modeMenuOpen = false;
  let modeOptionClickCount = 0;
  const documentEventListeners = [];

  if (initialEditorPath !== activePath && Number.isFinite(Number(initialEditorCatchUpDelayMs))) {
    setTimeout(() => {
      editorPath = selectedPath;
    }, Math.max(0, Number(initialEditorCatchUpDelayMs)));
  }

  const document = {
    addEventListener(type, handler, optionsArg) {
      documentEventListeners.push({ type, handler, options: optionsArg });
    },
    removeEventListener(type, handler) {
      const index = documentEventListeners.findIndex(listenerItem =>
        listenerItem.type === type && listenerItem.handler === handler
      );
      if (index > -1) {
        documentEventListeners.splice(index, 1);
      }
    },
    body: {
      get innerText() {
        return reviewingActive ? 'Reviewing' : 'Editing';
      },
      get textContent() {
        return reviewingActive ? 'Reviewing' : 'Editing';
      }
    },
    querySelector(selector) {
      if (/\[aria-selected="true"\]|\.selected/.test(selector)) {
        return makeTreeNode(selectedPath);
      }
      return null;
    },
    querySelectorAll(selector) {
      if (/save|saving-status|save-status/i.test(selector)) {
        if (saveIndicatorNodes) {
          return saveIndicatorNodes.map(makeSaveIndicatorNode);
        }
        return saveIndicatorText == null
          ? []
          : [makeSaveIndicatorNode({
            text: saveIndicatorText,
            ariaLabel: saveIndicatorAriaLabel,
            title: saveIndicatorTitle
          })];
      }
      if (/treeitem|role="row"|file-tree|project-tree|data-entity-id|data-doc-id|data-id|data-file-id/.test(selector)) {
        return Array.from(fileMap.keys(), makeTreeNode);
      }
      if (/aria-label|title|review|track|button|\*/i.test(selector)) {
        return [
          makeEditorUndoButton(),
          makeReviewingButton(),
          ...trackedChanges.filter(change => change.path === selectedPath).map(makeTrackedChangeNode),
          ...(includeLooseEditingButton ? [makeLooseEditingButton()] : []),
          ...(modeMenuOpen ? [makeModeOption('Editing'), makeModeOption('Reviewing')] : [])
        ];
      }
      return [];
    },
    execCommand() {
      return false;
    }
  };

  const window = {
    location: {
      href: 'https://www.overleaf.com/project/test-project',
      origin: 'https://www.overleaf.com',
      pathname: '/project/test-project'
    },
    CodexOverleafProjectFiles: projectFiles,
    CodexOverleafReviewing: reviewing,
    CodexOverleafStaleGuard: staleGuard,
    _ide: {
      editorView: createEditorView(),
      fileTreeManager: createFileTreeManager(),
      ...(exposeInternalDocTree ? { rootFolder: buildInternalDocTree(Array.from(fileMap.keys())) } : {}),
      ...(internalReviewingState === undefined ? {} : { reviewing: internalReviewingState }),
      // `editorProjectId === undefined` → omit `project` so legacy tests are
      // unaffected. `editorProjectId === null` → omit it too (the guard then
      // falls through to the data-project-id attribute, which the stub doc
      // also does not have, and lands on null → unavailable). A string sets a
      // stable id the guard can match against `params.runProjectId`.
      // `hydrationDelayMs > 0` defers the project assignment so the runWriteGuard
      // retry loop can be exercised — initial reads return null, then
      // `_ide.project` materializes mid-retry.
      ...(typeof editorProjectId === 'string' && editorProjectId && hydrationDelayMs <= 0
        ? { project: { _id: editorProjectId } }
        : {})
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
    console,
    globalThis: window
  });

  vm.runInContext(otTextSource, context, { filename: 'otText.js' });
  vm.runInContext(overleafCapabilitiesSource, context, { filename: 'overleafCapabilities.js' });
  vm.runInContext(saveStateSource, context, { filename: 'saveState.js' });
  vm.runInContext(compileBridgeSource, context, { filename: 'compileBridge.js' });
  vm.runInContext(overleafEditorSource, context, { filename: 'overleafEditor.js' });
  vm.runInContext(overleafProjectSnapshotSource, context, { filename: 'overleafProjectSnapshot.js' });
  vm.runInContext(treeOperationsSource, context, { filename: 'treeOperations.js' });
  vm.runInContext(snapshotRouterSource, context, { filename: 'snapshotRouter.js' });
  vm.runInContext(writeGuardSource, context, { filename: 'writeGuard.js' });
  vm.runInContext(trackedChangesLifecycleSource, context, { filename: 'trackedChangesLifecycle.js' });
  vm.runInContext(writebackRouterSource, context, { filename: 'writebackRouter.js' });
  if (realtimeObserverFactory) {
    window.CodexOverleafRealtimeObserver = { create: realtimeObserverFactory };
  } else {
    vm.runInContext(overleafRealtimeObserverSource, context, { filename: 'overleafRealtimeObserver.js' });
  }
  if (pageBridgeCapabilitySource) {
    vm.runInContext(pageBridgeCapabilitySource, context, { filename: 'pageBridgeCapability.js' });
  }
  vm.runInContext(pageRpcContractSource, context, { filename: 'pageRpcContract.js' });
  vm.runInContext(pageBridgeSource, context, { filename: 'pageBridge.js' });

  // Hydration simulation: defer the `_ide.project` assignment so the first
  // few writeGuard reads see null. After `hydrationDelayMs` ms the project
  // materializes with the configured id, exercising the runWriteGuard retry
  // loop (100/300/700 ms backoff).
  if (hydrationDelayMs > 0 && typeof editorProjectId === 'string' && editorProjectId) {
    setTimeout(() => {
      window._ide.project = { _id: editorProjectId };
    }, hydrationDelayMs);
  }

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
      // Welcome-panel + write-guard v1.3.8 add-on (Task 2): every guarded
      // method now requires `runProjectId`. Production callsites in
      // contentRuntime always set it; the harness mirrors that by auto-
      // injecting the configured `editorProjectId` when the test omits it.
      // Tests that explicitly drive the guard pass their own runProjectId.
      const guardedMethods = new Set(['applyOperations', 'acceptTrackedChanges', 'rejectTrackedChanges']);
      let nextParams = params;
      if (guardedMethods.has(method)
        && params
        && typeof params === 'object'
        && typeof params.runProjectId !== 'string') {
        nextParams = {
          ...params,
          runProjectId: typeof editorProjectId === 'string' && editorProjectId
            ? editorProjectId
            : 'test-project'
        };
      }
      return sendPageBridgeRequest(method, nextParams, {
        capability: bridgeCapability
      });
    },
    async spoofCall(method, params, options = {}) {
      return sendPageBridgeRequest(method, params, {
        capability: options.capability,
        includeCapability: options.includeCapability === true
      });
    },
    fireDocumentEvent(type, event = { target: {} }) {
      const listenerItems = documentEventListeners.filter(item => item.type === type);
      assert.ok(listenerItems.length, `${type} document listener should be registered`);
      for (const listenerItem of listenerItems) {
        listenerItem.handler(event);
      }
    },
    getFile(filePath) {
      return fileMap.get(filePath);
    },
    setFile(filePath, content) {
      fileMap.set(filePath, content);
    },
    getLastDispatchChanges() {
      return lastDispatchChanges == null ? null : JSON.parse(JSON.stringify(lastDispatchChanges));
    },
    getLastSelection() {
      return lastSelection == null ? null : JSON.parse(JSON.stringify(lastSelection));
    },
    getLastScrollIntoView() {
      return lastScrollIntoView;
    },
    getDispatchCount() {
      return dispatchCount;
    },
    getEditorPath() {
      return editorPath;
    },
    getReviewingClickCount() {
      return reviewingClickCount;
    },
    getModeOptionClickCount() {
      return modeOptionClickCount;
    },
    getRejectClickCount() {
      return rejectClickCount;
    },
    getAcceptClickCount() {
      return acceptClickCount;
    },
    getEditorUndoClickCount() {
      return editorUndoClickCount;
    },
    getRejectedChangeIds() {
      return rejectedChangeIds.slice();
    },
    getAcceptedChangeIds() {
      return acceptedChangeIds.slice();
    },
    getTrackedChangeCount() {
      return trackedChanges.length;
    },
    isReviewingActive() {
      return reviewingActive;
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
    if (options.includeCapability !== false && typeof options.capability === 'string') {
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
    const stateByPath = new Map();
    function getState(filePath) {
      if (!stateByPath.has(filePath)) {
        const doc = {
          toString() {
            return fileMap.get(filePath) || '';
          },
          get length() {
            return (fileMap.get(filePath) || '').length;
          }
        };
        stateByPath.set(filePath, { doc });
      }
      return stateByPath.get(filePath);
    }
    return {
      get state() {
        return getState(editorPath);
      },
      focus() {},
      dispatch(transaction) {
        dispatchCount += 1;
        lastDispatchChanges = transaction.changes;
        lastScrollIntoView = Object.prototype.hasOwnProperty.call(transaction, 'scrollIntoView')
          ? transaction.scrollIntoView
          : null;
        if (transaction.selection) {
          lastSelection = transaction.selection;
        }
        if (dispatchApplies) {
          if (!transaction.changes) {
            return;
          }
          const before = fileMap.get(editorPath) || '';
          fileMap.set(editorPath, applyEditorChanges(fileMap.get(editorPath) || '', transaction.changes));
          if (reviewingActive && trackChangesOnDispatch) {
            const trackedChange = {
              id: `change-${nextTrackedChangeId++}`,
              path: editorPath,
              before,
              after: fileMap.get(editorPath) || ''
            };
            if (trackedChangeRenderDelayMs > 0) {
              setTimeout(() => trackedChanges.push(trackedChange), trackedChangeRenderDelayMs);
            } else {
              trackedChanges.push(trackedChange);
            }
          }
        }
      }
    };
  }

  function applyEditorChanges(text, changes) {
    if (!changes) {
      return text;
    }
    if (!Array.isArray(changes)) {
      return text.slice(0, changes.from) + changes.insert + text.slice(changes.to);
    }
    return changes.slice().sort((a, b) => b.from - a.from).reduce((next, change) => {
      return next.slice(0, change.from) + change.insert + next.slice(change.to);
    }, text);
  }

  function createFileTreeManager() {
    return {
      createDoc(filePath, content) {
        fileMap.set(filePath, content);
      },
      renameEntity(filePath, to) {
        const content = fileMap.get(filePath);
        fileMap.delete(filePath);
        fileMap.set(to, content || '');
        if (selectedPath === filePath) {
          selectedPath = to;
        }
        if (editorPath === filePath) {
          editorPath = to;
        }
      },
      moveEntity(filePath, to) {
        this.renameEntity(filePath, to);
      },
      deleteEntity(filePath) {
        fileMap.delete(filePath);
      }
    };
  }

  function makeReviewingButton() {
    const label = reviewingButtonShowsCurrentMode
      ? (reviewingActive ? 'Reviewing' : 'Editing')
      : 'Reviewing';
    return {
      tagName: 'BUTTON',
      textContent: label,
      innerText: label,
      id: reviewingButtonShowsCurrentMode ? 'editor-mode-dropdown' : 'reviewing-mode',
      className: reviewingButtonShowsCurrentMode ? 'editor-mode-dropdown' : 'toolbar-reviewing-button',
      disabled: false,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'aria-label' || attribute === 'title') {
          return label;
        }
        if (attribute === 'aria-disabled') {
          return 'false';
        }
        if (attribute === 'aria-pressed' || attribute === 'aria-selected' || attribute === 'aria-current') {
          if (!exposeReviewingActiveState) {
            return '';
          }
          return reviewingActive ? 'true' : 'false';
        }
        return '';
      },
      click() {
        reviewingClickCount += 1;
        if (reviewingClickBehavior === 'toggle') {
          reviewingActive = !reviewingActive;
        } else if (reviewingClickBehavior === 'noop') {
          return;
        } else if (reviewingClickBehavior === 'menu') {
          modeMenuOpen = true;
        } else if (reviewingClickActivates) {
          reviewingActive = true;
        }
      },
      dispatchEvent() {
        this.click();
        return true;
      }
    };
  }

  function makeEditorUndoButton() {
    return {
      tagName: 'BUTTON',
      textContent: 'Undo',
      innerText: 'Undo',
      id: 'editor-undo',
      className: 'toolbar-undo-button',
      disabled: false,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'aria-label' || attribute === 'title') {
          return 'Undo';
        }
        if (attribute === 'aria-disabled') {
          return 'false';
        }
        return '';
      },
      click() {
        editorUndoClickCount += 1;
        if (Object.prototype.hasOwnProperty.call(editorUndoTargets, selectedPath)) {
          fileMap.set(selectedPath, editorUndoTargets[selectedPath]);
          trackedChanges.splice(0, trackedChanges.length);
        }
      },
      dispatchEvent() {
        this.click();
        return true;
      }
    };
  }

  function makeModeOption(label) {
    return {
      tagName: 'BUTTON',
      textContent: label,
      innerText: label,
      id: `${label.toLowerCase()}-mode-option`,
      className: modeOptionClassName,
      disabled: false,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'aria-label' || attribute === 'title') {
          return label;
        }
        if (attribute === 'role') {
          return modeOptionRole;
        }
        if (attribute === 'aria-disabled') {
          return 'false';
        }
        if (attribute === 'aria-pressed' || attribute === 'aria-selected' || attribute === 'aria-current') {
          return (label === 'Reviewing' && reviewingActive) || (label === 'Editing' && !reviewingActive)
            ? 'true'
            : 'false';
        }
        return '';
      },
      click() {
        modeOptionClickCount += 1;
        reviewingActive = label === 'Reviewing';
        modeMenuOpen = false;
      },
      dispatchEvent() {
        this.click();
        return true;
      }
    };
  }

  function makeLooseEditingButton() {
    return {
      tagName: 'BUTTON',
      textContent: 'Editing',
      innerText: 'Editing',
      id: 'format-editing-control',
      className: 'toolbar-button',
      disabled: false,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'aria-label' || attribute === 'title') {
          return 'Editing';
        }
        if (attribute === 'aria-disabled') {
          return 'false';
        }
        return '';
      },
      click() {
        return undefined;
      },
      dispatchEvent() {
        this.click();
        return true;
      }
    };
  }

  function makeSaveIndicatorNode(options) {
    const {
      text,
      ariaLabel = text,
      title = ariaLabel,
      hidden = false,
      ariaHidden = false,
      inert = false,
      display = '',
      visibility = ''
    } = typeof options === 'string' ? { text: options } : options;
    return {
      tagName: 'DIV',
      textContent: text,
      innerText: text,
      id: 'save-status',
      className: 'save-status',
      hidden,
      inert,
      style: { display, visibility },
      disabled: false,
      parentElement: null,
      hasAttribute(attribute) {
        if (attribute === 'hidden') {
          return hidden;
        }
        if (attribute === 'inert') {
          return inert;
        }
        return false;
      },
      getAttribute(attribute) {
        if (attribute === 'aria-label') {
          return ariaLabel;
        }
        if (attribute === 'title') {
          return title;
        }
        if (attribute === 'aria-hidden') {
          return ariaHidden ? 'true' : '';
        }
        if (attribute === 'hidden') {
          return hidden ? '' : null;
        }
        if (attribute === 'inert') {
          return inert ? '' : null;
        }
        if (attribute === 'data-testid') {
          return 'save-status';
        }
        return '';
      }
    };
  }

  function makeTrackedChangeNode(change) {
    return {
      tagName: 'DIV',
      textContent: `Tracked change ${change.id}`,
      innerText: `Tracked change ${change.id}`,
      id: `tracked-${change.id}`,
      className: 'review-change-row track-change',
      disabled: false,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'data-change-id' || attribute === 'data-review-id') {
          return change.id;
        }
        if (attribute === 'data-path') {
          return change.path;
        }
        if (attribute === 'aria-label' || attribute === 'title') {
          return `Tracked change ${change.id}`;
        }
        return '';
      },
      querySelectorAll(selector) {
        if (/button|role|aria-label|title|\*/i.test(selector)) {
          return [
            makeAcceptTrackedChangeButton(change),
            makeRejectTrackedChangeButton(change)
          ];
        }
        return [];
      },
      closest() {
        return null;
      }
    };
  }

  function makeAcceptTrackedChangeButton(change) {
    return {
      tagName: 'BUTTON',
      textContent: 'Accept',
      innerText: 'Accept',
      id: `accept-${change.id}`,
      className: 'review-accept-change',
      disabled: false,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'aria-label' || attribute === 'title') {
          return `Accept change ${change.id}`;
        }
        if (attribute === 'role') {
          return 'button';
        }
        if (attribute === 'aria-disabled') {
          return 'false';
        }
        return '';
      },
      click() {
        acceptClickCount += 1;
        acceptedChangeIds.push(change.id);
        fileMap.set(change.path, change.after);
        const index = trackedChanges.indexOf(change);
        if (index >= 0) {
          trackedChanges.splice(index, 1);
        }
      },
      dispatchEvent() {
        this.click();
        return true;
      }
    };
  }

  function makeRejectTrackedChangeButton(change) {
    return {
      tagName: 'BUTTON',
      textContent: 'Reject',
      innerText: 'Reject',
      id: `reject-${change.id}`,
      className: 'review-reject-change',
      disabled: false,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'aria-label' || attribute === 'title') {
          return `Reject change ${change.id}`;
        }
        if (attribute === 'role') {
          return 'button';
        }
        if (attribute === 'aria-disabled') {
          return 'false';
        }
        return '';
      },
      click() {
        rejectClickCount += 1;
        rejectedChangeIds.push(change.id);
        fileMap.set(change.path, change.before);
        const index = trackedChanges.indexOf(change);
        if (index >= 0) {
          trackedChanges.splice(index, 1);
        }
        if (rerenderTrackedChangeIdsOnReject) {
          trackedChanges.forEach((trackedChange, index) => {
            trackedChange.id = `rerendered-${rejectClickCount}-${index + 1}`;
          });
        }
      },
      dispatchEvent() {
        this.click();
        return true;
      }
    };
  }

  function makeTreeNode(filePath) {
    const label = basenameOnlyTreeLabels
      ? String(filePath || '').split('/').filter(Boolean).pop() || filePath
      : filePath;
    const docId = makeStableDocId(filePath);
    return {
      textContent: label,
      parentElement: null,
      getAttribute(attribute) {
        if (attribute === 'data-path' || attribute === 'aria-label' || attribute === 'title') {
          return label;
        }
        if (attribute === 'data-entity-id' || attribute === 'data-doc-id' || attribute === 'data-id') {
          return docId;
        }
        return '';
      },
      dispatchEvent() {
        selectedPath = filePath;
        if (editorSwitchDelayMs > 0) {
          setTimeout(() => {
            editorPath = filePath;
          }, editorSwitchDelayMs);
        } else {
          editorPath = filePath;
        }
        return true;
      }
    };
  }

  function buildInternalDocTree(paths) {
    const root = { name: '', folders: [], docs: [] };
    const folders = new Map([['', root]]);
    for (const filePath of paths) {
      const parts = String(filePath || '').split('/').filter(Boolean);
      const fileName = parts.pop();
      if (!fileName) {
        continue;
      }
      let folderPath = '';
      let parent = root;
      for (const folderName of parts) {
        folderPath = folderPath ? `${folderPath}/${folderName}` : folderName;
        if (!folders.has(folderPath)) {
          const folder = { name: folderName, folders: [], docs: [] };
          folders.set(folderPath, folder);
          parent.folders.push(folder);
        }
        parent = folders.get(folderPath);
      }
      parent.docs.push({
        name: fileName,
        _id: makeStableDocId(filePath)
      });
    }
    return root;
  }

  function makeStableDocId(filePath) {
    let hash = 0;
    for (const char of String(filePath || '')) {
      hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    }
    return hash.toString(16).padStart(24, '0').slice(0, 24);
  }
}


test('cancelActiveWrite emits a sequence number that bumps each call', async () => {
  const bridge = createPageBridgeHarness({
    activePath: 'main.tex',
    editorProjectId: 'seq-pid',
    files: { 'main.tex': 'x' }
  });
  const first = await bridge.call('cancelActiveWrite', {});
  const second = await bridge.call('cancelActiveWrite', {});
  assert.equal(first.ok, true);
  assert.equal(first.cancelled, true);
  assert.ok(Number.isInteger(first.sequence) && first.sequence > 0);
  assert.equal(second.sequence, first.sequence + 1, 'sequence must monotonically increment');
});

test('writebackRouter applyOperationsCore captures the cancel sequence baseline and re-checks it between ops', () => {
  // Source-grep regression for the cross-world cancel. The full integration
  // (setTimeout-driven cancelActiveWrite during a real apply loop) is timing-
  // sensitive and brittle in the VM harness; the structural invariants below
  // are sufficient to catch removal/regression of the cancel path.
  const writebackRouterSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'page', 'writebackRouter.js'), 'utf8');
  // Router must accept the cancel-sequence reader as a dep.
  assert.match(writebackRouterSrc, /readWriteCancellationSequence/,
    'writebackRouter.create must accept readWriteCancellationSequence dep');
  // applyOperationsCore must capture the baseline at start and re-check
  // inside the per-op loop with a strict-inequality test.
  assert.match(writebackRouterSrc, /function applyOperationsCore[\s\S]*?cancelBaselineSequence\s*=\s*readWriteCancellationSequence\(\)/,
    'applyOperationsCore must capture cancelBaselineSequence at the start');
  assert.match(writebackRouterSrc, /function applyOperationsCore[\s\S]*?for \(const rawOperation of operations\)[\s\S]*?readWriteCancellationSequence\(\)\s*!==\s*cancelBaselineSequence/,
    'applyOperationsCore must re-check the cancel sequence inside the per-op loop');
  // The skip result must carry the codex_cancelled code and a write-stage
  // terminalState so the run-card / completion-report attribute correctly.
  assert.match(writebackRouterSrc, /code:\s*'codex_cancelled'[\s\S]*?stage:\s*'write'[\s\S]*?terminalState:\s*'cancelled'/,
    'cancellation skip must carry codex_cancelled + stage:write + terminalState:cancelled');
});

test('pageBridge exposes cancelActiveWrite as a dispatch method backed by a sequence counter', () => {
  const pageBridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'pageBridge.js'), 'utf8');
  const contract = require('../extension/src/shared/pageRpcContract.js');
  assert.equal(contract.getMethod('cancelActiveWrite').capability, 'write.cancel',
    'page RPC contract must expose cancelActiveWrite');
  assert.match(pageBridgeSrc, /cancelActiveWrite\(\)/,
    'pageBridge handler map must implement cancelActiveWrite');
  assert.match(pageBridgeSrc, /writeCancellationSequence\s*\+=\s*1/,
    'cancelActiveWrite must increment the sequence counter');
  assert.match(pageBridgeSrc, /readWriteCancellationSequence/,
    'pageBridge must pass the sequence reader to the writebackRouter');
});

test('content-side cancelActiveRun fires both codex.cancel (native) and cancelActiveWrite (page)', () => {
  const contentScriptSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'content', 'contentRuntime.js'), 'utf8');
  // Bound the grep to the cancelActiveRun function so neighbouring code
  // cannot accidentally satisfy the assertions.
  const fnIdx = contentScriptSrc.indexOf('async function cancelActiveRun(');
  assert.notEqual(fnIdx, -1, 'cancelActiveRun must exist');
  const body = contentScriptSrc.slice(fnIdx, fnIdx + 2500);
  assert.match(body, /method:\s*'codex\.cancel'/,
    'native cancel must still fire');
  assert.match(body, /callPageBridge\(\s*'cancelActiveWrite'/,
    'page-side cancelActiveWrite must also fire so writeback aborts mid-flight');
  // The page-side cancel is best-effort — must catch so a missing page
  // bridge does not break the native cancel completion.
  assert.match(body, /callPageBridge\(\s*'cancelActiveWrite'[\s\S]{0,80}\.catch/,
    'cancelActiveWrite call must be best-effort (.catch swallow)');
});

// ---------------------------------------------------------------------------
// Regression guards for the v1.3.10 BLOCKER fixes (review findings B2/B3/B7).
// These are source-grep belts: the behaviors are hard to exercise in the VM
// harness, but the structural invariants must not silently regress.
// ---------------------------------------------------------------------------

test('cancel-during-in-flight-write reports changedDocument:true (B2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'page', 'writebackRouter.js'), 'utf8');
  // The op that was mid-write when cancel landed must be reported with
  // changedDocument:true + warning severity (the editor may already hold part
  // of the write), distinct from the not-yet-started tail ops.
  assert.match(src, /cancelledInFlightResult\s*=\s*\{[\s\S]*?changedDocument:\s*true/,
    'in-flight cancel result must set changedDocument:true');
  assert.match(src, /cancelledInFlightResult[\s\S]*?severity:\s*'warning'/,
    'in-flight cancel must be a warning, not silent info');
  // The race-winner branch must push the in-flight result for the current op.
  assert.match(src, /CANCELLED_RACE_SENTINEL[\s\S]*?result:\s*cancelledInFlightResult/,
    'the op interrupted mid-write must use cancelledInFlightResult');
});

test('file-tree op stops after a method was invoked rather than stacking a second partial change (B3)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'page', 'writebackRouter.js'), 'utf8');
  // After a method has been invoked, a throw must NOT fall through to the next
  // method (which could stack a second partial mutation); it must return a
  // file_tree_operation_unverified failure.
  assert.match(src, /let mutationAttempted = false/, 'must track whether a method was invoked');
  assert.match(src, /if \(mutationAttempted\)[\s\S]*?file_tree_operation_unverified/,
    'a post-invocation throw must return file_tree_operation_unverified, not try the next method');
});

test('compileBridge fetch wrapper is install-once via a page-window sentinel (B7)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'page', 'compileBridge.js'), 'utf8');
  // On extension upgrade the page bridge re-injects; the fetch wrapper must
  // not stack. State lives on a page-window key and the interceptor bails if
  // the current fetch is already our wrapper.
  assert.match(src, /GLOBAL_STATE_KEY\s*=\s*'__codexOverleafCompileBridgeState'/,
    'compile-bridge state must persist on a page-window sentinel across re-injection');
  assert.match(src, /if \(state\.wrappedFetch && pageWindow\.fetch === state\.wrappedFetch\)\s*\{[\s\S]*?return/,
    'interceptCompileRequests must bail when our wrapper is already installed');
});
