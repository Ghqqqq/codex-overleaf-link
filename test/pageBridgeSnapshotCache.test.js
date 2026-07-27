const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectFiles = require('../extension/src/shared/projectFiles');
const staleGuard = require('../extension/src/shared/staleGuard');
const projectSnapshotFactory = require('../extension/src/page/overleafProjectSnapshot');

const pageBridgeSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/pageBridge.js'),
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
const pageBridgeCapabilityPath = path.join(__dirname, '../extension/src/page/pageBridgeCapability.js');
const pageBridgeCapabilitySource = fs.existsSync(pageBridgeCapabilityPath)
  ? fs.readFileSync(pageBridgeCapabilityPath, 'utf8')
  : '';
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

test('context file list uses the exact Overleaf ZIP file tree and caches it', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro',
      'refs/library.bib': '@article{x}',
      'figures/plot.pdf': '%PDF-test'
    },
    treePaths: [
      ['main.tex'],
      ['ghost.tex']
    ]
  });

  const first = await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 300000
  });
  const second = await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 300000
  });

  assert.equal(first.ok, true);
  assert.equal(first.capabilities.method, 'overleaf-zip-file-list');
  assert.equal(second.capabilities.diagnostics.fileListCache, 'memory');
  assert.deepEqual(Array.from(first.files, file => file.path), [
    'main.tex',
    'sections/intro.tex',
    'refs/library.bib',
    'figures/plot.pdf'
  ]);
  assert.deepEqual(Array.from(second.files, file => file.path), [
    'main.tex',
    'sections/intro.tex',
    'refs/library.bib',
    'figures/plot.pdf'
  ]);
  assert.deepEqual(Array.from(first.files, file => file.selectable), [true, true, true, false]);
  assert.deepEqual(Array.from(first.files, file => file.kind), ['text', 'text', 'text', 'binary']);
  assert.equal(bridge.getFetchCount(), 1);
});

test('fast tree reads do not evict the cached exact ZIP file list', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro',
      'figures/plot.pdf': '%PDF-test'
    },
    treePaths: [
      ['main.tex']
    ]
  });

  const exact = await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 300000
  });
  const tree = await bridge.call('getProjectFileList', {
    preferExact: false,
    maxAgeMs: 300000
  });
  const exactAgain = await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 300000
  });

  assert.equal(exact.capabilities.method, 'overleaf-zip-file-list');
  assert.equal(tree.capabilities.method, 'overleaf-file-tree');
  assert.equal(exactAgain.capabilities.method, 'overleaf-zip-file-list');
  assert.equal(exactAgain.capabilities.diagnostics.fileListCache, 'memory');
  assert.equal(bridge.getFetchCount(), 1);
});

test('snapshot invalidation preserves file lists unless project structure changed', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro'
    }
  });

  await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 300000
  });
  await bridge.call('invalidateProjectSnapshot', {});
  const afterContentEdit = await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 300000
  });
  await bridge.call('invalidateProjectSnapshot', { invalidateFileList: true });
  const afterStructureChange = await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 300000
  });

  assert.equal(afterContentEdit.capabilities.diagnostics.fileListCache, 'memory');
  assert.equal(afterStructureChange.capabilities.diagnostics.fileListCache, 'fresh');
  assert.equal(bridge.getFetchCount(), 2);
});

test('ZIP diagnostics separate download and extraction timing', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}'
    }
  });

  const result = await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 0
  });
  const timing = result.capabilities.diagnostics.zipTiming;

  assert.equal(result.ok, true);
  assert.equal(timing.timeoutBudgetMs, 30000);
  assert.equal(timing.attempts.length, 1);
  assert.match(timing.attempts[0].endpoint, /\/project\/[^/]+\/download\/zip$/);
  assert.ok(timing.attempts[0].downloadMs >= 0);
  assert.ok(timing.attempts[0].extractMs >= 0);
});

test('context file list carries ZIP byte sizes without file contents', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'alpha beta\n',
      'Figures/plot.pdf': '%PDF-test'
    }
  });

  const result = await bridge.call('getProjectFileList', {
    preferExact: true,
    maxAgeMs: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.method, 'overleaf-zip-file-list');
  assert.deepEqual(Array.from(result.files, file => [file.path, file.size]), [
    ['main.tex', Buffer.byteLength('alpha beta\n')],
    ['Figures/plot.pdf', Buffer.byteLength('%PDF-test')]
  ]);
  assert.equal(result.files.some(file => Object.prototype.hasOwnProperty.call(file, 'content')), false);
  assert.equal(result.files.some(file => Object.prototype.hasOwnProperty.call(file, 'contentBase64')), false);
});

test('context file list falls back to strict project tree when ZIP is unavailable', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro'
    },
    treePaths: [
      ['main.tex'],
      ['sections', 'intro.tex']
    ],
    fetchMode: 'hang'
  });

  const result = await bridge.call('getProjectFileList', {
    preferExact: true,
    zipTimeoutMs: 5,
    maxAgeMs: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.method, 'overleaf-file-tree');
  assert.deepEqual(Array.from(result.files, file => file.path), [
    'main.tex',
    'sections/intro.tex'
  ]);
});

