const assert = require('node:assert/strict');
const test = require('node:test');
const Creator = require('../extension/src/page/textFileCreator');
const { createHash, webcrypto } = require('node:crypto');

function fixture(options = {}) {
  const target = options.binary ? (options.nested ? 'qa/sub/undo.png' : 'undo.png')
    : options.nested ? 'qa/sub/undo.tex' : 'undo.tex';
  const files = new Map([['main.tex', 'original'], ['qa/sub/seed.tex', 'seed'],
    ['qa/sub/green.png', 'binary'], [target, options.binary ? Buffer.from('created image').toString('base64') : '% new\n']]);
  let project = 'example', active = target, selected = null, menu = null, dialog = null, deleted = false, reads = 0;
  let selectedFolderPath = '', clock = 0;
  const visible = props => ({ disabled: false, getClientRects: () => [{}], getAttribute: () => '', ...props });
  const button = (name, click) => visible({ textContent: name, click });
  const rows = new Map();
  const leaf = visible({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
    click() { selected = rows.get(target); selectedFolderPath = ''; active = target; },
    dispatchEvent(event) { if (event.type === 'contextmenu') menu = visible({ closest: () => null,
      querySelectorAll: () => [button('Delete', () => {
        menu = null;
        dialog = visible({ querySelectorAll(selector) {
          if (selector === 'li') return (options.wrongDialog ? ['main.tex', target] : [target.split('/').pop()])
            .map(textContent => visible({ textContent }));
          return [button('Cancel', () => { dialog = null; }), button('Delete', () => {
            files.delete(target); deleted = true; dialog = null;
            if (options.cancelAfterDelete) project = 'other';
          })];
        } });
      })] }); }
  });
  const entity = { getAttribute: name => name === 'data-file-id' && !options.missingId ? 'doc-undo' : '' };
  const row = visible({
    getAttribute: name => ({ role: 'treeitem', 'aria-label': target.split('/').pop() }[name] || ''),
    closest: () => row,
    querySelector: selector => selector === (options.binary ? '[data-file-type="file"][data-file-id]'
      : '[data-file-type="doc"][data-file-id]') ? entity
      : selector.includes('.file-tree-entity-details') ? leaf : null,
    dispatchEvent() { throw new Error('The treeitem does not own the native context menu'); }
  });
  rows.set(target, row);
  const group = base => {
    const children = [];
    const folderPath = base === '' ? 'qa' : base === 'qa' ? 'qa/sub' : '';
    if (folderPath) {
      const child = group(folderPath);
      const folder = visible({ nextElementSibling: child,
        getAttribute: name => ({ role: 'treeitem', 'aria-label': folderPath.split('/').pop(),
          'aria-expanded': 'true', 'aria-selected': selectedFolderPath === folderPath ? 'true' : 'false' }[name] || ''),
        querySelector: selector => selector === '[data-file-type="folder"]' ? {} : { click() { selected = folder; selectedFolderPath = folderPath; } }
      });
      children.push(folder, child);
    }
    return { children, getAttribute: name => name === 'role' ? 'tree' : '' };
  };
  const document = {
    querySelector: () => group(''),
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialog ? [dialog] : [];
      if (selector === '[role="menu"]') return menu ? [menu] : [];
      if (selector.includes('aria-selected')) return selected ? [selected] : [];
      return [];
    }
  };
  const creator = Creator.create({
    now: () => clock,
    window: { crypto: webcrypto, setTimeout: (callback, ms = 0) => setImmediate(() => { clock += ms; callback(); }),
      clearTimeout: clearImmediate,
      MouseEvent: class { constructor(type) { this.type = type; } },
      CodexOverleafProjectFiles: { isTextProjectPath: path => path.endsWith('.tex') } },
    document,
    treeOperations: { getProjectId: () => project, getActiveFilePath: () => active,
      findFileTreeNode: path => files.has(path) ? rows.get(path) : null,
      invalidateDomProjectPathCache() {}, collectProjectTextPaths: () => [] },
    readActiveEditorText: () => files.get(active),
    snapshotRouter: { invalidateCache() {}, async fetchProjectZipSnapshot() {
      if (++reads === 2 && options.concurrentEdit) files.set(target, options.binary
        ? Buffer.from('collaborator image').toString('base64') : 'collaborator edit');
      if (deleted && options.missingReceipt) return { ok: false };
      if (!deleted && options.zipDown && reads <= options.zipDown) return { ok: false, reason: 'zip timeout', diagnostics: { attempts: [{ status: 504 }] } };
      return { ok: true, files: Array.from(files, ([path, content]) => options.binary && path === target
        ? { path, contentBase64: content } : { path, content }) };
    } }
  });
  return { files, target, remove: () => creator.deleteFile({ type: 'delete', path: target,
    ...(options.binary ? { undoCreatedFile: { v: 1, kind: 'binary' } } : {}) },
    { expectedContent: options.binary ? undefined : options.stale ? 'older content' : '% new\n',
      expectedSha256: options.binary ? (options.stale ? '0'.repeat(64) : createHash('sha256').update('created image').digest('hex')) : undefined,
      undoCreatedFile: options.binary || options.guarded,
      ...(options.binary ? { canDelete: () => project === 'example' } : {}),
      isCurrent: () => project === 'example' }) };
}

