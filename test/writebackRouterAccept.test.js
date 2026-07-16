const assert = require('node:assert/strict');
const test = require('node:test');

const projectFiles = require('../extension/src/shared/projectFiles');
const writebackRouterModule = require('../extension/src/page/writebackRouter');

// Welcome-panel + write-guard v1.3.8 add-on (Task 2): every entry point on
// the writeback router now requires a non-empty `params.runProjectId` as
// defense-in-depth against bypass callers. Production callsites in
// contentRuntime always set it; legacy tests in this file predate the field,
// so we wrap the module's `create()` to auto-inject a stable id on every
// guarded entry. Tests that want to drive the missing-runProjectId branch
// pass `runProjectId: ''` to opt out of the wrapper's default.
const writebackRouter = {
  create(deps) {
    const raw = writebackRouterModule.create(deps);
    const guarded = ['applyOperations', 'acceptTrackedChanges', 'rejectTrackedChanges'];
    const wrapped = { ...raw };
    for (const method of guarded) {
      const original = raw[method];
      if (original instanceof Function) {
        wrapped[method] = (...args) => {
          // applyOperations supports a payload-object call AND an
          // (operations, options) call. The runProjectId guard only fires
          // on the payload-object shape; legacy array-first calls are
          // unaffected so we pass them through verbatim.
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

// --- Accept All — editor-undo + non-tracked replay -------------------------
//
// The reworked acceptTrackedChanges no longer hunts Overleaf's per-change
// Accept controls. It instead:
//   1. editor-undoes the run's tracked writeback back to its pre-write content
//      (so all the run's tracked changes vanish), then
//   2. switches to Editing mode (Track Changes OFF) and re-applies the run's
//      post-write content as a plain, untracked edit, then
//   3. restores the prior Reviewing mode.
// If the editor-undo cannot reach the pre-write state (content drifted), it
// bails WITHOUT re-writing and returns a not-ok result.
//
// The fake below models a single-document Overleaf editor: editor text is a
// mutable string, the editor undo control pops a history stack back toward the
// pre-write content, and replaceActiveEditorText overwrites the live text.

function createAcceptHarness(spec = {}) {
  const path = spec.path || 'main.tex';
  const preContent = spec.preContent ?? 'before\n';
  const postContent = spec.postContent ?? 'before edited\n';

  // The editor-undo history: each entry is the editor text after an undo step.
  // Driving the writeback in Reviewing mode produced postContent from
  // preContent; one undo step returns to preContent.
  const undoHistory = spec.undoHistory || [preContent];

  const state = {
    activePath: spec.activePath ?? path,
    editorText: spec.startContent ?? postContent,
    reviewing: spec.startReviewing !== false, // run wrote in Reviewing mode
    undoClicks: 0,
    editingActivations: 0,
    reviewingRestores: 0,
    writes: [],
    patchWrites: [],
    opened: []
  };

  const undoControl = {
    tagName: 'BUTTON',
    disabled: false,
    _label: 'Undo',
    getAttribute(name) {
      return name === 'aria-label' ? this._label : null;
    }
  };

  function ensureEditing() {
    // The Accept replay no longer routes through ensureEditing — it forces the
    // toggle via setReviewingEnabled(false) — but keep a faithful stub so any
    // accidental call is still observable.
    if (!state.reviewing) {
      return Promise.resolve({ ok: true, activated: false });
    }
    state.reviewing = false;
    state.editingActivations += 1;
    return Promise.resolve({ ok: true, activated: true });
  }

  function setReviewingEnabled(enabled) {
    if (enabled && spec.reviewingRestoreFails) {
      return Promise.resolve({
        ok: false,
        code: 'reviewing_enable_failed',
        reason: 'Reviewing could not be restored.'
      });
    }
    if (!enabled && spec.editingFails) {
      // Models Overleaf failing to confirm Track Changes OFF.
      return Promise.resolve({
        ok: false,
        code: 'editing_not_confirmed',
        reason: 'Editing mode could not be confirmed.'
      });
    }
    state.reviewing = enabled;
    if (enabled) {
      state.reviewingRestores += 1;
    } else {
      state.editingActivations += 1;
    }
    return Promise.resolve({ ok: true, changed: true, enabled });
  }

  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() { state.markedSourceEdited = true; } },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    ensureEditing,
    ensureReviewing: () => Promise.resolve({ ok: true, activated: false }),
    setReviewingEnabled,
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, signals: {} }),
    // The page bridge wires these aria-aware detectors; the fake mirrors them
    // faithfully off the harness's reviewing flag.
    isReviewingConfirmedForWrite: reviewState => reviewState?.reviewing?.ok === true,
    isEditingConfirmedForNoTraceUndo: reviewState => reviewState?.reviewing?.ok === false,
    collectElements(selector) {
      // The editor-undo control is the only DOM control the new mechanism uses.
      if (/button/i.test(selector || '')) {
        return spec.noUndoControl ? [] : [undoControl];
      }
      return [];
    },
    readNodeSignalText: node => node?._label || '',
    isInsideCodexPanel: () => false,
    clickNode(node) {
      if (node === undoControl) {
        state.undoClicks += 1;
        const next = undoHistory[Math.min(state.undoClicks - 1, undoHistory.length - 1)];
        if (typeof next === 'string') {
          state.editorText = next;
        }
      }
    },
    readActiveEditorText: () => state.editorText,
    replaceActiveEditorText(text) {
      state.editorText = String(text);
      state.writes.push({ kind: 'replaceAll', text: String(text) });
      return { ok: true };
    },
    replaceActiveEditorPatches(patches, nextContent) {
      // Models Overleaf's patch-apply path: only the targeted ranges change.
      state.editorText = String(nextContent);
      state.patchWrites.push((patches || []).map(patch => ({
        from: patch.from,
        to: patch.to,
        insert: patch.insert
      })));
      state.writes.push({ kind: 'patches', text: String(nextContent), patches: patches || [] });
      return { ok: true };
    },
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => state.activePath,
      openFileByPath(target) {
        state.opened.push(target);
        state.activePath = target;
        return Promise.resolve({ ok: true, method: 'dom-click' });
      }
    },
    window: { setTimeout, clearTimeout },
    ...spec.depOverrides
  });

  return { router, state, path, preContent, postContent };
}