test('ZIP endpoint fallbacks share one total timeout budget', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}'
    },
    fetchMode: 'hang'
  });

  const result = await bridge.call('getProjectFileList', {
    preferExact: true,
    exactOnly: true,
    zipTimeoutMs: 5,
    maxAgeMs: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.capabilities.method, 'overleaf-zip-file-list-unavailable');
  assert.equal(bridge.getFetchCount(), 1);
  assert.equal(result.capabilities.diagnostics.zipTiming.timeoutBudgetMs, 5);
  assert.equal(result.capabilities.diagnostics.zipTiming.attempts.length, 1);
  assert.match(result.reason, /timed out|timeout budget/i);
});

test('context file list does not cache ZIP fallback as the exact project tree', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro',
      'ref.bib': '@article{x}'
    },
    treePaths: [
      ['main.tex']
    ],
    fetchMode: 'hang'
  });

  const fallback = await bridge.call('getProjectFileList', {
    preferExact: true,
    zipTimeoutMs: 5,
    maxAgeMs: 300000
  });
  bridge.setFetchMode('zip');
  const exact = await bridge.call('getProjectFileList', {
    preferExact: true,
    zipTimeoutMs: 5,
    maxAgeMs: 300000
  });

  assert.equal(fallback.capabilities.method, 'overleaf-file-tree');
  assert.deepEqual(Array.from(fallback.files, file => file.path), ['main.tex']);
  assert.equal(exact.capabilities.method, 'overleaf-zip-file-list');
  assert.deepEqual(Array.from(exact.files, file => file.path), [
    'main.tex',
    'sections/intro.tex',
    'ref.bib'
  ]);
});

test('context file list reconstructs nested folder paths from the Overleaf file tree', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro',
      'refs/library.bib': '@article{x}'
    },
    treePaths: [
      ['main.tex'],
      ['sections', 'intro.tex'],
      ['refs', 'library.bib']
    ]
  });

  const result = await bridge.call('getProjectFileList', { preferExact: false });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.files, file => file.path), [
    'main.tex',
    'sections/intro.tex',
    'refs/library.bib'
  ]);
  assert.equal(result.capabilities.method, 'overleaf-file-tree');
});

test('context file list ignores loose Overleaf globals that are not in the project tree', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro'
    },
    treePaths: [
      ['main.tex'],
      ['sections', 'intro.tex']
    ],
    internalState: {
      project: {
        cachedNames: ['ghost.tex', 'old/removed.bib', 'main.tex'],
        buildOutput: {
          file: 'compile-output.log',
          path: 'not-in-project.tex'
        }
      }
    }
  });

  const result = await bridge.call('getProjectFileList', { preferExact: false });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.files, file => file.path), [
    'main.tex',
    'sections/intro.tex'
  ]);
});

test('context file list includes internal project doc records that are not currently rendered', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}'
    },
    treePaths: [
      ['main.tex']
    ],
    internalState: {
      project: {
        rootFolder: {
          name: '',
          children: [
            {
              name: 'appendix',
              children: [
                {
                  name: 'extra.tex',
                  id: 'aaaaaaaaaaaaaaaaaaaaaaaa'
                }
              ]
            }
          ]
        }
      }
    }
  });

  const result = await bridge.call('getProjectFileList', { preferExact: false });

  assert.deepEqual(Array.from(result.files, file => file.path), [
    'main.tex',
    'appendix/extra.tex'
  ]);
});

test('context file list ignores stale doc records from arbitrary window caches', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}'
    },
    treePaths: [
      ['main.tex']
    ],
    windowExtra: {
      docCache: {
        docs: [
          {
            name: 'stale.tex',
            id: 'bbbbbbbbbbbbbbbbbbbbbbbb'
          }
        ]
      }
    }
  });

  const result = await bridge.call('getProjectFileList', { preferExact: false });

  assert.deepEqual(Array.from(result.files, file => file.path), ['main.tex']);
});

test('project snapshots reuse the same Overleaf ZIP package within maxAgeMs', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'refs.bib': '@article{x}'
    }
  });

  const first = await bridge.call('getProjectSnapshot', { maxAgeMs: 5000 });
  const second = await bridge.call('getProjectSnapshot', { maxAgeMs: 5000 });

  assert.equal(first.ok, undefined);
  assert.equal(second.ok, undefined);
  assert.deepEqual(Array.from(first.files, file => file.path), ['main.tex', 'refs.bib']);
  assert.deepEqual(Array.from(second.files, file => file.path), ['main.tex', 'refs.bib']);
  assert.equal(bridge.getFetchCount(), 1);
  assert.equal(second.capabilities.diagnostics.snapshotCache, 'memory');
});

