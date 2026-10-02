const assert = require('node:assert/strict');
const test = require('node:test');

const projectFiles = require('../extension/src/shared/projectFiles');
const staleGuard = require('../extension/src/shared/staleGuard');
const writebackRouterModule = require('../extension/src/page/writebackRouter');

// Welcome-panel + write-guard v1.3.8 add-on (Task 2): the writeback router
// now requires `params.runProjectId` as defense-in-depth. These legacy
// navigation tests predate the field, so we wrap `create()` to auto-inject a
// stable id on guarded entry points and let the existing assertions run
// against the routing logic itself, unchanged.
const writebackRouter = {
  create(deps) {
    const raw = writebackRouterModule.create(deps);
    const guarded = ['applyOperations', 'acceptTrackedChanges', 'rejectTrackedChanges'];
    const wrapped = { ...raw };
    for (const method of guarded) {
      const original = raw[method];
      if (original instanceof Function) {
        wrapped[method] = (...args) => {
          if (method === 'applyOperations' && Array.isArray(args[0])) {
            return original.apply(raw, args);
          }
          const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
          if (typeof payload.runProjectId === 'string') {
            return original.apply(raw, args);
          }
          return original.call(raw, { runProjectId: 'test-project', ...payload }, ...args.slice(1));
        };
      }
    }
    return wrapped;
  }
};

