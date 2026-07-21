const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const failureReasons = require('../extension/src/shared/failureReasons');
const projectFiles = require('../extension/src/shared/projectFiles');
const writebackRouterModule = require('../extension/src/page/writebackRouter');
const staleGuard = require('../extension/src/shared/staleGuard');

// Welcome-panel + write-guard v1.3.8 add-on (Task 2): the writeback router
// now requires `params.runProjectId` as defense-in-depth. These existing
// failure-acceptance tests cover the §17 high-priority codes; they pre-date
// the field. We wrap `create()` to auto-inject a stable id on guarded entry
// points so the original acceptance assertions still drive the failure-code
// emit sites without touching this file's many call sites.
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

// Minimal window-shim used to satisfy writebackRouter's freshness preflight
// (`window.CodexOverleafStaleGuard.checkOperationFreshness`). The router
// guards every reference with `?.` so unrelated tests work fine with the
// default empty globalThis fallback; tests that need the stale-guard branch
// just pass this as `deps.window`.
function createWritebackWindowShim() {
  return {
    CodexOverleafStaleGuard: staleGuard,
    setTimeout,
    clearTimeout
  };
}

// --- §17.3.1: seven required user-level acceptance tests ---------------------
//
// Each of the seven user-visible failure classes from the v1.3.8 release bar
// must produce its canonical code on a real (or harness-driven) failure
// object. Source-grep alone is too weak for these — these are the release
// bar — so each test exercises the real emit site and asserts the canonical
// code on the structured `failure` payload.
//
// Codes covered:
//   - target_file_not_found
//   - target_file_open_failed
//   - target_file_not_active
//   - stale_source_changed
//   - write_observed_mismatch
//   - tracked_changes_remain OR accept_not_verified
//   - undo_not_verified

const CONTENT_RUNTIME_PATH = path.join(
  __dirname,
  '../extension/src/content/contentRuntime.js'
);
const CONTENT_RUNTIME_SOURCE = fs.readFileSync(CONTENT_RUNTIME_PATH, 'utf8');