test('page bridge rejects spoofed project snapshots without the content capability', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}'
    }
  });

  await bridge.initializeCapability();
  const result = await bridge.spoofCall('getProjectSnapshot', {
    requireFullProject: true,
    maxAgeMs: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'page_bridge_unauthorized');
  assert.equal(bridge.getFetchCount(), 0);
});

test('preferred lightweight project snapshots read editor state without ZIP download', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'refs.bib': '@article{x}'
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    maxAgeMs: 0
  });

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'main.tex');
  assert.equal(result.files[0].content, '\\documentclass{article}');
  assert.equal(bridge.getFetchCount(), 0);
  assert.notEqual(result.capabilities.method, 'overleaf-zip');
});

test('non-invasive lightweight snapshots do not open inactive focus files', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'refs.bib': '@article{x}'
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    allowZipFallback: false,
    allowEditorNavigation: false,
    focusFiles: ['refs.bib'],
    maxAgeMs: 0
  });

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'main.tex');
  assert.equal(bridge.getFetchCount(), 0);
  assert.equal(bridge.getOpenClickCount(), 0);
  assert.equal(bridge.getActivePath(), 'main.tex');
});

test('requested-only lightweight snapshots do not expand to unrelated project doc records', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'refs.bib': '@article{x}',
      'sections/extra.tex': 'Extra'
    },
    docFetchFiles: {
      bbbbbbbbbbbbbbbbbbbbbbbb: '@article{x}',
      cccccccccccccccccccccccc: 'Extra'
    },
    internalState: {
      project: {
        rootFolder: {
          name: '',
          children: [
            {
              name: 'refs.bib',
              id: 'bbbbbbbbbbbbbbbbbbbbbbbb'
            },
            {
              name: 'sections',
              children: [
                {
                  name: 'extra.tex',
                  id: 'cccccccccccccccccccccccc'
                }
              ]
            }
          ]
        }
      }
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    allowZipFallback: false,
    allowEditorNavigation: false,
    restrictToRequestedPathsOnly: true,
    focusFiles: ['refs.bib'],
    maxAgeMs: 0
  });

  assert.deepEqual(Array.from(result.files, file => file.path), ['main.tex', 'refs.bib']);
  assert.equal(result.capabilities.fullProjectSnapshot, false);
  assert.equal(result.capabilities.requestedPathsComplete, true);
  assert.equal(bridge.getFetchCount(), 1);
  assert.equal(bridge.getOpenClickCount(), 0);
});

test('requested-only snapshots filter successful ZIP fallback to active and focus paths', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'Main',
      'refs.bib': '@article{x}',
      'sections/extra.tex': 'Extra'
    },
    zipFiles: {
      'main.tex': 'Main from zip',
      'refs.bib': '@article{x}',
      'sections/extra.tex': 'Extra'
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    restrictToRequestedPathsOnly: true,
    focusFiles: ['refs.bib'],
    maxAgeMs: 0
  });

  assert.equal(result.capabilities.method, 'overleaf-zip');
  assert.equal(result.capabilities.fullProjectSnapshot, false);
  assert.equal(result.capabilities.requestedPathsComplete, true);
  assert.deepEqual(Array.from(result.files, file => file.path), ['main.tex', 'refs.bib']);
  assert.equal(result.files.find(file => file.path === 'sections/extra.tex'), undefined);
});

test('requested-only snapshots do not reuse cache entries after the active file changes', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'Main',
      'refs.bib': '@article{x}',
      'sections/extra.tex': 'Extra'
    },
    zipFiles: {
      'main.tex': 'Main from zip',
      'refs.bib': '@article{x}',
      'sections/extra.tex': 'Extra'
    }
  });

  const params = {
    preferLightweight: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    restrictToRequestedPathsOnly: true,
    focusFiles: ['refs.bib'],
    maxAgeMs: 5000
  };

  const first = await bridge.call('getProjectSnapshot', params);
  bridge.setActivePath('sections/extra.tex');
  const second = await bridge.call('getProjectSnapshot', params);

  assert.deepEqual(Array.from(first.files, file => file.path), ['main.tex', 'refs.bib']);
  assert.deepEqual(Array.from(second.files, file => file.path), ['refs.bib', 'sections/extra.tex']);
  assert.equal(second.capabilities.diagnostics.snapshotCache, 'fresh');
  assert.equal(bridge.getFetchCount(), 2);
});

test('run snapshots can require full project and fall back to ZIP without editor navigation', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'refs.bib': '@article{x}'
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    maxAgeMs: 0
  });

  assert.equal(result.capabilities.method, 'overleaf-zip');
  assert.equal(bridge.getFetchCount(), 1);
  assert.equal(bridge.getOpenClickCount(), 0);
  assert.deepEqual(Array.from(result.files, file => file.path), ['main.tex', 'refs.bib']);
});