test('writeback router refuses cross-file patch writes when the editor document did not switch', async () => {
  const files = new Map([
    ['main.tex', 'root body'],
    ['example/test.tex', '']
  ]);
  let selectedPath = 'main.tex';
  let editorPath = 'main.tex';
  let sourceEdited = false;
  const editorIdentity = { type: 'codemirror-view', doc: 'main-doc' };
  const router = writebackRouter.create({
    activeEditorIdentityChanged: () => false,
    compileBridge: {
      markSourceEdited() {
        sourceEdited = true;
      }
    },
    getActiveEditorIdentity: () => editorIdentity,
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    normalizeTextPatches,
    readActiveEditorText: () => files.get(editorPath) || '',
    replaceActiveEditorPatches(patches) {
      const text = files.get(editorPath) || '';
      const next = patches.slice().sort((left, right) => right.from - left.from).reduce((value, patch) => {
        return value.slice(0, patch.from) + patch.insert + value.slice(patch.to);
      }, text);
      files.set(editorPath, next);
      return { ok: true, method: 'codemirror-view-patch' };
    },
    treeOperations: {
      contentSignature(content) {
        const text = String(content || '');
        return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
      },
      getActiveFilePath: () => selectedPath,
      openFileByPath(path) {
        selectedPath = path;
        return Promise.resolve({ ok: true, method: 'dom-click' });
      },
      waitForActiveEditorText(path) {
        return Promise.resolve({
          ok: true,
          path,
          text: files.get(editorPath) || ''
        });
      }
    },
    window: {
      CodexOverleafStaleGuard: staleGuard,
      setTimeout,
      clearTimeout
    }
  });

  const result = await router.applyOperations({
    baseFiles: [
      { path: 'main.tex', content: 'root body' },
      { path: 'example/test.tex', content: '' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'example/test.tex',
        patches: [
          { from: 0, to: 0, expected: '', insert: 'initialized' }
        ]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'editor_document_not_switched');
  assert.equal(files.get('main.tex'), 'root body');
  assert.equal(files.get('example/test.tex'), '');
  assert.equal(sourceEdited, false);
});

test('switch confirms via target-base match even when editor identity never changes', async () => {
  // v1.6 fix: identity comparison is fragile against newer Overleaf view
  // lifecycles; an editor that loads the target file's exact base content is
  // the strongest proof the switch landed.
  const files = new Map([
    ['main.tex', 'root body'],
    ['example/test2.tex', 'placeholder body']
  ]);
  let selectedPath = 'main.tex';
  let editorPath = 'main.tex';
  const router = writebackRouter.create({
    activeEditorIdentityChanged: () => false,
    compileBridge: { markSourceEdited() {} },
    getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc: 'doc' }),
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    normalizeTextPatches,
    readActiveEditorText: () => files.get(editorPath) || '',
    replaceActiveEditorPatches(patches) {
      const text = files.get(editorPath) || '';
      const next = patches.slice().sort((left, right) => right.from - left.from).reduce((value, patch) => {
        return value.slice(0, patch.from) + patch.insert + value.slice(patch.to);
      }, text);
      files.set(editorPath, next);
      return { ok: true, method: 'codemirror-view-patch' };
    },
    treeOperations: {
      contentSignature(content) {
        const text = String(content || '');
        return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
      },
      getActiveFilePath: () => selectedPath,
      openFileByPath(path) {
        selectedPath = path;
        editorPath = path; // editor follows the switch (content loads)
        return Promise.resolve({ ok: true, method: 'dom-click' });
      },
      waitForActiveEditorText(path) {
        return Promise.resolve({ ok: true, path, text: files.get(editorPath) || '' });
      }
    },
    window: {
      CodexOverleafStaleGuard: staleGuard,
      setTimeout,
      clearTimeout
    }
  });

  const result = await router.applyOperations({
    baseFiles: [
      { path: 'main.tex', content: 'root body' },
      { path: 'example/test2.tex', content: 'placeholder body' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'example/test2.tex',
        patches: [
          { from: 0, to: 0, expected: '', insert: 'polished ' }
        ]
      }
    ]
  });

  assert.equal(result.ok, true, JSON.stringify(result.skipped?.[0]?.result || {}));
  assert.equal(result.applied.length, 1);
  assert.equal(files.get('example/test2.tex'), 'polished placeholder body');
});

test('known-base mismatch still refuses the switch even when content changed', async () => {
  // Safety lock for acceptor 4: when the target's base IS known, content must
  // match it — content merely "different from the previous doc" is not
  // sufficient, because a weakly-anchored patch (expected:'') would anchor
  // trivially into a wrong-but-different document.
  const files = new Map([
    ['main.tex', 'root body'],
    ['example/test.tex', 'drifted content not matching base exactly\n']
  ]);
  let selectedPath = 'main.tex';
  let editorPath = 'main.tex';
  const router = writebackRouter.create({
    activeEditorIdentityChanged: () => false,
    compileBridge: { markSourceEdited() {} },
    getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc: 'doc' }),
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    normalizeTextPatches,
    readActiveEditorText: () => files.get(editorPath) || '',
    replaceActiveEditorPatches(patches) {
      const text = files.get(editorPath) || '';
      const next = patches.slice().sort((left, right) => right.from - left.from).reduce((value, patch) => {
        return value.slice(0, patch.from) + patch.insert + value.slice(patch.to);
      }, text);
      files.set(editorPath, next);
      return { ok: true, method: 'codemirror-view-patch' };
    },
    treeOperations: {
      contentSignature(content) {
        const text = String(content || '');
        return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
      },
      getActiveFilePath: () => selectedPath,
      openFileByPath(path) {
        selectedPath = path;
        editorPath = path;
        return Promise.resolve({ ok: true, method: 'dom-click' });
      },
      waitForActiveEditorText(path) {
        return Promise.resolve({ ok: true, path, text: files.get(editorPath) || '' });
      }
    },
    window: {
      CodexOverleafStaleGuard: staleGuard,
      setTimeout,
      clearTimeout
    }
  });

  const result = await router.applyOperations({
    baseFiles: [
      { path: 'main.tex', content: 'root body' },
      // base differs from what the editor shows -> the switch gate accepts
      // via content-changed, then the STALE GUARD refuses the write.
      { path: 'example/test.tex', content: 'expected base content\n' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'example/test.tex',
        patches: [
          { from: 0, to: 0, expected: '', insert: 'x' }
        ]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped[0].result.code, 'editor_document_not_switched');
});

test('unknown-base acceptor lets an off-baseline target reach a clean missing_base_file verdict, not a switch timeout (v1.6.2 lock)', async () => {
  // Last-resort switch acceptor: path matches + content moved off the previous
  // document + settle elapsed, allowed ONLY when the target's base is unknown
  // (not in baseFiles). Exercises writebackRouter's
  // `!baseComparison.known && contentChangedFromPrevious && settledLongEnough`,
  // which every other navigation case (target seeded into baseFiles) skips.
  // Its value: the switch CONFIRMS (so the op reaches the stale guard, which
  // correctly refuses an unread file with missing_base_file) instead of
  // looping to a misleading editor_document_not_switched timeout. The file is
  // never overwritten either way.
  const files = new Map([
    ['main.tex', 'root body'],
    ['sections/new.tex', 'existing new body']
  ]);
  let selectedPath = 'main.tex';
  let editorPath = 'main.tex';
  const router = writebackRouter.create({
    activeEditorIdentityChanged: () => false,
    compileBridge: { markSourceEdited() {} },
    getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc: 'doc' }),
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    normalizeTextPatches,
    readActiveEditorText: () => files.get(editorPath) || '',
    replaceActiveEditorPatches(patches) {
      const text = files.get(editorPath) || '';
      const next = patches.slice().sort((left, right) => right.from - left.from).reduce((value, patch) => {
        return value.slice(0, patch.from) + patch.insert + value.slice(patch.to);
      }, text);
      files.set(editorPath, next);
      return { ok: true, method: 'codemirror-view-patch' };
    },
    treeOperations: {
      contentSignature(content) {
        const text = String(content || '');
        return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
      },
      getActiveFilePath: () => selectedPath,
      openFileByPath(path) {
        selectedPath = path;
        editorPath = path;
        return Promise.resolve({ ok: true, method: 'dom-click' });
      },
      waitForActiveEditorText(path) {
        return Promise.resolve({ ok: true, path, text: files.get(editorPath) || '' });
      }
    },
    window: {
      CodexOverleafStaleGuard: staleGuard,
      setTimeout,
      clearTimeout
    }
  });

  const result = await router.applyOperations({
    baseFiles: [
      // sections/new.tex is deliberately ABSENT -> its base is unknown
      { path: 'main.tex', content: 'root body' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'sections/new.tex',
        patches: [
          { from: 0, to: 0, expected: '', insert: 'PREPENDED ' }
        ]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  const verdict = String(result.skipped[0].result.reasonKey || result.skipped[0].result.code || '');
  assert.notEqual(result.skipped[0].result.code, 'editor_document_not_switched',
    'the switch must confirm via the unknown-base acceptor, not loop to a timeout');
  assert.match(verdict, /missing_base_file|missingBaseFile/,
    'an off-baseline target is refused as missing_base_file');
  assert.equal(files.get('sections/new.tex'), 'existing new body',
    'the unknown-base target is never overwritten');
});

test('writeback router force-reopens a selected target when the editor is still on another document', async () => {
  const files = new Map([
    ['main.tex', 'root body'],
    ['example/test.tex', '']
  ]);
  let selectedPath = 'example/test.tex';
  let editorPath = 'main.tex';
  let forceOpenSeen = false;
  const router = writebackRouter.create({
    activeEditorIdentityChanged: previous => previous?.doc !== editorPath,
    compileBridge: { markSourceEdited() {} },
    getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc: editorPath }),
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    normalizeTextPatches,
    readActiveEditorText: () => files.get(editorPath) || '',
    replaceActiveEditorPatches(patches) {
      const text = files.get(editorPath) || '';
      const next = patches.slice().sort((left, right) => right.from - left.from).reduce((value, patch) => {
        return value.slice(0, patch.from) + patch.insert + value.slice(patch.to);
      }, text);
      files.set(editorPath, next);
      return { ok: true, method: 'codemirror-view-patch' };
    },
    treeOperations: {
      contentSignature(content) {
        const text = String(content || '');
        return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
      },
      getActiveFilePath: () => selectedPath,
      openFileByPath(path, options = {}) {
        forceOpenSeen = options.force === true;
        selectedPath = path;
        editorPath = path;
        return Promise.resolve({ ok: true, method: 'dom-click' });
      },
      waitForActiveEditorText(path) {
        return Promise.resolve({
          ok: true,
          path,
          text: files.get(editorPath) || ''
        });
      }
    },
    window: {
      CodexOverleafStaleGuard: staleGuard,
      setTimeout,
      clearTimeout
    }
  });

  const result = await router.applyOperations({
    baseFiles: [
      { path: 'main.tex', content: 'root body' },
      { path: 'example/test.tex', content: '' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'example/test.tex',
        patches: [
          { from: 0, to: 0, expected: '', insert: 'initialized' }
        ]
      }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(forceOpenSeen, true);
  assert.equal(files.get('main.tex'), 'root body');
  assert.equal(files.get('example/test.tex'), 'initialized');
});

test('writeback router waits for editor document switch before writing identical empty files', async () => {
  const files = new Map([
    ['main.tex', ''],
    ['example/test.tex', '']
  ]);
  let selectedPath = 'example/test.tex';
  let editorPath = 'main.tex';
  const router = writebackRouter.create({
    activeEditorIdentityChanged: () => false,
    compileBridge: { markSourceEdited() {} },
    getActiveEditorIdentity: () => null,
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    normalizeTextPatches,
    readActiveEditorText: () => files.get(editorPath) || '',
    replaceActiveEditorPatches(patches) {
      const text = files.get(editorPath) || '';
      const next = patches.slice().sort((left, right) => right.from - left.from).reduce((value, patch) => {
        return value.slice(0, patch.from) + patch.insert + value.slice(patch.to);
      }, text);
      files.set(editorPath, next);
      return { ok: true, method: 'codemirror-view-patch' };
    },
    treeOperations: {
      contentSignature(content) {
        const text = String(content || '');
        return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
      },
      getActiveFilePath: () => selectedPath,
      openFileByPath(path) {
        selectedPath = path;
        setTimeout(() => {
          editorPath = path;
        }, 20);
        return Promise.resolve({ ok: true, method: 'dom-click' });
      },
      waitForActiveEditorText(path) {
        return Promise.resolve({
          ok: true,
          path,
          text: files.get(editorPath) || ''
        });
      }
    },
    window: {
      CodexOverleafStaleGuard: staleGuard,
      setTimeout,
      clearTimeout
    },
    writebackOpenSettleMs: 60
  });

  const result = await router.applyOperations({
    baseFiles: [
      { path: 'main.tex', content: '' },
      { path: 'example/test.tex', content: '' }
    ],
    operations: [
      {
        type: 'edit',
        path: 'example/test.tex',
        patches: [
          { from: 0, to: 0, expected: '', insert: 'initialized' }
        ]
      }
    ]
  });

  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(files.get('main.tex'), '');
  assert.equal(files.get('example/test.tex'), 'initialized');
});

function normalizeTextPatches(patches, length) {
  const normalized = [];
  for (const patch of patches || []) {
    const from = Number(patch?.from);
    const to = Number(patch?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > length) {
      return { ok: false, code: 'invalid_patch' };
    }
    normalized.push({
      from,
      to,
      expected: String(patch.expected ?? ''),
      insert: String(patch.insert ?? '')
    });
  }
  return { ok: true, patches: normalized };
}

test('a file that fails to open mid-batch is retried after the rest of the batch settles', async () => {
  const files = new Map([['roadmap.md', 'plan'], ['Proof.md', 'proof'], ['Tex/Chap_05.tex', 'chapter']]);
  let activePath = 'roadmap.md';
  const openAttempts = new Map();
  const router = writebackRouter.create({
    activeEditorIdentityChanged: () => true,
    compileBridge: { markSourceEdited() {} },
    delay: () => Promise.resolve(),
    reopenRetryDelayMs: 0,
    getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc: activePath }),
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    normalizeTextPatches,
    readActiveEditorText: () => files.get(activePath),
    replaceActiveEditorPatches(patches) {
      const text = files.get(activePath);
      files.set(activePath, patches.slice().sort((a, b) => b.from - a.from)
        .reduce((value, patch) => value.slice(0, patch.from) + patch.insert + value.slice(patch.to), text));
      return { ok: true, method: 'codemirror-view-patch' };
    },
    treeOperations: {
      contentSignature: content => String(content || '').length + ':' + String(content || ''),
      getActiveFilePath: () => activePath,
      openFileByPath(path) {
        const attempt = (openAttempts.get(path) || 0) + 1;
        openAttempts.set(path, attempt);
        // The chapter's first open is dropped while the previous file settles.
        if (path === 'Tex/Chap_05.tex' && attempt === 1) return Promise.resolve({ ok: false, reason: 'click dropped' });
        activePath = path;
        return Promise.resolve({ ok: true, method: 'dom-click' });
      },
      waitForActiveEditorText: path => Promise.resolve({ ok: true, path, text: files.get(activePath) })
    },
    window: { CodexOverleafStaleGuard: staleGuard, setTimeout, clearTimeout }
  });
  const edit = (path, insert) => ({ type: 'edit', path, patches: [{ from: 0, to: 0, expected: '', insert }] });
  const result = await router.applyOperations({
    baseFiles: [...files].map(([path, content]) => ({ path, content })),
    operations: [edit('roadmap.md', 'A '), edit('Tex/Chap_05.tex', 'C '), edit('Proof.md', 'B ')]
  });
  assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped.map(entry => entry.result.code)));
  assert.deepEqual(result.applied.map(entry => entry.operation.path), ['roadmap.md', 'Proof.md', 'Tex/Chap_05.tex']);
  assert.equal(files.get('Tex/Chap_05.tex'), 'C chapter');
  assert.equal(openAttempts.get('Tex/Chap_05.tex'), 2);
});

test('a file that still cannot be opened stays skipped with its open failure', async () => {
  let activePath = 'main.tex';
  const router = writebackRouter.create({
    activeEditorIdentityChanged: () => true, compileBridge: { markSourceEdited() {} }, delay: () => Promise.resolve(),
    getActiveEditorIdentity: () => ({ doc: activePath }), normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    normalizeTextPatches, readActiveEditorText: () => 'body',
    treeOperations: { contentSignature: String, getActiveFilePath: () => activePath,
      openFileByPath: () => Promise.resolve({ ok: false, reason: 'no row' }),
      waitForActiveEditorText: () => Promise.resolve({ ok: true, text: 'body' }) },
    window: { CodexOverleafStaleGuard: staleGuard, setTimeout, clearTimeout }
  });
  const result = await router.applyOperations({ baseFiles: [{ path: 'gone.tex', content: 'body' }],
    operations: [{ type: 'edit', path: 'gone.tex', patches: [{ from: 0, to: 0, expected: '', insert: 'x' }] }] });
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].result.failure.code, 'target_file_open_failed');
  assert.equal(result.skipped[0].result.failure.changedDocument, false);
});