// Extract a top-level function body from contentRuntime.js by walking the
// braces. Skips over the parameter list (handling destructured args with
// inner `{}` and parenthesized defaults) before scanning the body. Mirrors
// the helper in test/p0ProductExperience.test.js but as a minimal local
// copy so this file stays self-contained.
function extractFunctionBody(source, name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  const start = markers
    .map(marker => source.indexOf(marker))
    .filter(index => index !== -1)
    .sort((a, b) => a - b)[0] ?? -1;
  assert.notEqual(start, -1, `${name} should exist in contentRuntime.js`);
  // Walk forward past the parameter list `(...)` (depth balanced).
  const parenStart = source.indexOf('(', start);
  assert.notEqual(parenStart, -1, `${name} should have a parameter list`);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    else if (source[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  assert.notEqual(parenEnd, -1, `${name} parameter list should close`);
  const openBrace = source.indexOf('{', parenEnd);
  assert.notEqual(openBrace, -1, `${name} should have a body`);
  let depth = 0;
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body should close`);
  return '';
}

// Build a minimal harness around a set of contentRuntime helpers. We extract
// the buildContentFailure helper + its CONTENT_FAILURE_CATALOG and any
// dependent pure helpers we want to exercise. The harness fakes the i18n
// `tx` shim and exposes the helpers as a returned object.
function loadContentRuntimeHelpers(names = []) {
  const CONTENT_FAILURE_CATALOG_SRC = CONTENT_RUNTIME_SOURCE.match(
    /const CONTENT_FAILURE_CATALOG = \{[\s\S]*?\n\s*\};/
  )?.[0];
  assert.ok(
    CONTENT_FAILURE_CATALOG_SRC,
    'CONTENT_FAILURE_CATALOG declaration should exist'
  );
  const buildContentFailureSrc = extractFunctionBody(
    CONTENT_RUNTIME_SOURCE,
    'buildContentFailure'
  );
  const extracted = names
    .map(name => extractFunctionBody(CONTENT_RUNTIME_SOURCE, name))
    .join('\n');
  const exportedKeys = ['buildContentFailure', ...names];
  // Real undo-operations module so buildNoTraceUndoRestore/buildSnapshotRestoreUndo
  // resolve to their production implementations when callers need them.
  const undoOperations = require('../extension/src/shared/undoOperations');
  // Real shared catalog: buildContentFailure falls back to it for every code
  // outside the small content-local catalog (v1.7.6).
  const FailureReasons = require('../extension/src/shared/failureReasons');
  return Function(
    'undoOperations',
    'FailureReasons',
    `
    'use strict';
    function tx(english) { return english; }
    function tr(key) { return key; }
    const buildSnapshotRestoreUndo = undoOperations.buildSnapshotRestoreUndo;
    ${CONTENT_FAILURE_CATALOG_SRC}
    ${buildContentFailureSrc}
    ${extracted}
    const exported = {};
    ${exportedKeys.map(key => `exported.${key} = ${key};`).join('\n')}
    return exported;
  `
  )(undoOperations, FailureReasons);
}

// Create a single-doc writeback harness mirrored on createPageBridgeHarness
// but inlined here so the test file is self-contained. The minimal version
// only needs to surface the legacy result.code and the structured
// result.failure on apply-time skips, which is what every §17.3.1 case needs.
function createSingleFileHarness({
  activePath = 'main.tex',
  files = { 'main.tex': '' },
  pathExists = path => Object.prototype.hasOwnProperty.call(files, path),
  openFile = path => Promise.resolve({ ok: true, method: 'dom-click' }),
  dispatchApplies = true,
  applyPatches = (patches, nextContent) => {
    if (dispatchApplies) {
      files[activePath] = String(nextContent);
    }
    return { ok: true };
  },
  applyReplaceAll = text => {
    if (dispatchApplies) {
      files[activePath] = String(text);
    }
    return { ok: true };
  }
} = {}) {
  const state = { activePath, files };
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => state.files[state.activePath] || '',
    replaceActiveEditorPatches: applyPatches,
    replaceActiveEditorText: applyReplaceAll,
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => state.activePath,
      projectPathExists: pathExists,
      openFileByPath: target => {
        const result = openFile(target);
        return Promise.resolve(result).then(actual => {
          if (actual && actual.ok !== false) {
            state.activePath = target;
          }
          return actual;
        });
      }
    },
    window: { setTimeout, clearTimeout },
    writebackOpenSettleMs: 0
  });
  return { router, state };
}

// ---------------------------------------------------------------------------
// §17.3.1 — the seven release-bar acceptance tests
// ---------------------------------------------------------------------------

test('§17.3.1 — "File could not be found" → target_file_not_found', async () => {
  const { router } = createSingleFileHarness({
    activePath: 'main.tex',
    files: { 'main.tex': 'present' },
    pathExists: () => false,
    openFile: () => ({ ok: false, reason: 'path remained unavailable' })
  });

  const result = await router.applyOperations({
    operations: [{ type: 'edit', path: 'ghost.tex', replaceAll: 'x' }]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.ok(skip.result.failure, 'structured failure attached');
  assert.equal(skip.result.failure.code, 'target_file_not_found');
  assert.equal(skip.result.failure.stage, 'navigation');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.file, 'ghost.tex');
  assert.equal(failureReasons.validateFailureReason(skip.result.failure).ok, true);
});

test('§17.3.1 — "File could not be opened" → target_file_open_failed', async () => {
  const { router } = createSingleFileHarness({
    activePath: '',
    files: { 'main.tex': '' },
    pathExists: () => true,
    openFile: () => ({ ok: false, reason: 'tree click missed' })
  });

  const result = await router.applyOperations({
    operations: [{ type: 'edit', path: 'sections/intro.tex', replaceAll: 'x' }]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.ok(skip.result.failure, 'structured failure attached');
  assert.equal(skip.result.failure.code, 'target_file_open_failed');
  assert.equal(skip.result.failure.stage, 'navigation');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.file, 'sections/intro.tex');
  assert.equal(failureReasons.validateFailureReason(skip.result.failure).ok, true);
});

test('§17.3.1 — "Target file was not active at write time" → target_file_not_active', async () => {
  // openFile reports ok but the active path never moves — the §9.1
  // target_file_not_active scenario.
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => 'irrelevant',
    replaceActiveEditorPatches: () => ({ ok: true }),
    replaceActiveEditorText: () => ({ ok: true }),
    delay: () => Promise.resolve(),
    getActiveEditorIdentity: () => null,
    activeEditorIdentityChanged: () => false,
    treeOperations: {
      getActiveFilePath: () => 'wrong.tex',
      projectPathExists: () => true,
      openFileByPath: () => Promise.resolve({ ok: true, method: 'dom-click' })
    },
    window: { setTimeout, clearTimeout },
    writebackOpenSettleMs: 0
  });

  const result = await router.applyOperations({
    operations: [{ type: 'edit', path: 'target.tex', replaceAll: 'hello' }]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.ok(skip.result.failure, 'structured failure attached');
  assert.equal(skip.result.failure.code, 'target_file_not_active');
  assert.equal(skip.result.failure.stage, 'navigation');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.file, 'target.tex');
  assert.equal(skip.result.failure.activeFile, 'wrong.tex');
  assert.equal(skip.result.failure.changedDocument, false);
  assert.equal(failureReasons.validateFailureReason(skip.result.failure).ok, true);
});

test('§17.3.1 — "Source changed while Codex was working" → stale_source_changed', async () => {
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => 'user changed',
    replaceActiveEditorPatches: () => ({ ok: true }),
    replaceActiveEditorText: () => ({ ok: true }),
    // Keep the production retry loop paced. An immediate Promise turns its
    // wall-clock deadline into a busy loop and can saturate Windows CI stdout.
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
    treeOperations: {
      getActiveFilePath: () => 'main.tex',
      projectPathExists: () => true,
      openFileByPath: () => Promise.resolve({ ok: true, method: 'dom-click' })
    },
    window: createWritebackWindowShim(),
    writebackOpenSettleMs: 0
  });

  const result = await router.applyOperations({
    baseFiles: [{ path: 'main.tex', content: 'base snapshot' }],
    operations: [
      { type: 'edit', path: 'main.tex', find: 'user', replace: 'codex' }
    ]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.ok(skip.result.failure, 'structured failure attached');
  assert.equal(skip.result.failure.code, 'stale_source_changed');
  assert.equal(skip.result.failure.stage, 'preflight');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.changedDocument, false);
  assert.equal(failureReasons.validateFailureReason(skip.result.failure).ok, true);
});

test('§17.3.1 — "Write happened but post-read verification failed" → write_observed_mismatch', async () => {
  // dispatchApplies:false models a dispatch that "took" but produced no
  // actual document mutation — readback differs from expected.
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => 'alpha beta gamma',
    // The write call returns ok but does NOT mutate readActiveEditorText.
    replaceActiveEditorPatches: () => ({ ok: true }),
    replaceActiveEditorText: () => ({ ok: true }),
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => 'main.tex',
      projectPathExists: () => true,
      openFileByPath: () => Promise.resolve({ ok: true, method: 'dom-click' })
    },
    window: { setTimeout, clearTimeout },
    writebackOpenSettleMs: 0
  });

  const result = await router.applyOperations({
    baseFiles: [{ path: 'main.tex', content: 'alpha beta gamma' }],
    operations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [{ from: 6, to: 10, expected: 'beta', insert: 'delta' }]
      }
    ]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.ok(skip.result.failure, 'structured failure attached');
  assert.equal(skip.result.failure.code, 'write_observed_mismatch');
  assert.equal(skip.result.failure.stage, 'verify');
  assert.equal(skip.result.failure.severity, 'error');
  assert.equal(skip.result.failure.file, 'main.tex');
  assert.equal(skip.result.failure.changedDocument, true);
  assert.equal(failureReasons.validateFailureReason(skip.result.failure).ok, true);
});

test('§17.3.1 — "Accept could not prove Track Changes were gone" → tracked_changes_remain OR accept_not_verified', () => {
  // Two emit paths satisfy the release-bar requirement:
  //   - page-side `tracked_changes_remain` from writebackRouter when the
  //     accept replay leaves tracked-change nodes (T4 emit site, already
  //     covered by writebackRouterAccept.test.js).
  //   - content-side `accept_not_verified` from attachAcceptNotVerifiedFailure
  //     when the page bridge returned ok but proof of clean state is missing.
  // Exercise the content-side path: it owns the proof step that the T5
  // settlement matrix consumes.
  const helpers = loadContentRuntimeHelpers([
    'attachAcceptNotVerifiedFailure',
    'isAcceptResultEffectivelyVerified'
  ]);
  const run = {
    undoExpectedFiles: [{ path: 'main.tex', content: 'pre\n' }],
    undoTrackedChanges: [{ path: 'main.tex', key: 'change-1', label: 'edit' }]
  };
  // Page bridge returned ok with no applied entries — proof missing.
  const result = { ok: true, applied: [], skipped: [] };
  helpers.attachAcceptNotVerifiedFailure(run, result);

  assert.equal(result.ok, false, 'result.ok flipped to false after proof failure');
  assert.equal(result.skipped.length, 1);
  const synthetic = result.skipped[0];
  assert.ok(synthetic.result.failure, 'structured failure attached');
  assert.equal(synthetic.result.failure.code, 'accept_not_verified');
  assert.equal(synthetic.result.failure.stage, 'accept');
  assert.equal(synthetic.result.failure.severity, 'warning');
  assert.equal(synthetic.result.failure.terminalState, 'needs_review');
  assert.equal(synthetic.result.failure.changedDocument, true);
  assert.equal(synthetic.result.failure.evidence.acceptApplied, true);
  assert.equal(synthetic.result.failure.evidence.verified, false);
  assert.equal(
    failureReasons.validateFailureReason(synthetic.result.failure).ok,
    true
  );

  // Source pin: the page-side `tracked_changes_remain` emit site stays — it
  // is the other half of the release-bar OR clause and is covered in detail
  // by writebackRouterAccept.test.js.
  const writebackRouterText = fs.readFileSync(
    path.join(__dirname, '../extension/src/page/writebackRouter.js'),
    'utf8'
  );
  assert.match(writebackRouterText, /buildPageFailure\('tracked_changes_remain'/);
});

test('§17.3.1 — "Undo ran but could not be verified" → undo_not_verified', () => {
  const helpers = loadContentRuntimeHelpers([
    'attachUndoNotVerifiedFailure',
    'isUndoVerifiedContentMatching'
  ]);
  // A run whose expected pre-write content is 'pre\n'; the page bridge's
  // applied entry carries a verifiedContent that does NOT match.
  const run = {
    undoExpectedFiles: [{ path: 'main.tex', content: 'pre\n' }],
    undoOperations: [
      {
        type: 'edit',
        path: 'main.tex',
        replaceAll: 'pre\n'
      }
    ]
  };
  const result = {
    ok: true,
    applied: [
      {
        operation: { type: 'edit', path: 'main.tex' },
        result: { ok: true, verifiedContent: 'something else\n' }
      }
    ],
    skipped: []
  };
  helpers.attachUndoNotVerifiedFailure(run, result);

  assert.equal(result.ok, false, 'result.ok flipped to false after proof failure');
  assert.equal(result.skipped.length, 1);
  const synthetic = result.skipped[0];
  assert.ok(synthetic.result.failure, 'structured failure attached');
  assert.equal(synthetic.result.failure.code, 'undo_not_verified');
  assert.equal(synthetic.result.failure.stage, 'undo');
  assert.equal(synthetic.result.failure.severity, 'warning');
  assert.equal(synthetic.result.failure.terminalState, 'needs_review');
  assert.equal(synthetic.result.failure.changedDocument, true);
  assert.equal(synthetic.result.failure.evidence.undoApplied, true);
  assert.equal(synthetic.result.failure.evidence.verified, false);
  assert.equal(
    failureReasons.validateFailureReason(synthetic.result.failure).ok,
    true
  );
});

// ---------------------------------------------------------------------------
// Content-side emitter behavior tests (T5 Half B supporting cases)
// ---------------------------------------------------------------------------

test('content-side emits project_snapshot_unavailable when initial snapshot fails (source + helper)', () => {
  // Behavior: when getProjectSnapshotWarnings reports blocking entries and
  // no warm mirror or focused-partial path applies, runTask synthesizes a
  // project_snapshot_unavailable failure and threads it through both the
  // run-card completion report and the audit record.
  const runTaskBody = extractFunctionBody(CONTENT_RUNTIME_SOURCE, 'runTask');
  assert.match(
    runTaskBody,
    /buildContentFailure\('project_snapshot_unavailable'/,
    'runTask emits project_snapshot_unavailable on blocking snapshot warnings'
  );
  assert.match(
    runTaskBody,
    /fetchFailed:\s*true/,
    'evidence.fetchFailed:true per §9.0 evidence shape'
  );
  // Behavior: the failure passes validation when built by the helper.
  const helpers = loadContentRuntimeHelpers([]);
  const failure = helpers.buildContentFailure(
    'project_snapshot_unavailable',
    null,
    { evidence: { fetchFailed: true, fileCount: 0 } }
  );
  assert.ok(failure);
  assert.equal(failure.code, 'project_snapshot_unavailable');
  assert.equal(failure.stage, 'context');
  assert.equal(failure.severity, 'error');
  assert.equal(failureReasons.validateFailureReason(failure).ok, true);
});

test('content-side emits selected_context_unresolved when @-context resolution fails (source + helper)', () => {
  const runTaskBody = extractFunctionBody(CONTENT_RUNTIME_SOURCE, 'runTask');
  assert.match(
    runTaskBody,
    /buildContentFailure\('selected_context_unresolved'/,
    'runTask emits selected_context_unresolved on @-context resolve failure'
  );
  assert.match(
    runTaskBody,
    /contextTarget:\s*['"]@compile-log['"]/,
    'evidence.contextTarget identifies the unresolved @-token'
  );
  const helpers = loadContentRuntimeHelpers([]);
  const failure = helpers.buildContentFailure(
    'selected_context_unresolved',
    null,
    { evidence: { contextTarget: '@compile-log' } }
  );
  assert.ok(failure);
  assert.equal(failure.code, 'selected_context_unresolved');
  assert.equal(failure.stage, 'context');
  assert.equal(failure.severity, 'warning');
  assert.equal(failureReasons.validateFailureReason(failure).ok, true);
});

test('content-side emits codex_no_usable_result when native bridge returns nothing usable', () => {
  // The runtime detects both shapes:
  //   1. response.ok === false with a non-bridge error → codex_no_usable_result.
  //   2. response.ok === true but the result is empty of assistantMessage,
  //      syncChanges, and unsupportedChanges → codex_no_usable_result.
  const helpers = loadContentRuntimeHelpers([
    'hasUsableCodexResult',
    'isNativeBridgeUnavailableError'
  ]);

  // Empty result → not usable.
  assert.equal(
    helpers.hasUsableCodexResult({
      assistantMessage: '',
      syncChanges: [],
      result: {}
    }),
    false
  );
  // Whitespace-only assistant message → still not usable.
  assert.equal(
    helpers.hasUsableCodexResult({
      assistantMessage: '   \n  ',
      syncChanges: [],
      result: {}
    }),
    false
  );
  // Any sync change → usable.
  assert.equal(
    helpers.hasUsableCodexResult({
      assistantMessage: '',
      syncChanges: [{ path: 'main.tex' }],
      result: {}
    }),
    true
  );
  // An unsupportedChanges payload → usable (Codex tried to do something).
  assert.equal(
    helpers.hasUsableCodexResult({
      assistantMessage: '',
      syncChanges: [],
      result: { unsupportedChanges: [{ type: 'binary' }] }
    }),
    true
  );

  // A Codex-side error is NOT a bridge-availability error.
  assert.equal(
    helpers.isNativeBridgeUnavailableError({
      code: 'codex_error',
      message: 'Codex blew up'
    }),
    false
  );

  // Source: the empty-result path emits the canonical code with §9.7 evidence.
  const runTaskBody = extractFunctionBody(CONTENT_RUNTIME_SOURCE, 'runTask');
  assert.match(
    runTaskBody,
    /buildContentFailure\('codex_no_usable_result'/,
    'runTask emits codex_no_usable_result'
  );
  assert.match(runTaskBody, /hasFinalReport:/);

  // The catalog entry validates.
  const helpers2 = loadContentRuntimeHelpers([]);
  const failure = helpers2.buildContentFailure(
    'codex_no_usable_result',
    { path: 'codex.run' },
    { evidence: { hasFinalReport: false, syncChangeCount: 0 } }
  );
  assert.ok(failure);
  assert.equal(failure.code, 'codex_no_usable_result');
  assert.equal(failure.stage, 'codex');
  assert.equal(failure.severity, 'error');
  assert.equal(failureReasons.validateFailureReason(failure).ok, true);
});

test('content-side emits storage_quota_exceeded when persistence raises a quota error', () => {
  const saveStateBody = extractFunctionBody(CONTENT_RUNTIME_SOURCE, 'saveState');
  // The catch path dispatches to emitStorageQuotaFailure when isStorageQuotaError matches.
  assert.match(saveStateBody, /isStorageQuotaError\(error\)/);
  assert.match(saveStateBody, /emitStorageQuotaFailure\(/);
  // The emitter builds via buildContentFailure with §9.8 evidence.
  const emitBody = extractFunctionBody(
    CONTENT_RUNTIME_SOURCE,
    'emitStorageQuotaFailure'
  );
  assert.match(emitBody, /buildContentFailure\('storage_quota_exceeded'/);
  assert.match(emitBody, /quotaExceeded:\s*true/);

  // The catalog entry validates when built with realistic evidence.
  const helpers = loadContentRuntimeHelpers([]);
  const failure = helpers.buildContentFailure(
    'storage_quota_exceeded',
    null,
    { technicalMessage: 'QuotaExceededError', evidence: { quotaExceeded: true } }
  );
  assert.ok(failure);
  assert.equal(failure.code, 'storage_quota_exceeded');
  assert.equal(failure.stage, 'storage');
  assert.equal(failure.severity, 'warning');
  assert.equal(failureReasons.validateFailureReason(failure).ok, true);
});

test('content-side emits native_bridge_unavailable when bridge is disconnected', () => {
  const helpers = loadContentRuntimeHelpers([
    'isNativeBridgeUnavailableError'
  ]);
  // Canonical bridge-availability codes.
  for (const code of [
    'native_connection_failed',
    'native_unavailable',
    'native_update_required',
    'native_missing'
  ]) {
    assert.equal(
      helpers.isNativeBridgeUnavailableError({ code, message: 'x' }),
      true,
      `${code} should be classified as bridge unavailable`
    );
  }
  // v1.7.5: an interrupted in-flight request means the host IS installed —
  // it maps to native_request_failed (retry), never to "reinstall the bridge".
  assert.equal(
    helpers.isNativeBridgeUnavailableError({ code: 'native_execution_interrupted', message: 'x' }),
    false,
    'native_execution_interrupted must NOT read as bridge-unavailable'
  );
  // Text-shape match for Chrome's lastError wrapping.
  assert.equal(
    helpers.isNativeBridgeUnavailableError({
      code: '',
      message: 'Native host disconnected while a request was running.'
    }),
    true
  );
  // Codex-side errors are NOT bridge-availability errors.
  assert.equal(
    helpers.isNativeBridgeUnavailableError({
      code: 'codex_runtime',
      message: 'Codex internal panic'
    }),
    false
  );

  // Source: the !response.ok branch emits native_bridge_unavailable when
  // the error matches a bridge-availability shape; otherwise emits
  // codex_no_usable_result.
  const runTaskBody = extractFunctionBody(CONTENT_RUNTIME_SOURCE, 'runTask');
  assert.match(runTaskBody, /isNativeBridgeUnavailableError\(response\.error\)/);
  assert.match(runTaskBody, /buildContentFailure\('native_bridge_unavailable'/);
  assert.match(runTaskBody, /handshakeFailed:\s*true/);

  const failure = helpers.isNativeBridgeUnavailableError({ code: 'native_connection_failed', message: '' });
  assert.equal(failure, true);

  // The catalog entry validates.
  const helpers2 = loadContentRuntimeHelpers([]);
  const built = helpers2.buildContentFailure(
    'native_bridge_unavailable',
    { path: 'codex.run' },
    { evidence: { handshakeFailed: true } }
  );
  assert.ok(built);
  assert.equal(built.code, 'native_bridge_unavailable');
  assert.equal(built.stage, 'native');
  assert.equal(built.severity, 'blocked');
  assert.equal(failureReasons.validateFailureReason(built).ok, true);
});

// ---------------------------------------------------------------------------
// Settlement-matrix coverage for the synthesized proof failures.
// ---------------------------------------------------------------------------

test('attachUndoNotVerifiedFailure no-ops when the page bridge already returned skipped failures', () => {
  const helpers = loadContentRuntimeHelpers([
    'attachUndoNotVerifiedFailure',
    'isUndoVerifiedContentMatching'
  ]);
  const run = {
    undoExpectedFiles: [{ path: 'main.tex', content: 'pre\n' }],
    undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: 'pre\n' }]
  };
  const result = {
    ok: false,
    applied: [],
    skipped: [
      {
        trackedChange: { path: 'main.tex', key: 'change-1' },
        result: { ok: false, code: 'tracked_changes_remain' }
      }
    ]
  };
  helpers.attachUndoNotVerifiedFailure(run, result);
  // The pre-existing skipped entry is the authoritative failure; the proof
  // step must not add a duplicate synthetic.
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'tracked_changes_remain');
});

test('attachAcceptNotVerifiedFailure no-ops when the page bridge already returned skipped failures', () => {
  const helpers = loadContentRuntimeHelpers([
    'attachAcceptNotVerifiedFailure',
    'isAcceptResultEffectivelyVerified'
  ]);
  const run = {
    undoExpectedFiles: [{ path: 'main.tex', content: 'pre\n' }],
    undoTrackedChanges: [{ path: 'main.tex', key: 'change-1' }]
  };
  const result = {
    ok: false,
    applied: [],
    skipped: [
      {
        trackedChange: { path: 'main.tex', key: 'change-1' },
        result: { ok: false, code: 'tracked_changes_remain' }
      }
    ]
  };
  helpers.attachAcceptNotVerifiedFailure(run, result);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'tracked_changes_remain');
});

test('attachAcceptNotVerifiedFailure no-ops when every tracked change shows up in applied with ok:true', () => {
  const helpers = loadContentRuntimeHelpers([
    'attachAcceptNotVerifiedFailure',
    'isAcceptResultEffectivelyVerified'
  ]);
  const run = {
    undoExpectedFiles: [{ path: 'main.tex', content: 'pre\n' }],
    undoTrackedChanges: [{ path: 'main.tex', key: 'change-1' }]
  };
  const result = {
    ok: true,
    applied: [
      {
        trackedChange: { path: 'main.tex', key: 'change-1' },
        result: { ok: true }
      }
    ],
    skipped: []
  };
  helpers.attachAcceptNotVerifiedFailure(run, result);
  assert.equal(result.ok, true);
  assert.equal(result.skipped.length, 0);
});

test('attachUndoNotVerifiedFailure no-ops when every expected path verifies back to pre-run content', () => {
  const helpers = loadContentRuntimeHelpers([
    'attachUndoNotVerifiedFailure',
    'isUndoVerifiedContentMatching'
  ]);
  const run = {
    undoExpectedFiles: [{ path: 'main.tex', content: 'pre\n' }],
    undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: 'pre\n' }]
  };
  const result = {
    ok: true,
    applied: [
      {
        operation: { type: 'edit', path: 'main.tex' },
        result: { ok: true, verifiedContent: 'pre\n' }
      }
    ],
    skipped: []
  };
  helpers.attachUndoNotVerifiedFailure(run, result);
  assert.equal(result.ok, true);
  assert.equal(result.skipped.length, 0);
});

test('buildContentFailure resolves shared-catalog codes so their recovery buttons are reachable (v1.7.6 fleet P1)', () => {
  // The content-local catalog only holds 8 codes. Every other emitted code
  // (codex_not_found, codex_timeout, ...) must resolve through the shared
  // §9 catalog — before v1.7.6 buildContentFailure returned null for them,
  // so completion reports carried no structured failure and the
  // recovery-action registry never fired.
  const helpers = loadContentRuntimeHelpers();
  for (const code of ['codex_not_found', 'codex_timeout', 'codex_output_limit', 'stale_source_changed', 'native_protocol_incompatible']) {
    const failure = helpers.buildContentFailure(code, { path: 'task' }, {});
    assert.ok(failure, `${code} must resolve through the shared catalog`);
    assert.equal(failure.code, code);
    assert.ok(failure.userMessage, `${code} carries the catalog fallback user message`);
    assert.equal(typeof failure.retryable, 'boolean');
  }
  // Content-local codes keep winning, unknown codes still return null.
  assert.ok(helpers.buildContentFailure('codex_project_locked', {}, {}));
  assert.equal(helpers.buildContentFailure('some_unknown_code', {}, {}), null);
});