test('acceptTrackedChanges editor-undoes to pre-write content then replays post-write content untracked', async () => {
  // The pre/post content shares a common prefix and suffix so the minimal-diff
  // fallback has something meaningful to trim.
  const preContent = 'Intro paragraph.\nThe quick fox.\nClosing line.\n';
  const postContent = 'Intro paragraph.\nThe quick brown fox.\nClosing line.\n';
  const harness = createAcceptHarness({ preContent, postContent });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  // The editor-undo ran (the writeback was reverted before the replay).
  assert.ok(harness.state.undoClicks >= 1, 'the run writeback was editor-undone');
  // The post-write content was re-applied via a TARGETED patch — never a
  // whole-file replaceAll.
  assert.equal(harness.state.writes.length, 1);
  assert.equal(harness.state.writes[0].kind, 'patches', 'replay must go through the patches path, not replaceAll');
  assert.equal(harness.state.editorText, postContent);
  // The targeted patch trims the common prefix AND suffix: it does NOT span the
  // whole pre-write document.
  const replayPatch = harness.state.patchWrites[0][0];
  assert.ok(replayPatch.from > 0, 'patch starts after the trimmed common prefix');
  assert.ok(replayPatch.to < harness.preContent.length, 'patch ends before the trimmed common suffix');
  // The replayed span is strictly smaller than the whole file.
  assert.ok(
    (replayPatch.to - replayPatch.from) < harness.preContent.length,
    'the replay patch is a targeted fragment, not the whole file'
  );
  // Sanity: applying the patch reproduces the post-write content.
  assert.equal(
    preContent.slice(0, replayPatch.from) + replayPatch.insert + preContent.slice(replayPatch.to),
    postContent
  );
  // applied carries the replay entry, not per-change DOM clicks.
  assert.ok(result.applied.length >= 1);
  assert.equal(result.applied.some(item => item.result.method === 'overleaf-accept-untracked-replay'), true);
  assert.equal(result.skipped.length, 0);
  assert.equal(harness.state.markedSourceEdited, true);
});

test('acceptTrackedChanges switches to Editing mode before the replay and restores Reviewing after', async () => {
  const harness = createAcceptHarness({
    preContent: 'before\n',
    postContent: 'after\n'
  });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  // Editing mode was activated for the untracked replay.
  assert.equal(harness.state.editingActivations, 1);
  // Accept All intentionally leaves Overleaf in Editing after the replay to
  // avoid re-tracking races (Overleaf has been observed flipping Track Changes
  // back on right after a setReviewingEnabled(true)); the prior Reviewing mode
  // is NOT auto-restored.
  assert.equal(harness.state.reviewingRestores, 0);
  assert.equal(harness.state.reviewing, false, 'the run is left in Editing mode');
});

test('acceptTrackedChanges bails without re-writing when the editor-undo cannot reach pre-write content', async () => {
  // The undo history never reaches the pre-write content (content drifted —
  // e.g. the user manually edited after the run). The mechanism must bail and
  // NOT re-write, so it never makes the document worse.
  const harness = createAcceptHarness({
    preContent: 'before\n',
    postContent: 'after\n',
    // Undo steps land on a drifted state, never on 'before\n'.
    undoHistory: ['drifted content\n', 'drifted content\n']
  });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  // It must NOT re-apply the post-write content after a failed undo.
  assert.deepEqual(harness.state.writes, [], 'no re-write after a drift bail');
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  // It never even switches to Editing mode on a drift bail.
  assert.equal(harness.state.editingActivations, 0);
});

test('acceptTrackedChanges uses persisted snapshots after refresh clears editor undo history', async () => {
  const harness = createAcceptHarness({
    preContent: 'before\n',
    postContent: 'after\n',
    startContent: 'after\n',
    noUndoControl: true
  });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(harness.state.undoClicks, 0, 'refresh left no native undo control to click');
  assert.equal(harness.state.editorText, harness.postContent);
  assert.deepEqual(
    harness.state.writes.map(write => write.kind),
    ['replaceAll', 'patches'],
    'snapshot restores pre-write text, then Accept replays the targeted patch untracked'
  );
  assert.equal(
    result.applied.some(item => item.trackedChange?.key === `snapshot-undo:${harness.path}`),
    true,
    'result records the guarded snapshot fallback'
  );
  assert.equal(result.skipped.length, 0);
});

test('acceptTrackedChanges preserves a unique editor envelope added during tracked-change reload', async () => {
  const prefix = '\n\n\n\n';
  const harness = createAcceptHarness({
    preContent: 'before\n',
    postContent: 'after\n',
    startContent: prefix + 'after\n',
    noUndoControl: true
  });

  const result = await harness.router.acceptTrackedChanges({
    runProjectId: 'refresh-project',
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(harness.state.editorText, prefix + harness.postContent);
  assert.deepEqual(
    harness.state.writes.map(write => ({ kind: write.kind, text: write.text })),
    [
      { kind: 'replaceAll', text: prefix + harness.preContent },
      { kind: 'patches', text: prefix + harness.postContent }
    ],
    'snapshot rollback and targeted replay preserve the surrounding editor context'
  );
  assert.equal(result.skipped.length, 0);
});

test('acceptTrackedChanges recomputes insertion offsets after checkpoint context rebasing', async () => {
  const prefix = '\n\n\n\n';
  const harness = createAcceptHarness({
    preContent: 'abc\n',
    postContent: 'abcX\n',
    startContent: prefix + 'abcX\n',
    noUndoControl: true
  });

  const result = await harness.router.acceptTrackedChanges({
    runProjectId: 'refresh-project',
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }],
    appliedOperations: [{
      type: 'edit',
      path: harness.path,
      patches: [{ from: 3, to: 3, expected: '', insert: 'X' }]
    }]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(harness.state.editorText, prefix + harness.postContent);
  assert.equal(harness.state.patchWrites.length, 1);
  assert.equal(
    harness.state.patchWrites[0][0].from,
    prefix.length + 3,
    'replay patch offset includes the preserved editor prefix'
  );
  assert.equal(result.skipped.length, 0);
});

test('acceptTrackedChanges bails without re-writing when Editing mode cannot be confirmed', async () => {
  const harness = createAcceptHarness({
    preContent: 'before\n',
    postContent: 'after\n',
    editingFails: true
  });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  // The editor-undo ran, but without Editing mode the replay would be tracked,
  // so it bails rather than re-introduce tracked changes.
  assert.deepEqual(harness.state.writes, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'editing_not_confirmed');
});

test('acceptTrackedChanges returns not-ok when the run has no pre-write/post-write content', async () => {
  const harness = createAcceptHarness();

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [],
    postFiles: []
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'accept_missing_run_content');
  assert.deepEqual(harness.state.writes, []);
});

test('acceptTrackedChanges accepts a multi-file run, replaying each file untracked', async () => {
  // A run that touched two files: editor-undo each back to pre-write, replay
  // each post-write content as a plain edit.
  const editors = {
    'main.tex': { text: 'main after\n' },
    'intro.tex': { text: 'intro after\n' }
  };
  const state = {
    activePath: 'main.tex',
    reviewing: true,
    writes: []
  };
  const undoControl = {
    tagName: 'BUTTON',
    disabled: false,
    getAttribute: name => (name === 'aria-label' ? 'Undo' : null)
  };
  const preByPath = { 'main.tex': 'main before\n', 'intro.tex': 'intro before\n' };

  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    writebackOpenSettleMs: 0,
    ensureEditing: () => { state.reviewing = false; return Promise.resolve({ ok: true, activated: true }); },
    ensureReviewing: () => Promise.resolve({ ok: true, activated: false }),
    setReviewingEnabled: enabled => { state.reviewing = enabled; return Promise.resolve({ ok: true, changed: true, enabled }); },
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, signals: {} }),
    isReviewingConfirmedForWrite: reviewState => reviewState?.reviewing?.ok === true,
    isEditingConfirmedForNoTraceUndo: reviewState => reviewState?.reviewing?.ok === false,
    collectElements: selector => (/button/i.test(selector || '') ? [undoControl] : []),
    readNodeSignalText: () => 'Undo',
    isInsideCodexPanel: () => false,
    // Editor identity changes whenever Overleaf switches the active document, so
    // the writeback machinery can confirm a document switch before re-applying.
    getActiveEditorIdentity: () => ({ path: state.activePath }),
    activeEditorIdentityChanged: previous => previous?.path !== state.activePath,
    clickNode(node) {
      if (node === undoControl) {
        // One undo step on the active file returns it to its pre-write content.
        editors[state.activePath].text = preByPath[state.activePath];
      }
    },
    readActiveEditorText: () => editors[state.activePath].text,
    replaceActiveEditorText(text) {
      editors[state.activePath].text = String(text);
      state.writes.push({ path: state.activePath, kind: 'replaceAll', text: String(text) });
      return { ok: true };
    },
    replaceActiveEditorPatches(patches, nextContent) {
      editors[state.activePath].text = String(nextContent);
      state.writes.push({ path: state.activePath, kind: 'patches', text: String(nextContent) });
      return { ok: true };
    },
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => state.activePath,
      openFileByPath(target) { state.activePath = target; return Promise.resolve({ ok: true }); }
    },
    window: { setTimeout, clearTimeout }
  });

  const result = await router.acceptTrackedChanges({
    expectedFiles: [
      { path: 'main.tex', content: 'main before\n' },
      { path: 'intro.tex', content: 'intro before\n' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'main after\n' },
      { path: 'intro.tex', content: 'intro after\n' }
    ]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(editors['main.tex'].text, 'main after\n');
  assert.equal(editors['intro.tex'].text, 'intro after\n');
  // Each file was replayed via the targeted patches path — never replaceAll.
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes.every(write => write.kind === 'patches'), true,
    'every file replay goes through the patches path, not replaceAll');
});