test('run snapshots can include binary project assets for local LaTeX compilation', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\includegraphics{Figures/plot.pdf}',
      'Figures/plot.pdf': '%PDF-test'
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    includeBinaryFiles: true,
    maxAgeMs: 0
  });

  assert.equal(result.capabilities.method, 'overleaf-zip');
  assert.deepEqual(Array.from(result.files, file => [file.path, file.kind]), [
    ['main.tex', 'text'],
    ['Figures/plot.pdf', 'binary']
  ]);
  assert.equal(result.files[1].contentBase64, Buffer.from('%PDF-test').toString('base64'));
  assert.equal(result.files[1].size, Buffer.byteLength('%PDF-test'));
});

test('binary asset overwrites are blocked when current Overleaf asset differs from baseline', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\includegraphics{Figures/plot.pdf}',
      'Figures/plot.pdf': '%PDF-current'
    }
  });

  const result = await bridge.call('applyOperations', {
    operations: [
      {
        type: 'overwrite-binary',
        path: 'Figures/plot.pdf',
        contentBase64: Buffer.from('%PDF-next').toString('base64'),
        size: Buffer.byteLength('%PDF-next'),
        previousExists: true
      }
    ],
    baseFiles: [
      {
        path: 'Figures/plot.pdf',
        kind: 'binary',
        contentBase64: Buffer.from('%PDF-baseline').toString('base64'),
        size: Buffer.byteLength('%PDF-baseline')
      }
    ],
    requireReviewing: false,
    requireEditing: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'stale_binary_asset');
});

test('full run snapshots prefer live active editor text over stale ZIP content', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'live unsaved editor text',
      'refs.bib': '@article{x}'
    },
    zipFiles: {
      'main.tex': 'stale zip text',
      'refs.bib': '@article{x}'
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    includeBinaryFiles: true,
    force: true,
    maxAgeMs: 0
  });

  assert.equal(result.capabilities.method, 'overleaf-zip');
  assert.equal(result.files.find(file => file.path === 'main.tex')?.content, 'live unsaved editor text');
  assert.equal(result.files.find(file => file.path === 'main.tex')?.source, 'active-editor');
});

test('full run snapshots prefer live active editor text over stale active doc records', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'live unsaved editor text',
      'refs.bib': '@article{x}'
    },
    zipFiles: {
      'main.tex': 'stale zip text',
      'refs.bib': '@article{x}'
    },
    docFetchFiles: {
      aaaaaaaaaaaaaaaaaaaaaaaa: 'stale doc record text'
    },
    internalState: {
      project: {
        rootFolder: {
          name: '',
          children: [
            {
              name: 'main.tex',
              id: 'aaaaaaaaaaaaaaaaaaaaaaaa'
            }
          ]
        }
      }
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    includeBinaryFiles: true,
    force: true,
    maxAgeMs: 0
  });

  assert.equal(result.files.find(file => file.path === 'main.tex')?.content, 'live unsaved editor text');
  assert.equal(result.files.find(file => file.path === 'main.tex')?.source, 'active-editor');
});

test('file-tree operations are skipped when Overleaf does not reflect the requested path change', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'Main'
    },
    internalState: {
      fileTreeManager: {
        async createDoc() {
          // Simulate a stale or changed Overleaf internal API that returns but does not create anything.
        }
      }
    }
  });

  const result = await bridge.call('applyOperations', {
    operations: [
      { type: 'create', path: 'new.tex', content: 'New' }
    ],
    baseFiles: [
      { path: 'main.tex', content: 'Main' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].operation.path, 'new.tex');
  assert.equal(result.skipped[0].result.code, 'file_tree_verification_failed');
});

test('delete operations fail verification when Overleaf still shows the file', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'Main'
    },
    internalState: {
      fileTreeManager: {
        async deleteEntity() {
          // Simulate Overleaf returning before the tree actually changes.
        }
      }
    }
  });

  const result = await bridge.call('applyOperations', {
    operations: [
      { type: 'delete', path: 'main.tex' }
    ],
    baseFiles: [
      { path: 'main.tex', content: 'Main' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].operation.path, 'main.tex');
  assert.equal(result.skipped[0].result.code, 'file_tree_verification_failed');
});

test('rename operations fail verification when Overleaf does not move the path', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'Main'
    },
    internalState: {
      fileTreeManager: {
        async renameEntity() {
          // Simulate Overleaf returning without renaming anything.
        }
      }
    }
  });

  const result = await bridge.call('applyOperations', {
    operations: [
      { type: 'rename', path: 'main.tex', to: 'renamed.tex' }
    ],
    baseFiles: [
      { path: 'main.tex', content: 'Main' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].operation.path, 'main.tex');
  assert.equal(result.skipped[0].result.code, 'file_tree_verification_failed');
});