for (const nested of [false, true]) test('verified native deletion targets the label and preserves siblings: ' + nested, async () => {
  const f = fixture({ nested });
  const result = await f.remove();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification, 'overleaf-zip');
  assert.equal(f.files.has(f.target), false);
  assert.equal(f.files.get('main.tex'), 'original');
  assert.equal(f.files.get('qa/sub/seed.tex'), 'seed');
  assert.equal(f.files.get('qa/sub/green.png'), 'binary');
});

for (const option of ['wrongDialog', 'missingId', 'stale', 'concurrentEdit']) {
  test('native deletion fails closed for ' + option, async () => {
    const f = fixture({ [option]: true });
    const result = await f.remove();
    assert.equal(result.ok, false);
    assert.equal(result.changedDocument, false);
    assert.equal(f.files.has(f.target), true);
  });
}

for (const option of ['missingReceipt', 'cancelAfterDelete']) {
  test('deletion cannot claim success after ' + option, async () => {
    const f = fixture({ [option]: true });
    const result = await f.remove();
    assert.equal(result.ok, false);
    assert.equal(result.changedDocument, true);
    assert.equal(result.verified, undefined);
  });
}

test('mode preparation preserves the established textarea editor adapter', async () => {
  let calls = 0;
  const source = { getAttribute: () => 'Source Editor editing', closest: () => null, getClientRects: () => [{}] };
  const creator = Creator.create({ window: {}, treeOperations: {
    collectProjectTextPaths() { throw new Error('A ready editor must not trigger navigation'); }
  },
    document: { querySelectorAll: selector => selector === 'textarea' ? [source] : [] },
    detectEditor: () => ({ ok: true, type: 'textarea' }),
    ensureEditing: async params => { calls += 1; assert.equal(params.runProjectId, 'example'); return { ok: true }; }
  });
  assert.equal((await creator.ensureWriteMode(false, { runProjectId: 'example' })).ok, true);
  assert.equal(calls, 1);
});

test('preparation alone leaves the existing Undo mode policy in control', async () => {
  const source = { getClientRects: () => [{}], closest: () => null };
  const creator = Creator.create({ window: {}, treeOperations: {},
    document: { querySelectorAll: selector => selector === '.cm-content' ? [source] : [] },
    detectEditor: () => ({ ok: true, type: 'codemirror-view' }),
    ensureEditing() { throw new Error('Preparation must not switch the mode'); }
  });
  assert.equal((await creator.prepareEditor({ runProjectId: 'example' })).ok, true);
});

for (const changed of [false, true]) test('image focus textarea and hidden cached editor require preparation; project change=' + changed, async () => {
  let ready = false, project = 'example', opened = '';
  const focus = { getAttribute: () => 'Invisible element to manage focus and prevent unintended behavior',
    closest: () => null, getClientRects: () => [{}] };
  const content = { getClientRects: () => ready ? [{}] : [], closest: () => null };
  const creator = Creator.create({
    window: { setTimeout },
    document: { querySelectorAll: selector => selector === 'textarea' ? [focus] : selector === '.cm-content' ? [content] : [] },
    detectEditor: () => ({ ok: true, type: 'codemirror-view' }),
    ensureEditing() { throw new Error('Preparation must not switch the mode'); },
    treeOperations: { getProjectId: () => project, getActiveFilePath: () => 'image.png',
      collectProjectTextPaths: () => ['main.tex'], async openFileByPath(path) {
        opened = path; ready = true; if (changed) project = 'other'; return { ok: true };
      }
    }
  });
  const result = await creator.prepareEditor({ runProjectId: 'example' });
  assert.equal(opened, 'main.tex');
  assert.equal(result.ok, !changed);
  if (changed) assert.equal(result.code, 'aborted_project_changed');
});