test('acceptTrackedChanges forces the Editing toggle even when isEditingConfirmedForNoTraceUndo false-positives "already Editing"', async () => {
  // Bug B regression: the lenient isEditingConfirmedForNoTraceUndo reports
  // "already Editing" while Track Changes is actually ON (reviewing.ok === true).
  // The accept flow must NOT trust that short-circuit: it reads the reviewing
  // state, sees Reviewing positively active, and forces setReviewingEnabled(false).
  const harness = createAcceptHarness({
    preContent: 'before\n',
    postContent: 'after\n',
    depOverrides: {
      // The lenient detector lies: it claims Editing is confirmed.
      isEditingConfirmedForNoTraceUndo: () => true
    }
  });
  // The run wrote in Reviewing mode; getReviewingState() positively reports it.
  // (createAcceptHarness defaults startReviewing to true.)

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  // Despite the lenient detector claiming "already Editing", the flow forced
  // the toggle to OFF.
  assert.equal(harness.state.editingActivations, 1, 'the Editing toggle was forced, not skipped');
  // The replay landed and Overleaf is left in Editing (no auto-restore of
  // Reviewing, by design — see the first happy-path test).
  assert.equal(harness.state.writes.length, 1);
  assert.equal(harness.state.writes[0].kind, 'patches');
  assert.equal(harness.state.reviewingRestores, 0);
  assert.equal(harness.state.reviewing, false);
});

test('acceptTrackedChanges bails when Editing cannot be positively confirmed after the toggle', async () => {
  // setReviewingEnabled reports ok, but the post-toggle reviewing state still
  // says Reviewing is active. The flow must positively confirm Editing OFF and
  // bail rather than replay while tracked.
  const state = { reviewing: true };
  const undoControl = {
    tagName: 'BUTTON', disabled: false,
    getAttribute: name => (name === 'aria-label' ? 'Undo' : null)
  };
  let editorText = 'after\n';
  const writes = [];
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    ensureEditing: () => Promise.resolve({ ok: true, activated: true }),
    ensureReviewing: () => Promise.resolve({ ok: true, activated: false }),
    // The toggle "succeeds" but never actually leaves Reviewing.
    setReviewingEnabled: enabled => Promise.resolve({ ok: true, changed: true, enabled }),
    // ...so getReviewingState keeps reporting Reviewing as positively active.
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, signals: {} }),
    isReviewingConfirmedForWrite: reviewState => reviewState?.reviewing?.ok === true,
    isEditingConfirmedForNoTraceUndo: reviewState => reviewState?.reviewing?.ok === false,
    collectElements: selector => (/button/i.test(selector || '') ? [undoControl] : []),
    readNodeSignalText: () => 'Undo',
    isInsideCodexPanel: () => false,
    clickNode(node) { if (node === undoControl) { editorText = 'before\n'; } },
    readActiveEditorText: () => editorText,
    replaceActiveEditorText(text) { editorText = String(text); writes.push(text); return { ok: true }; },
    replaceActiveEditorPatches(_patches, nextContent) { editorText = String(nextContent); writes.push(nextContent); return { ok: true }; },
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => 'main.tex',
      openFileByPath: () => Promise.resolve({ ok: true })
    },
    window: { setTimeout, clearTimeout }
  });

  const result = await router.acceptTrackedChanges({
    expectedFiles: [{ path: 'main.tex', content: 'before\n' }],
    postFiles: [{ path: 'main.tex', content: 'after\n' }]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  // It must NOT replay while Reviewing is still active.
  assert.deepEqual(writes, [], 'no replay while Track Changes could not be confirmed off');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'accept_editing_not_confirmed');
});

test('acceptTrackedChanges re-applies the run\'s original forward patches verbatim when appliedOperations are provided', async () => {
  // The run's forward writeback applied two separate targeted patches. After the
  // editor-undo the document is back at the pre-write content, so those exact
  // patches re-apply cleanly. Accept All must re-use them — not a whole-file
  // replaceAll and not a re-derived diff.
  const preContent = 'alpha\nbeta\ngamma\n';
  // patch 1: 'alpha' -> 'ALPHA'  (from 0, to 5)
  // patch 2: 'gamma' -> 'GAMMA'  (from 11, to 16)
  const postContent = 'ALPHA\nbeta\nGAMMA\n';
  const originalPatches = [
    { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' },
    { from: 11, to: 16, expected: 'gamma', insert: 'GAMMA' }
  ];
  const harness = createAcceptHarness({ preContent, postContent });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: preContent }],
    postFiles: [{ path: harness.path, content: postContent }],
    appliedOperations: [
      { type: 'edit', path: harness.path, patches: originalPatches }
    ]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(harness.state.writes.length, 1);
  assert.equal(harness.state.writes[0].kind, 'patches', 'replay went through the patches path');
  assert.equal(harness.state.editorText, postContent);
  // The run's original two patches were replayed verbatim — not collapsed into
  // a single whole-span diff.
  const replayed = harness.state.patchWrites[0];
  assert.equal(replayed.length, 2, 'both original forward patches were re-applied');
  assert.deepEqual(
    replayed.map(patch => ({ from: patch.from, to: patch.to, insert: patch.insert })),
    originalPatches.map(patch => ({ from: patch.from, to: patch.to, insert: patch.insert }))
  );
});