test('move operations fail verification when Overleaf does not move the path', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'Main'
    },
    internalState: {
      fileTreeManager: {
        async moveEntity() {
          // Simulate Overleaf returning without moving anything.
        }
      }
    }
  });

  const result = await bridge.call('applyOperations', {
    operations: [
      { type: 'move', path: 'main.tex', to: 'moved-main.tex' }
    ],
    baseFiles: [
      { path: 'main.tex', content: 'Main' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].operation.path, 'main.tex');
  assert.equal(result.skipped[0].result.code, 'file_tree_verification_failed');
});

test('run snapshots never open inactive Overleaf files when ZIP fallback is unavailable', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro'
    },
    fetchMode: 'hang'
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    zipTimeoutMs: 5,
    maxAgeMs: 0
  });

  assert.equal(bridge.getOpenClickCount(), 0);
  assert.equal(bridge.getActivePath(), 'main.tex');
  assert.equal(result.capabilities.fullProjectSnapshot, false);
  assert.notEqual(result.capabilities.method, 'open-file-tree-text-files');
  assert.match(result.capabilities.skipped[0].reason, /timed out/i);
});

test('non-invasive snapshots do not restore an old active file after the user switches files during ZIP fallback', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro'
    },
    fetchMode: 'hang',
    onFetch({ setActivePath }) {
      setActivePath('sections/intro.tex');
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    zipTimeoutMs: 5,
    maxAgeMs: 0
  });

  assert.equal(bridge.getOpenClickCount(), 0);
  assert.equal(bridge.getActivePath(), 'sections/intro.tex');
  assert.equal(result.capabilities.fullProjectSnapshot, false);
});

test('zip-only run snapshots never inspect or open the Overleaf project tree', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'sections/intro.tex': 'Intro'
    },
    treePaths: [
      ['main.tex'],
      ['sections', 'intro.tex']
    ],
    fetchMode: 'hang'
  });

  const result = await bridge.call('getProjectSnapshot', {
    zipOnly: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    zipTimeoutMs: 5,
    maxAgeMs: 0
  });

  assert.equal(bridge.getOpenClickCount(), 0);
  assert.equal(bridge.getTreeQueryCount(), 0);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'main.tex');
  assert.equal(result.capabilities.method, 'active-editor-zip-only-fallback');
  assert.equal(result.capabilities.fullProjectSnapshot, false);
}
);

test('zip-only full snapshots do not add synthetic active.tex when active path is unknown', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'live unsaved editor text',
      'refs.bib': '@article{x}'
    },
    zipFiles: {
      'main.tex': 'zip main text',
      'refs.bib': '@article{x}'
    },
    activePathKnown: false
  });

  const result = await bridge.call('getProjectSnapshot', {
    zipOnly: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    includeBinaryFiles: true,
    maxAgeMs: 0
  });

  assert.equal(result.capabilities.method, 'overleaf-zip');
  assert.equal(result.capabilities.fullProjectSnapshot, true);
  assert.deepEqual(Array.from(result.files, file => file.path), ['main.tex', 'refs.bib']);
  assert.equal(result.files.find(file => file.path === 'main.tex')?.content, 'zip main text');
  assert.equal(result.files.some(file => file.path === 'active.tex'), false);
  assert.equal(bridge.getTreeQueryCount(), 0);
});

test('requested-only zip-only snapshots filter ZIP files and stay partial', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': 'Main',
      'refs.bib': '@article{x}',
      'sections/extra.tex': 'Extra'
    },
    zipFiles: {
      'main.tex': 'Main from zip',
      'refs.bib': '@article{x}',
      'sections/extra.tex': 'Extra'
    }
  });

  const result = await bridge.call('getProjectSnapshot', {
    zipOnly: true,
    allowZipFallback: true,
    allowEditorNavigation: false,
    requireFullProject: true,
    restrictToRequestedPathsOnly: true,
    focusFiles: ['refs.bib'],
    includeBinaryFiles: true,
    maxAgeMs: 0
  });

  assert.equal(result.capabilities.method, 'overleaf-zip');
  assert.equal(result.capabilities.fullProjectSnapshot, false);
  assert.equal(result.capabilities.requestedPathsComplete, true);
  assert.deepEqual(Array.from(result.files, file => file.path), ['main.tex', 'refs.bib']);
});

test('lightweight snapshots do not poison the full-project ZIP cache', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}',
      'refs.bib': '@article{x}'
    }
  });

  const lightweight = await bridge.call('getProjectSnapshot', {
    preferLightweight: true,
    maxAgeMs: 5000
  });
  const full = await bridge.call('getProjectSnapshot', {
    maxAgeMs: 5000
  });

  assert.equal(lightweight.capabilities.method, 'active-editor-lightweight');
  assert.equal(full.capabilities.method, 'overleaf-zip');
  assert.equal(bridge.getFetchCount(), 1);
  assert.deepEqual(Array.from(full.files, file => file.path), ['main.tex', 'refs.bib']);
});