function singleFileRouter({ text, replace }) {
  let current = text;
  return {
    read: () => current,
    router: writebackRouter.create({
      activeEditorIdentityChanged: () => true, compileBridge: { markSourceEdited() {} }, delay: () => Promise.resolve(),
      writeVerifyWaitMs: 0, getActiveEditorIdentity: () => ({ doc: 'a' }),
      normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath, normalizeTextPatches,
      readActiveEditorText: () => current,
      replaceActiveEditorPatches(patches, next) { current = replace(current, next); return { ok: true, method: 'codemirror-view-patch' }; },
      treeOperations: { contentSignature: String, getActiveFilePath: () => 'roadmap.md',
        openFileByPath: () => Promise.resolve({ ok: true, method: 'already-active' }),
        waitForActiveEditorText: () => Promise.resolve({ ok: true, text: current }) },
      window: { CodexOverleafStaleGuard: staleGuard, setTimeout, clearTimeout }
    })
  };
}

const roadmapEdit = { type: 'edit', path: 'roadmap.md', patches: [{ from: 5, to: 9, expected: 'plan', insert: 'road' }] };

test('an edit the editor silently rejected is reported as unchanged and retryable, not as a possible change', async () => {
  const h = singleFileRouter({ text: 'Long plan text', replace: before => before });
  const result = await h.router.applyOperations({ baseFiles: [{ path: 'roadmap.md', content: 'Long plan text' }], operations: [roadmapEdit] });
  const failure = result.skipped[0].result.failure;
  assert.equal(failure.code, 'write_operation_failed');
  assert.equal(failure.changedDocument, false);
  assert.equal(failure.retryable, true);
  assert.equal(failure.evidence.observedIsBefore, true);
  assert.equal(failure.evidence.writeMethod, 'codemirror-view-patch');
});

test('a real readback mismatch keeps content-free diagnostics that locate the divergence', async () => {
  // Same length, different content — the shape seen in the field (12747 vs 12747).
  const h = singleFileRouter({ text: 'Long plan text', replace: () => 'Long roaX text' });
  const result = await h.router.applyOperations({ baseFiles: [{ path: 'roadmap.md', content: 'Long plan text' }], operations: [roadmapEdit] });
  const failure = result.skipped[0].result.failure;
  assert.equal(failure.code, 'write_observed_mismatch');
  assert.equal(failure.changedDocument, true);
  const evidence = failure.evidence;
  assert.equal(evidence.expectedLength, evidence.actualLength);
  assert.equal(evidence.firstDiffOffset, 8);
  assert.equal(evidence.expectedDiffLength, 1);
  assert.equal(evidence.actualDiffLength, 1);
  assert.match(evidence.expectedHash, /^[0-9a-f]{8}$/);
  assert.notEqual(evidence.expectedHash, evidence.actualHash);
  assert.equal(evidence.activeMatchesTarget, true);
  const stored = JSON.stringify({ ...evidence, activePath: '' });
  assert.ok(!/Long|roaX|text/.test(stored), 'no document text is stored');
});