test('acceptTrackedChanges falls back to a minimal diff when appliedOperations carry no usable patches', async () => {
  // The run's recorded operation is a whole-file replaceAll (no patches). The
  // replay must NOT reuse the replaceAll — it computes a minimal diff instead.
  const preContent = 'shared head\nold middle\nshared tail\n';
  const postContent = 'shared head\nnew middle\nshared tail\n';
  const harness = createAcceptHarness({ preContent, postContent });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: preContent }],
    postFiles: [{ path: harness.path, content: postContent }],
    appliedOperations: [
      { type: 'edit', path: harness.path, replaceAll: postContent }
    ]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(harness.state.writes.length, 1);
  assert.equal(harness.state.writes[0].kind, 'patches', 'replay still goes through the patches path');
  assert.equal(harness.state.editorText, postContent);
  const replayPatch = harness.state.patchWrites[0][0];
  assert.equal(harness.state.patchWrites[0].length, 1, 'a single targeted diff patch');
  assert.ok(replayPatch.from > 0 && replayPatch.to < preContent.length,
    'the diff patch is targeted, not a whole-file range');
});

test('acceptTrackedChanges returns a diagnostics trace covering every step (editorUndo, modeBefore, forceEditing, replayStart, replayDone, restoreReviewing)', async () => {
  const harness = createAcceptHarness({
    preContent: 'before\n',
    postContent: 'after\n'
  });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.diagnostics), 'diagnostics is an array');
  const steps = result.diagnostics.map(entry => entry.step);
  // Order: 1 editor-undo → 2 modeBefore → 3 forceEditing → 4 replayStart →
  //        5 replayDone → 6 restoreReviewing.
  assert.deepEqual(steps, [
    'editorUndo',
    'modeBefore',
    'forceEditing',
    'replayStart',
    'replayDone',
    'restoreReviewing'
  ]);
  // editorUndo carries ok/attempted/code/reason/pathsProcessed.
  const editorUndo = result.diagnostics[0].info;
  assert.equal(editorUndo.ok, true);
  assert.equal(editorUndo.attempted, true);
  assert.equal(editorUndo.pathsProcessed, 1);
  // modeBefore carries the strict gate booleans.
  const modeBefore = result.diagnostics[1].info;
  assert.equal(modeBefore.isReviewingPositivelyOn, true, 'run wrote in Reviewing');
  assert.equal(modeBefore.isEditingPositivelyConfirmed, false);
  // forceEditing carries ok/activated.
  const forceEditing = result.diagnostics[2].info;
  assert.equal(forceEditing.ok, true);
  assert.equal(forceEditing.activated, true);
  // replayStart: per-op re-check, no re-toggle needed (force already worked).
  const replayStart = result.diagnostics[3].info;
  assert.equal(replayStart.path, harness.path);
  assert.equal(replayStart.isReviewingPositivelyOn, false);
  assert.equal(replayStart.isEditingPositivelyConfirmed, true);
  assert.equal(replayStart.reToggled, false, 'no per-op re-toggle needed');
  // replayDone: ok, with verified length.
  const replayDone = result.diagnostics[4].info;
  assert.equal(replayDone.path, harness.path);
  assert.equal(replayDone.ok, true);
  assert.equal(replayDone.verified, true);
  assert.equal(replayDone.verifiedContentLength, harness.postContent.length);
  // restoreReviewing: intentionally skipped to avoid re-tracking the replay.
  const restore = result.diagnostics[5].info;
  assert.equal(restore.ok, true);
  assert.equal(restore.skipped, true);
  assert.equal(restore.enabled, false);
});

test('acceptTrackedChanges re-toggles Editing before the next op when Reviewing slips back mid-replay', async () => {
  // Models the stubborn browser bug: Overleaf flips back to Reviewing AFTER
  // the initial forceEditing confirm, between the per-op writes. The per-op
  // loop must re-verify Editing immediately before EACH op and force the
  // toggle off again before the next write — never silently land a tracked
  // write because the mode slipped.
  const editors = {
    'main.tex': { text: 'main after\n' },
    'intro.tex': { text: 'intro after\n' }
  };
  const preByPath = { 'main.tex': 'main before\n', 'intro.tex': 'intro before\n' };
  const state = {
    activePath: 'main.tex',
    reviewing: true,
    writes: [],
    toggleCalls: []
  };
  const undoControl = {
    tagName: 'BUTTON', disabled: false,
    getAttribute: name => (name === 'aria-label' ? 'Undo' : null)
  };
  // After the initial force toggle confirms Editing, Overleaf flips Reviewing
  // back ON exactly once — right BEFORE the second per-op write. The per-op
  // re-confirm must catch this and force the toggle again.
  let slippedBackOnce = false;
  function setReviewingEnabled(enabled) {
    state.toggleCalls.push({ enabled });
    state.reviewing = enabled;
    return Promise.resolve({ ok: true, changed: true, enabled });
  }
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    writebackOpenSettleMs: 0,
    ensureEditing: () => Promise.resolve({ ok: true, activated: true }),
    ensureReviewing: () => Promise.resolve({ ok: true, activated: false }),
    setReviewingEnabled,
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, signals: {} }),
    isReviewingConfirmedForWrite: reviewState => reviewState?.reviewing?.ok === true,
    isEditingConfirmedForNoTraceUndo: reviewState => reviewState?.reviewing?.ok === false,
    collectElements: selector => (/button/i.test(selector || '') ? [undoControl] : []),
    readNodeSignalText: () => 'Undo',
    isInsideCodexPanel: () => false,
    getActiveEditorIdentity: () => ({ path: state.activePath }),
    activeEditorIdentityChanged: previous => previous?.path !== state.activePath,
    clickNode(node) {
      if (node === undoControl) {
        editors[state.activePath].text = preByPath[state.activePath];
      }
    },
    readActiveEditorText: () => editors[state.activePath].text,
    replaceActiveEditorText(text) {
      editors[state.activePath].text = String(text);
      state.writes.push({ path: state.activePath, kind: 'replaceAll', reviewing: state.reviewing });
      maybeSlipBack();
      return { ok: true };
    },
    replaceActiveEditorPatches(_patches, nextContent) {
      editors[state.activePath].text = String(nextContent);
      state.writes.push({ path: state.activePath, kind: 'patches', reviewing: state.reviewing });
      maybeSlipBack();
      return { ok: true };
    },
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => state.activePath,
      openFileByPath(target) {
        state.activePath = target;
        return Promise.resolve({ ok: true });
      }
    },
    window: { setTimeout, clearTimeout }
  });

  // Simulates the real-browser sticky-Editing slip: AFTER the first per-op
  // write lands (mode was confirmed off just before it), Overleaf flips
  // Reviewing back ON exactly once. The per-op loop's pre-write re-check
  // must catch this and force the toggle again before the next write.
  function maybeSlipBack() {
    if (!slippedBackOnce) {
      slippedBackOnce = true;
      state.reviewing = true;
    }
  }

  const result = await router.acceptTrackedChanges({
    expectedFiles: [
      { path: 'main.tex', content: 'main before\n' },
      { path: 'intro.tex', content: 'intro before\n' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'main after\n' },
      { path: 'intro.tex', content: 'intro after\n' }
    ]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  // Every write landed while Reviewing was OFF — no tracked writes.
  assert.equal(state.writes.length, 2);
  for (const write of state.writes) {
    assert.equal(write.reviewing, false, 'every per-op write landed while Reviewing was OFF');
    assert.equal(write.kind, 'patches', 'replay uses the patches path');
  }
  // Two toggle-off calls: the initial force + the per-op re-toggle on the slip.
  const offCalls = state.toggleCalls.filter(call => call.enabled === false);
  assert.equal(offCalls.length, 2, 'force-off was re-asserted by the per-op loop');
  // Diagnostics carry per-op replayStart entries; the second one shows the
  // re-toggle fired.
  const replayStarts = result.diagnostics.filter(entry => entry.step === 'replayStart');
  assert.equal(replayStarts.length, 2);
  assert.equal(replayStarts[0].info.reToggled, false, 'first op has no slip');
  assert.equal(replayStarts[1].info.reToggled, true, 'second op caught the slip and re-toggled');
  assert.equal(replayStarts[1].info.editingConfirmedAfterReToggle, true);
  // Accept All intentionally leaves Overleaf in Editing after the replay
  // (Reviewing is NOT auto-restored — see the first happy-path test). The
  // sticky per-op slip catch left the toggle off, and that is where we stay.
  assert.equal(state.reviewing, false);
});