test('project snapshot falls back when the Overleaf ZIP download hangs', async () => {
  const bridge = createSnapshotHarness({
    files: {
      'main.tex': '\\documentclass{article}\\begin{document}Hello\\end{document}'
    },
    fetchMode: 'hang'
  });

  const result = await bridge.call('getProjectSnapshot', {
    force: true,
    zipTimeoutMs: 5
  });

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'main.tex');
  assert.equal(result.files[0].content, '\\documentclass{article}\\begin{document}Hello\\end{document}');
  assert.equal(result.capabilities.method, 'active-editor');
  assert.match(result.capabilities.skipped[0].reason, /timed out/i);
});

test('force snapshot requests do not reuse in-flight non-force pending snapshots', async () => {
  const harness = createProjectSnapshotCacheHarness();

  const firstPromise = harness.bridge.getProjectSnapshot({
    maxAgeMs: 5000
  });
  const forcePromise = harness.bridge.getProjectSnapshot({
    force: true,
    maxAgeMs: 5000
  });

  harness.resolveAll();
  const [first, forced] = await Promise.all([firstPromise, forcePromise]);

  assert.equal(harness.getCallCount(), 2);
  assert.equal(first.callId, 1);
  assert.equal(forced.callId, 2);
});

test('older pending snapshot requests do not overwrite a newer force snapshot cache entry', async () => {
  const harness = createProjectSnapshotCacheHarness();

  const firstPromise = harness.bridge.getProjectSnapshot({
    maxAgeMs: 5000
  });
  const forcePromise = harness.bridge.getProjectSnapshot({
    force: true,
    maxAgeMs: 5000
  });

  harness.resolveCall(2);
  const forced = await forcePromise;
  harness.resolveCall(1);
  await firstPromise;
  const cached = await harness.bridge.getProjectSnapshot({
    maxAgeMs: 5000
  });

  assert.equal(harness.getCallCount(), 2);
  assert.equal(forced.callId, 2);
  assert.equal(cached.callId, 2);
  assert.equal(cached.capabilities.diagnostics.snapshotCache, 'memory');
});

test('semantically different in-flight snapshot requests do not share pending snapshots', async () => {
  const harness = createProjectSnapshotCacheHarness();

  const lightweightPromise = harness.bridge.getProjectSnapshot({
    preferLightweight: true,
    allowZipFallback: false,
    allowEditorNavigation: false,
    restrictToRequestedPathsOnly: true,
    focusFiles: ['main.tex'],
    maxAgeMs: 5000
  });
  const zipOnlyPromise = harness.bridge.getProjectSnapshot({
    preferLightweight: true,
    zipOnly: true,
    allowZipFallback: true,
    allowEditorNavigation: true,
    requireFullProject: true,
    restrictToRequestedPathsOnly: false,
    focusFiles: ['main.tex'],
    maxAgeMs: 5000
  });

  harness.resolveAll();
  const [lightweight, zipOnly] = await Promise.all([lightweightPromise, zipOnlyPromise]);

  assert.equal(harness.getCallCount(), 2);
  assert.equal(lightweight.callId, 1);
  assert.equal(zipOnly.callId, 2);
  assert.deepEqual(harness.getCalls().map(call => call.params.zipOnly === true), [false, true]);
});

test('snapshot requests with different ZIP timeouts do not share pending snapshots', async () => {
  const harness = createProjectSnapshotCacheHarness();

  const shortTimeoutPromise = harness.bridge.getProjectSnapshot({
    requireFullProject: true,
    allowZipFallback: true,
    zipTimeoutMs: 5,
    maxAgeMs: 5000
  });
  const longTimeoutPromise = harness.bridge.getProjectSnapshot({
    requireFullProject: true,
    allowZipFallback: true,
    zipTimeoutMs: 30000,
    maxAgeMs: 5000
  });

  harness.resolveAll();
  const [shortTimeout, longTimeout] = await Promise.all([shortTimeoutPromise, longTimeoutPromise]);

  assert.equal(harness.getCallCount(), 2);
  assert.equal(shortTimeout.callId, 1);
  assert.equal(longTimeout.callId, 2);
});

test('semantically different completed snapshot requests do not evict each other from cache', async () => {
  const harness = createProjectSnapshotCacheHarness({ autoResolve: true });

  const lightweight = await harness.bridge.getProjectSnapshot({
    preferLightweight: true,
    allowZipFallback: false,
    maxAgeMs: 5000
  });
  const zipOnly = await harness.bridge.getProjectSnapshot({
    zipOnly: true,
    requireFullProject: true,
    maxAgeMs: 5000
  });
  const lightweightAgain = await harness.bridge.getProjectSnapshot({
    preferLightweight: true,
    allowZipFallback: false,
    maxAgeMs: 5000
  });

  assert.equal(harness.getCallCount(), 2);
  assert.equal(lightweight.callId, 1);
  assert.equal(zipOnly.callId, 2);
  assert.equal(lightweightAgain.callId, 1);
  assert.equal(lightweightAgain.capabilities.diagnostics.snapshotCache, 'memory');
});