test('visible editors from the established deep DOM collector remain supported', async () => {
  const source = { getClientRects: () => [{}], closest: () => null };
  const creator = Creator.create({ window: {}, treeOperations: {},
    document: { querySelectorAll() { throw new Error('The existing collector owns nested roots'); } },
    collectElements: selector => selector === '.cm-content' ? [source] : []
  });
  assert.equal((await creator.prepareEditor({ runProjectId: 'example' })).ok, true);
});

test('positive geometry does not make a CSS-hidden editor ready', async () => {
  let ready = false, opened = 0;
  const source = { getClientRects: () => [{}], closest: () => null };
  const creator = Creator.create({
    window: { setTimeout, getComputedStyle: () => ({ display: 'block', visibility: ready ? 'visible' : 'hidden' }) },
    document: { querySelectorAll: selector => selector === '.cm-content' ? [source] : [] },
    treeOperations: { getProjectId: () => 'example', getActiveFilePath: () => 'image.png',
      collectProjectTextPaths: () => ['main.tex'], async openFileByPath() { ready = true; opened++; return { ok: true }; }
    }
  });
  assert.equal((await creator.prepareEditor({ runProjectId: 'example' })).ok, true);
  assert.equal(opened, 1);
});

for (const nested of [false, true]) test('guarded binary deletion verifies hash and preserves neighboring files: ' + nested, async () => {
  const f = fixture({ binary: true, nested });
  const result = await f.remove();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification, 'overleaf-zip');
  assert.equal(f.files.has(f.target), false);
  assert.equal(f.files.get('main.tex'), 'original');
  assert.equal(f.files.get('qa/sub/green.png'), 'binary');
  const repeated = await f.remove();
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.changedDocument, false);
});
for (const option of ['wrongDialog', 'missingId', 'stale', 'concurrentEdit']) {
  test('guarded binary deletion leaves the file intact for ' + option, async () => {
    const f = fixture({ binary: true, [option]: true }); const result = await f.remove();
    assert.equal(result.ok, false);
    assert.equal(result.changedDocument, false);
    assert.equal(f.files.has(f.target), true);
  });
}
for (const option of ['missingReceipt', 'cancelAfterDelete']) {
  test('binary deletion cannot report success after ' + option, async () => {
    const f = fixture({ binary: true, [option]: true }); const result = await f.remove();
    assert.equal(result.ok, false);
    assert.equal(result.changedDocument, true);
    assert.equal(result.verified, undefined);
  });
}
test('guarded text deletion tolerates an already-deleted sibling on retry', async () => {
  const f = fixture({ guarded: true }); assert.equal((await f.remove()).ok, true);
  const repeated = await f.remove(); assert.equal(repeated.ok, true); assert.equal(repeated.idempotent, true);
});

test('a dropped server ZIP read is retried before the delete gives up', async () => {
  const f = fixture({ zipDown: 1 });
  const result = await f.remove();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.files.has(f.target), false);
});

test('a delete whose server check keeps failing is untouched, retryable and keeps diagnostics', async () => {
  const f = fixture({ zipDown: 99 });
  const result = await f.remove();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'delete_confirmation_budget_exhausted');
  assert.equal(result.changedDocument, false);
  assert.equal(result.failure.retryable, true);
  assert.equal(result.failure.changedDocument, false);
  assert.ok(result.diagnostics.zipFailures.some(failure =>
    failure.diagnostics?.attempts?.some(attempt => attempt.status === 504)));
  assert.equal(result.remainingMs, 15000, 'failed preflight preserves the confirmation reserve');
  assert.equal(f.files.has(f.target), true);
});