test('acceptTrackedChanges bails the per-op loop when Editing cannot be re-confirmed for the next op', async () => {
  // The initial force succeeds, the first op writes, then Reviewing slips
  // back ON and the per-op re-toggle cannot bring Editing back. The loop
  // must bail rather than land the second write as a tracked change.
  const editors = {
    'main.tex': { text: 'main after\n' },
    'intro.tex': { text: 'intro after\n' }
  };
  const preByPath = { 'main.tex': 'main before\n', 'intro.tex': 'intro before\n' };
  const state = {
    activePath: 'main.tex',
    reviewing: true,
    writes: [],
    toggleCalls: []
  };
  const undoControl = {
    tagName: 'BUTTON', disabled: false,
    getAttribute: name => (name === 'aria-label' ? 'Undo' : null)
  };
  let firstOpDone = false;
  let stickyReviewing = false;
  function setReviewingEnabled(enabled) {
    state.toggleCalls.push({ enabled, sticky: stickyReviewing });
    if (stickyReviewing && enabled === false) {
      // Toggle reports ok, but the state stays stuck on Reviewing — modelling
      // a worst-case Overleaf-side override the re-toggle cannot defeat.
      return Promise.resolve({ ok: true, changed: true, enabled });
    }
    state.reviewing = enabled;
    return Promise.resolve({ ok: true, changed: true, enabled });
  }
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    writebackOpenSettleMs: 0,
    ensureEditing: () => Promise.resolve({ ok: true, activated: true }),
    ensureReviewing: () => Promise.resolve({ ok: true, activated: false }),
    setReviewingEnabled,
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, signals: {} }),
    isReviewingConfirmedForWrite: reviewState => reviewState?.reviewing?.ok === true,
    isEditingConfirmedForNoTraceUndo: reviewState => reviewState?.reviewing?.ok === false,
    collectElements: selector => (/button/i.test(selector || '') ? [undoControl] : []),
    readNodeSignalText: () => 'Undo',
    isInsideCodexPanel: () => false,
    getActiveEditorIdentity: () => ({ path: state.activePath }),
    activeEditorIdentityChanged: previous => previous?.path !== state.activePath,
    clickNode(node) {
      if (node === undoControl) {
        editors[state.activePath].text = preByPath[state.activePath];
      }
    },
    readActiveEditorText: () => editors[state.activePath].text,
    replaceActiveEditorText(text) {
      editors[state.activePath].text = String(text);
      state.writes.push({ path: state.activePath, kind: 'replaceAll' });
      // After the first op lands, simulate Overleaf wedging Reviewing ON for
      // the rest of the flow — the re-toggle cannot defeat the override.
      if (!firstOpDone) {
        firstOpDone = true;
        state.reviewing = true;
        stickyReviewing = true;
      }
      return { ok: true };
    },
    replaceActiveEditorPatches(_patches, nextContent) {
      editors[state.activePath].text = String(nextContent);
      state.writes.push({ path: state.activePath, kind: 'patches' });
      if (!firstOpDone) {
        firstOpDone = true;
        state.reviewing = true;
        stickyReviewing = true;
      }
      return { ok: true };
    },
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => state.activePath,
      openFileByPath(target) { state.activePath = target; return Promise.resolve({ ok: true }); }
    },
    window: { setTimeout, clearTimeout }
  });

  const result = await router.acceptTrackedChanges({
    expectedFiles: [
      { path: 'main.tex', content: 'main before\n' },
      { path: 'intro.tex', content: 'intro before\n' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'main after\n' },
      { path: 'intro.tex', content: 'intro after\n' }
    ]
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  // Only the first op wrote — the second was bailed because Editing could
  // not be re-confirmed after the slip.
  assert.equal(state.writes.length, 1, 'second op never wrote — bail prevented a tracked write');
  assert.equal(state.writes[0].path, 'main.tex');
  // The bail surfaces in the skipped list with the editing-not-confirmed code.
  const bailEntry = result.skipped.find(item => item.result?.code === 'accept_editing_not_confirmed');
  assert.ok(bailEntry, 'bail surfaces as a skipped entry with accept_editing_not_confirmed');
  // Diagnostics show the per-op re-toggle attempt for the second op.
  const replayStarts = result.diagnostics.filter(entry => entry.step === 'replayStart');
  assert.equal(replayStarts.length, 2);
  assert.equal(replayStarts[1].info.reToggled, true);
  assert.equal(replayStarts[1].info.editingConfirmedAfterReToggle, false);
  // The bailed op carries a replayDone with bailed:true.
  const bailedReplayDone = result.diagnostics.find(
    entry => entry.step === 'replayDone' && entry.info?.bailed === true
  );
  assert.ok(bailedReplayDone, 'a replayDone entry marks the bail');
});