function createSnapshotHarness({
  files,
  zipFiles = null,
  docFetchFiles = null,
  fetchMode: initialFetchMode = 'zip',
  treePaths = null,
  internalState = {},
  windowExtra = {},
  onFetch = null,
  activePathKnown = true
}) {
  const fileMap = new Map(Object.entries(files));
  const zipBuffer = createStoredZip(zipFiles || files);
  let fetchMode = initialFetchMode;
  let listener = null;
  let fetchCount = 0;
  let openClickCount = 0;
  let treeQueryCount = 0;
  let selectedPath = Array.from(fileMap.keys())[0];
  if (activePathKnown) {
    internalState.editor = {
      ...(internalState.editor || {}),
      open_doc_name: internalState.editor?.open_doc_name || selectedPath
    };
  }
  // Welcome-panel + write-guard v1.3.8 add-on (Task 2): the page-side
  // `getEditorProjectIdPageSide()` reader looks for `_ide.project._id`
  // first. Mutate `internalState.project` (keeping the live reference the
  // page bridge holds via `_ide: internalState`) so a stable `_id` is
  // present unless the test pre-supplied one. Other `project.*` fields
  // tests pass (cachedNames, buildOutput, …) are preserved verbatim.
  internalState.project = {
    _id: 'test-project',
    ...(internalState.project || {})
  };
  const bridgeCapability = 'test-page-bridge-capability';
  let capabilityInitialized = false;
  const treeNodes = treePaths
    ? treePaths.flatMap(parts => makeNestedTreeNodes(parts))
    : null;
  const pendingResults = new Map();
  const editorTextarea = {
    tagName: 'TEXTAREA',
    get value() {
      return fileMap.get(selectedPath) || '';
    },
    set value(nextValue) {
      fileMap.set(selectedPath, String(nextValue ?? ''));
    },
    textContent: '',
    innerText: '',
    parentElement: null,
    getAttribute(attribute) {
      if (attribute === 'aria-label') {
        return 'Source Editor editing';
      }
      if (attribute === 'class') {
        return 'source-editor';
      }
      return '';
    }
  };

  const document = {
    activeElement: editorTextarea,
    body: { innerText: '', textContent: '' },
    querySelector(selector) {
      if (/\[aria-selected="true"\]|\.selected/.test(selector)) {
        if (!activePathKnown) {
          return null;
        }
        return makeTreeNode(selectedPath);
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'textarea') {
        return [editorTextarea];
      }
      if (/treeitem|role="row"|file-tree|project-tree|data-entity-id|data-doc-id|data-id|data-file-id/.test(selector)) {
        treeQueryCount += 1;
        if (treeNodes) {
          return treeNodes;
        }
        return Array.from(fileMap.keys(), makeTreeNode);
      }
      if (selector === '*') {
        return [editorTextarea, ...Array.from(fileMap.keys(), makeTreeNode)];
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
    CodexOverleafReviewing: {
      detectReviewingFromSignals() {
        return { ok: true, status: 'enabled', source: 'test' };
      }
    },
    CodexOverleafStaleGuard: staleGuard,
    _ide: internalState,
    ...windowExtra,
    btoa(value) {
      return Buffer.from(value, 'binary').toString('base64');
    },
    fetch: async (_endpoint, options = {}) => {
      fetchCount += 1;
      const endpoint = String(_endpoint || '');
      if (typeof onFetch === 'function') {
        onFetch({
          endpoint,
          options,
          setActivePath(path) {
            selectedPath = path;
            if (activePathKnown) {
              internalState.editor = {
                ...(internalState.editor || {}),
                open_doc_name: path
              };
            }
          }
        });
      }
      const docMatch = endpoint.match(/\/doc\/([^/?#]+)/);
      if (docMatch && docFetchFiles) {
        const content = docFetchFiles[decodeURIComponent(docMatch[1])] || '';
        return {
          ok: true,
          headers: {
            get(name) {
              return name.toLowerCase() === 'content-type' ? 'application/json' : '';
            }
          },
          json: async () => ({ content })
        };
      }
      if (fetchMode === 'hang') {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new Error('aborted by test'));
          }, { once: true });
        });
      }
      return {
        ok: true,
        headers: {
          get(name) {
            return name.toLowerCase() === 'content-type' ? 'application/zip' : '';
          }
        },
        arrayBuffer: async () => zipBuffer.slice(0)
      };
    },
    addEventListener(event, callback) {
      if (event === 'message') {
        listener = callback;
      }
    },
    postMessage(message) {
      if (message.source !== 'codex-overleaf/page') {
        return;
      }
      const resolve = pendingResults.get(message.id);
      if (resolve) {
        pendingResults.delete(message.id);
        resolve(message.result);
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
    TextDecoder,
    AbortController,
    fetch: window.fetch,
    setTimeout,
    clearTimeout,
    btoa(value) {
      return Buffer.from(value, 'binary').toString('base64');
    },
    console
  });

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
  if (pageBridgeCapabilitySource) {
    vm.runInContext(pageBridgeCapabilitySource, context, { filename: 'pageBridgeCapability.js' });
  }
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
      // runProjectId on guarded methods so legacy snapshot tests pass the
      // page-side write guard. Production callsites in contentRuntime
      // always set it; this harness mirrors that.
      const guardedMethods = new Set(['applyOperations', 'acceptTrackedChanges', 'rejectTrackedChanges']);
      let nextParams = params;
      if (guardedMethods.has(method)
        && params
        && typeof params === 'object'
        && typeof params.runProjectId !== 'string') {
        nextParams = { ...params, runProjectId: 'test-project' };
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
    getFetchCount() {
      return fetchCount;
    },
    getOpenClickCount() {
      return openClickCount;
    },
    getTreeQueryCount() {
      return treeQueryCount;
    },
    getActivePath() {
      return selectedPath;
    },
    setActivePath(path) {
      selectedPath = path;
      if (activePathKnown) {
        internalState.editor = {
          ...(internalState.editor || {}),
          open_doc_name: path
        };
      }
    },
    setFetchMode(mode) {
      fetchMode = mode;
    }
  };

  async function sendPageBridgeRequest(method, params, options = {}) {
    assert.equal(typeof listener, 'function');
    const id = `test-${pendingResults.size + 1}-${Date.now()}`;
    const resultPromise = new Promise(resolve => {
      pendingResults.set(id, resolve);
    });
    const data = {
      source: 'codex-overleaf/content',
      id,
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
        openClickCount += 1;
        selectedPath = filePath;
        return true;
      }
    };
  }

  function makeNestedTreeNodes(parts) {
    let parentElement = null;
    const nodes = [];
    let currentPath = '';
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const node = {
        textContent: part,
        parentElement,
        getAttribute(attribute) {
          if (attribute === 'role') {
            return 'treeitem';
          }
          if (attribute === 'data-name' || attribute === 'aria-label' || attribute === 'title') {
            return part;
          }
          if (attribute === 'data-path') {
            return isFile && parts.length === 1 ? currentPath : '';
          }
          return '';
        },
        dispatchEvent() {
          openClickCount += 1;
          selectedPath = currentPath;
          return true;
        }
      };
      nodes.push(node);
      parentElement = node;
    });
    return nodes;
  }
}

function createProjectSnapshotCacheHarness({ autoResolve = false } = {}) {
  const calls = [];
  const pending = [];
  const bridge = projectSnapshotFactory.create({
    window: {
      location: {
        href: 'https://www.overleaf.com/project/test-project',
        origin: 'https://www.overleaf.com',
        pathname: '/project/test-project'
      }
    },
    getProjectId() {
      return 'test-project';
    },
    normalizePath: projectFiles.normalizePath,
    buildProjectSnapshot(params = {}) {
      const callId = calls.length + 1;
      calls.push({
        callId,
        params: { ...params }
      });
      const snapshot = {
        id: 'test-project',
        callId,
        params: { ...params },
        files: [{ path: `snapshot-${callId}.tex`, content: String(callId), kind: 'text' }],
        capabilities: {
          fullProjectSnapshot: params.requireFullProject === true,
          method: params.zipOnly ? 'overleaf-zip' : 'active-editor'
        }
      };
      if (autoResolve) {
        return Promise.resolve(snapshot);
      }
      return new Promise(resolve => {
        pending.push({
          callId,
          resolve: () => resolve(snapshot)
        });
      });
    },
    buildProjectFileList() {
      throw new Error('not used by these tests');
    }
  });

  return {
    bridge,
    getCallCount() {
      return calls.length;
    },
    getCalls() {
      return calls.slice();
    },
    resolveAll() {
      for (const resolve of pending.splice(0)) {
        resolve.resolve();
      }
    },
    resolveCall(callId) {
      const index = pending.findIndex(item => item.callId === callId);
      assert.notEqual(index, -1, `Missing pending call ${callId}`);
      const [item] = pending.splice(index, 1);
      item.resolve();
    }
  };
}

function createStoredZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const contentBytes = encoder.encode(content);
    const local = new Uint8Array(30 + nameBytes.length + contentBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(18, contentBytes.length, true);
    localView.setUint32(22, contentBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(contentBytes, 30 + nameBytes.length);
    chunks.push(local);

    const directory = new Uint8Array(46 + nameBytes.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(10, 0, true);
    directoryView.setUint32(20, contentBytes.length, true);
    directoryView.setUint32(24, contentBytes.length, true);
    directoryView.setUint16(28, nameBytes.length, true);
    directoryView.setUint32(42, offset, true);
    directory.set(nameBytes, 46);
    central.push(directory);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, central.length, true);
  eocdView.setUint16(10, central.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);

  return concatUint8Arrays([...chunks, ...central, eocd]).buffer;
}

function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