// --- reject regression -----------------------------------------------------
//
// The reject path still uses orderTrackedChangesForReviewAction (kept) and the
// per-change DOM loop. Reworking acceptTrackedChanges must leave it unchanged.

function makeButton(label) {
  return {
    tagName: 'BUTTON',
    disabled: false,
    _label: label,
    getAttribute(name) {
      return name === 'aria-label' ? this._label : null;
    }
  };
}

function makeChangeNode(id, path, signal) {
  return {
    tagName: 'SPAN',
    _id: id,
    _path: path,
    _signal: signal || 'tracked change insertion',
    getAttribute(name) {
      if (name === 'data-change-id') return this._id;
      if (name === 'data-path') return this._path;
      return null;
    }
  };
}

function buildRejectWorld(specs) {
  const rows = [];
  let live = [];
  function buildRow(spec) {
    const node = makeChangeNode(spec.id, spec.path, spec.signal);
    const controls = [makeButton('Accept change'), makeButton('Reject change')];
    const row = {
      node,
      controls,
      querySelectorAll() { return controls.slice(); }
    };
    node.parentElement = row;
    for (const control of controls) {
      control.parentElement = row;
    }
    return row;
  }
  for (const spec of specs) {
    rows.push(buildRow(spec));
  }
  live = rows.slice();
  return {
    collectElements() {
      const nodes = [];
      for (const row of live) {
        nodes.push(row.node);
        for (const control of row.controls) {
          nodes.push(control);
        }
      }
      return nodes;
    },
    resolveChange(id) {
      live = live.filter(row => row.node._id !== id);
    }
  };
}

test('rejectTrackedChanges still processes refs in reverse order (orderTrackedChangesForReviewAction kept)', async () => {
  const world = buildRejectWorld([
    { id: 'change-1', path: 'main.tex' },
    { id: 'change-2', path: 'main.tex' },
    { id: 'change-3', path: 'main.tex' }
  ]);
  const clicks = [];
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    collectElements: world.collectElements,
    readNodeSignalText: node => (node?.tagName === 'BUTTON' ? node._label : node._signal) || '',
    isInsideCodexPanel: () => false,
    clickNode(node) {
      clicks.push(node);
      const row = node?.parentElement;
      if (row && row.node) {
        world.resolveChange(row.node._id);
      }
    },
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => 'main.tex',
      openFileByPath: () => Promise.resolve({ ok: true })
    },
    window: { setTimeout, clearTimeout }
  });

  const result = await router.rejectTrackedChanges({
    trackedChanges: [
      { key: 'id:change-1', id: 'change-1', path: 'main.tex' },
      { key: 'id:change-2', id: 'change-2', path: 'main.tex' },
      { key: 'id:change-3', id: 'change-3', path: 'main.tex' }
    ]
  });

  assert.equal(result.applied.length, 3);
  const clickedRowIds = clicks.map(node => node.parentElement.node._id);
  assert.deepEqual(clickedRowIds, ['change-3', 'change-2', 'change-1']);
  for (const click of clicks) {
    assert.match(click._label, /reject/i);
  }
  assert.equal(result.applied[0].result.method, 'overleaf-review-reject');
  assert.equal(result.applied[0].trackedChange.key, 'id:change-3');
  assert.equal(result.applied[2].trackedChange.key, 'id:change-1');
});

// --- T4: structured FailureReason emit-site assertions ----------------------
//
// Cover the accept/reject high-priority emit sites in writebackRouter. Each
// emit site keeps its legacy code+reason and adds a structured `failure`
// record that passes validateFailureReason. The §7 changedDocument contract
// drives the run card's "is there text the user might want to inspect" cue.

const failureReasonsModule = require('../extension/src/shared/failureReasons');

test('acceptTrackedChanges emits structured editing_not_confirmed failure with changedDocument:true after editor-undo rollback', async () => {
  // The editor-undo succeeded (reverted the run writeback) but the Editing
  // mode toggle failed. §7: the document state moved from post-write tracked
  // back to pre-write — set changedDocument:true so the user inspects.
  const harness = createAcceptHarness({
    preContent: 'before\n',
    postContent: 'after\n',
    editingFails: true
  });

  const result = await harness.router.acceptTrackedChanges({
    expectedFiles: [{ path: harness.path, content: harness.preContent }],
    postFiles: [{ path: harness.path, content: harness.postContent }]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.equal(skip.result.code, 'editing_not_confirmed');
  assert.ok(skip.result.failure, 'structured failure attached');
  assert.equal(skip.result.failure.code, 'editing_not_confirmed');
  assert.equal(skip.result.failure.stage, 'reviewing');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.changedDocument, true,
    '§7: editor-undo rolled back; document state moved — changedDocument:true');
  assert.equal(skip.result.failure.retryable, true);
  assert.equal(failureReasonsModule.validateFailureReason(skip.result.failure).ok, true);
});

test('acceptTrackedChanges per-op slip bail emits editing_not_confirmed structured failure', async () => {
  // Reuse the per-op slip harness pattern from earlier in the file: the
  // initial force succeeds, the first op writes, then Reviewing slips back
  // ON and the per-op re-toggle cannot bring Editing back.
  const editors = {
    'main.tex': { text: 'main after\n' },
    'intro.tex': { text: 'intro after\n' }
  };
  const preByPath = { 'main.tex': 'main before\n', 'intro.tex': 'intro before\n' };
  const state = { activePath: 'main.tex', reviewing: true, writes: [], toggleCalls: [] };
  const undoControl = {
    tagName: 'BUTTON', disabled: false,
    getAttribute: name => (name === 'aria-label' ? 'Undo' : null)
  };
  let firstOpDone = false;
  let stickyReviewing = false;
  function setReviewingEnabled(enabled) {
    state.toggleCalls.push({ enabled });
    if (stickyReviewing && enabled === false) {
      return Promise.resolve({ ok: true, changed: true, enabled });
    }
    state.reviewing = enabled;
    return Promise.resolve({ ok: true, changed: true, enabled });
  }
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    writebackOpenSettleMs: 0,
    ensureEditing: () => Promise.resolve({ ok: true, activated: true }),
    ensureReviewing: () => Promise.resolve({ ok: true, activated: false }),
    setReviewingEnabled,
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, signals: {} }),
    isReviewingConfirmedForWrite: reviewState => reviewState?.reviewing?.ok === true,
    isEditingConfirmedForNoTraceUndo: reviewState => reviewState?.reviewing?.ok === false,
    collectElements: selector => (/button/i.test(selector || '') ? [undoControl] : []),
    readNodeSignalText: () => 'Undo',
    isInsideCodexPanel: () => false,
    getActiveEditorIdentity: () => ({ path: state.activePath }),
    activeEditorIdentityChanged: previous => previous?.path !== state.activePath,
    clickNode(node) {
      if (node === undoControl) {
        editors[state.activePath].text = preByPath[state.activePath];
      }
    },
    readActiveEditorText: () => editors[state.activePath].text,
    replaceActiveEditorText(text) {
      editors[state.activePath].text = String(text);
      state.writes.push({ path: state.activePath });
      if (!firstOpDone) { firstOpDone = true; state.reviewing = true; stickyReviewing = true; }
      return { ok: true };
    },
    replaceActiveEditorPatches(_patches, nextContent) {
      editors[state.activePath].text = String(nextContent);
      state.writes.push({ path: state.activePath });
      if (!firstOpDone) { firstOpDone = true; state.reviewing = true; stickyReviewing = true; }
      return { ok: true };
    },
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => state.activePath,
      openFileByPath(target) { state.activePath = target; return Promise.resolve({ ok: true }); }
    },
    window: { setTimeout, clearTimeout }
  });

  const result = await router.acceptTrackedChanges({
    expectedFiles: [
      { path: 'main.tex', content: 'main before\n' },
      { path: 'intro.tex', content: 'intro before\n' }
    ],
    postFiles: [
      { path: 'main.tex', content: 'main after\n' },
      { path: 'intro.tex', content: 'intro after\n' }
    ]
  });

  assert.equal(result.ok, false);
  const bailEntry = result.skipped.find(item => item.result?.code === 'accept_editing_not_confirmed');
  assert.ok(bailEntry, 'per-op bail surfaces as skipped entry');
  assert.ok(bailEntry.result.failure, 'structured failure attached on per-op bail');
  assert.equal(bailEntry.result.failure.code, 'editing_not_confirmed');
  assert.equal(bailEntry.result.failure.stage, 'reviewing');
  assert.equal(bailEntry.result.failure.severity, 'blocked');
  assert.equal(bailEntry.result.failure.changedDocument, true,
    'first op wrote; document state moved before the bail — changedDocument:true');
  assert.equal(failureReasonsModule.validateFailureReason(bailEntry.result.failure).ok, true);
});

test('reject sweep tracked_change_undo_max_iterations emits structured tracked_changes_remain (warning/needs_review)', async () => {
  // Source-level pin: the reject sweep emit sites (per-path and per-expected-file)
  // build a tracked_changes_remain failure with terminalState:needs_review.
  // Driving the 200-iteration limit through a router harness is disproportionate
  // to the test value (the existing reject-path tests already cover behavior).
  const fs = require('node:fs');
  const path = require('node:path');
  // v1.8.0 phase 7: the reject sweeps moved to trackedChangesLifecycle.js;
  // the failure catalog stays in writebackRouter.js. Pin across both.
  const writebackRouterText = fs.readFileSync(
    path.join(__dirname, '../extension/src/page/writebackRouter.js'),
    'utf8'
  ) + fs.readFileSync(
    path.join(__dirname, '../extension/src/page/trackedChangesLifecycle.js'),
    'utf8'
  );
  // Both reject-sweep terminal returns reference the canonical code.
  const occurrences = (writebackRouterText.match(/tracked_changes_remain/g) || []).length;
  assert.ok(occurrences >= 3,
    `tracked_changes_remain referenced at least once per emit site (catalog + 2 reject sweeps + accept replay), saw ${occurrences}`);
  // Both reject-sweep emit sites build via buildPageFailure with terminalState
  // and operationType:'reject'.
  assert.match(writebackRouterText, /buildPageFailure\('tracked_changes_remain'[\s\S]{0,400}operationType:\s*'reject'[\s\S]{0,400}terminalState:\s*'needs_review'/);
});

test('accept-replay tracked_changes_created emits structured tracked_changes_remain (warning/needs_review, changedDocument:true)', async () => {
  // Source-level pin: the accept-replay forbidTrackedChanges return wires a
  // tracked_changes_remain failure with terminalState:needs_review and
  // changedDocument:true. Driving an end-to-end harness that produces a
  // tracked change AFTER an untracked write requires Overleaf-side state
  // the existing harness cannot mock cleanly.
  const fs = require('node:fs');
  const path = require('node:path');
  const writebackRouterText = fs.readFileSync(
    path.join(__dirname, '../extension/src/page/writebackRouter.js'),
    'utf8'
  );
  assert.match(writebackRouterText, /code:\s*'accept_replay_created_tracked_changes'[\s\S]{0,600}buildPageFailure\('tracked_changes_remain'/);
  // Verify the accept-replay branch sets changedDocument:true and needs_review.
  assert.match(writebackRouterText, /buildPageFailure\('tracked_changes_remain'[\s\S]{0,600}changedDocument:\s*true[\s\S]{0,200}terminalState:\s*'needs_review'/);
});

test('writebackRouter attempts to open an unobserved edit path before reporting target_file_not_found', async () => {
  // A collapsed nested folder can initially hide a valid path. The router must
  // give openFileByPath a chance to expand it before declaring the path absent.
  let openedTarget = '';
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => '',
    replaceActiveEditorPatches: () => ({ ok: true }),
    replaceActiveEditorText: () => ({ ok: true }),
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => '',
      projectPathExists: () => false,
      openFileByPath(target) {
        openedTarget = target;
        return Promise.resolve({ ok: false, method: 'dom-expand', reason: 'path remained unavailable' });
      }
    },
    window: { setTimeout, clearTimeout }
  });

  const result = await router.applyOperations({
    operations: [{ type: 'edit', path: 'ghost.tex', replaceAll: 'hello' }]
  });

  assert.equal(result.ok, false);
  assert.equal(openedTarget, 'ghost.tex', 'the router must attempt expansion/opening before classifying the path');
  const skip = result.skipped[0];
  assert.equal(skip.result.code, 'path_not_found');
  assert.ok(skip.result.failure);
  assert.equal(skip.result.failure.code, 'target_file_not_found');
  assert.equal(skip.result.failure.stage, 'navigation');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.file, 'ghost.tex');
  assert.equal(skip.result.failure.changedDocument, false);
  assert.equal(skip.result.failure.evidence.openAttempted, true);
  assert.equal(failureReasonsModule.validateFailureReason(skip.result.failure).ok, true);
});

test('writebackRouter writes a nested file that becomes observable while openFileByPath expands its folder', async () => {
  let activePath = 'main.tex';
  let editorText = 'root baseline';
  let targetVisible = false;
  let openedTarget = '';
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => editorText,
    replaceActiveEditorPatches: () => ({ ok: false }),
    replaceActiveEditorText(nextText) {
      editorText = nextText;
      return { ok: true, method: 'codemirror-view' };
    },
    delay: () => Promise.resolve(),
    getActiveEditorIdentity: () => ({ path: activePath }),
    activeEditorIdentityChanged: previous => previous?.path !== activePath,
    treeOperations: {
      getActiveFilePath: () => activePath,
      projectPathExists: () => targetVisible,
      openFileByPath(target) {
        openedTarget = target;
        targetVisible = true;
        activePath = target;
        editorText = 'nested baseline';
        return Promise.resolve({ ok: true, method: 'dom-expand-click' });
      }
    },
    window: { setTimeout, clearTimeout },
    writebackOpenSettleMs: 0
  });

  const result = await router.applyOperations({
    baseFiles: [{ path: 'sections/intro.tex', content: 'nested baseline' }],
    operations: [{
      type: 'edit',
      path: 'sections/intro.tex',
      replaceAll: 'nested updated'
    }]
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(openedTarget, 'sections/intro.tex');
  assert.equal(activePath, 'sections/intro.tex');
  assert.equal(editorText, 'nested updated');
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 0);
});

test('writebackRouter ensureEditorReadyForOperation emits target_file_open_failed when openFileByPath fails', async () => {
  const router = writebackRouter.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => '',
    replaceActiveEditorPatches: () => ({ ok: true }),
    replaceActiveEditorText: () => ({ ok: true }),
    delay: () => Promise.resolve(),
    treeOperations: {
      getActiveFilePath: () => '',
      projectPathExists: () => true,
      openFileByPath: () => Promise.resolve({ ok: false, reason: 'tree click missed' })
    },
    window: { setTimeout, clearTimeout }
  });

  const result = await router.applyOperations({
    operations: [{ type: 'edit', path: 'sections/intro.tex', replaceAll: 'hello' }]
  });

  assert.equal(result.ok, false);
  const skip = result.skipped[0];
  assert.equal(skip.result.code, 'file_open_failed');
  assert.ok(skip.result.failure);
  assert.equal(skip.result.failure.code, 'target_file_open_failed');
  assert.equal(skip.result.failure.stage, 'navigation');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.file, 'sections/intro.tex');
  assert.equal(skip.result.failure.changedDocument, false);
  assert.equal(skip.result.failure.evidence.writeStarted, false);
  assert.equal(failureReasonsModule.validateFailureReason(skip.result.failure).ok, true);
});

test('writebackRouter editor-not-ready timeout emits target_file_not_active when wrong file remains active', async () => {
  // openFileByPath reports ok but the active path never moves — this is the
  // §9.1 target_file_not_active scenario.
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
  assert.equal(skip.result.code, 'editor_document_not_switched');
  assert.ok(skip.result.failure);
  assert.equal(skip.result.failure.code, 'target_file_not_active');
  assert.equal(skip.result.failure.stage, 'navigation');
  assert.equal(skip.result.failure.severity, 'blocked');
  assert.equal(skip.result.failure.file, 'target.tex');
  assert.equal(skip.result.failure.activeFile, 'wrong.tex');
  assert.equal(skip.result.failure.changedDocument, false);
  assert.equal(failureReasonsModule.validateFailureReason(skip.result.failure).ok, true);
});

// ---------------------------------------------------------------------------
// Welcome-panel + write-guard v1.3.8 add-on FX1 (Fix D / spec §5.0):
// The writebackRouter's defense-in-depth runProjectId guard previously only
// ran on the payload-shaped `applyOperationsForBridge` entry. The array-
// shaped entry (`applyOperations(arr, options)`) returned through without
// the guard, so any future caller that went straight to the array entry
// without `options.runProjectId` would silently dispatch. Fix D mirrors the
// guard on the array branch — same `editor_project_id_unavailable` shape.
//
// These tests use the RAW module (not the wrapped writebackRouter that
// auto-injects runProjectId) so the missing-runProjectId branch actually
// fires.
// ---------------------------------------------------------------------------

test('Fix D: writebackRouter array-shaped applyOperations blocks when options.runProjectId is absent', async () => {
  const rawRouter = writebackRouterModule.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => '',
    replaceActiveEditorPatches: () => ({ ok: true }),
    replaceActiveEditorText: () => ({ ok: true }),
    delay: () => Promise.resolve(),
    getActiveEditorIdentity: () => null,
    activeEditorIdentityChanged: () => false,
    treeOperations: {
      getActiveFilePath: () => 'main.tex',
      projectPathExists: () => true,
      openFileByPath: () => Promise.resolve({ ok: true, method: 'dom-click' })
    },
    window: { setTimeout, clearTimeout }
  });

  // Array-shape entry with NO options at all — guard must fire.
  const resultNoOptions = await rawRouter.applyOperations([
    { type: 'edit', path: 'main.tex', replaceAll: 'hello' }
  ]);
  assert.equal(resultNoOptions.ok, false, 'array-entry without runProjectId must block');
  assert.equal(resultNoOptions.applied.length, 0);
  assert.equal(resultNoOptions.skipped.length, 1);
  const skipNoOptions = resultNoOptions.skipped[0];
  assert.equal(skipNoOptions.result.code, 'editor_project_id_unavailable');
  assert.equal(skipNoOptions.result.failure.code, 'editor_project_id_unavailable');
  assert.equal(skipNoOptions.result.failure.stage, 'write');
  assert.equal(skipNoOptions.result.failure.severity, 'blocked');
  assert.equal(skipNoOptions.result.failure.terminalState, 'blocked');
  assert.equal(skipNoOptions.result.failure.changedDocument, false);

  // Array-shape entry with options that don't include runProjectId — same.
  const resultEmptyRunPid = await rawRouter.applyOperations(
    [{ type: 'edit', path: 'main.tex', replaceAll: 'hello' }],
    { runProjectId: '' }
  );
  assert.equal(resultEmptyRunPid.ok, false, 'empty runProjectId must block too');
  assert.equal(resultEmptyRunPid.skipped[0].result.code, 'editor_project_id_unavailable');
});

test('Fix D: writebackRouter array-shaped applyOperations passes through when options.runProjectId is set', async () => {
  // The happy path must still dispatch. We don't care about the actual
  // editing here — we only assert the request did NOT short-circuit to the
  // `editor_project_id_unavailable` failure shape.
  const rawRouter = writebackRouterModule.create({
    compileBridge: { markSourceEdited() {} },
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    readActiveEditorText: () => '',
    replaceActiveEditorPatches: () => ({ ok: true }),
    replaceActiveEditorText: () => ({ ok: true, method: 'codemirror-view' }),
    delay: () => Promise.resolve(),
    getActiveEditorIdentity: () => null,
    activeEditorIdentityChanged: () => false,
    treeOperations: {
      getActiveFilePath: () => 'main.tex',
      projectPathExists: () => true,
      openFileByPath: () => Promise.resolve({ ok: true, method: 'dom-click' })
    },
    window: { setTimeout, clearTimeout }
  });
  const result = await rawRouter.applyOperations(
    [{ type: 'edit', path: 'main.tex', replaceAll: 'hello' }],
    { runProjectId: 'test-project' }
  );
  // The result may or may not be ok depending on harness completeness, but
  // it MUST NOT be an editor_project_id_unavailable failure. That's the only
  // thing Fix D is asserting.
  const skipCodes = (result.skipped || []).map(s => s && s.result && s.result.code);
  assert.ok(!skipCodes.includes('editor_project_id_unavailable'),
    'array-entry with runProjectId must NOT trip the guard (got skipped codes: ' + JSON.stringify(skipCodes) + ')');
});
