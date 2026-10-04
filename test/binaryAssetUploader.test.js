'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, webcrypto } = require('node:crypto');
const {
  create,
  chooseOverleafFileInput,
  formatUploadHttpError,
  joinChunks,
  normalizePath
} = require('../extension/src/page/binaryAssetUploader');

test('page asset staging joins ordered chunks and rejects unsafe project paths', () => {
  assert.deepEqual(Array.from(joinChunks([Uint8Array.from([1, 2]), Uint8Array.from([3])], 3)), [1, 2, 3]);
  assert.equal(normalizePath('figures/result.pdf'), 'figures/result.pdf');
  assert.throws(() => normalizePath('../secret.pdf'));
});

test('binary upload targets the Overleaf Uppy input instead of the Codex composer attachment input', () => {
  const composerInput = fakeInput({ codexOwned: true, className: 'codex-composer-attachment-input' });
  const unrelatedInput = fakeInput({ className: 'avatar-upload' });
  const overleafInput = fakeInput({ className: 'uppy-Dashboard-input', inUppy: true, multiple: true });

  assert.equal(
    chooseOverleafFileInput([composerInput, unrelatedInput, overleafInput]),
    overleafInput
  );
});

test('binary upload diagnostics retain a bounded JSON reason for HTTP 422 responses', () => {
  assert.equal(
    formatUploadHttpError(422, JSON.stringify({ error: { message: 'folder_id is invalid' } })),
    'Overleaf upload endpoint returned HTTP 422 (folder_id is invalid).'
  );
  assert.equal(formatUploadHttpError(422, '<html>private error page</html>'), 'Overleaf upload endpoint returned HTTP 422.');
});

function fakeInput(options = {}) {
  return {
    className: options.className || '',
    disabled: options.disabled === true,
    isConnected: true,
    multiple: options.multiple === true,
    getAttribute() { return ''; },
    closest(selector) {
      if (options.codexOwned && selector.includes('#codex-overleaf-panel')) return {};
      if (options.inUppy && selector.includes('.uppy-Dashboard')) return {};
      return null;
    }
  };
}

test('binary replacement reads the React entity id beneath an exact nested tree row', async t => {
  const h = uploadHarness(t, { nativeTree: true });
  const result = await h.commit();
  assert.equal(result.ok, true);
  assert.equal(result.method, 'overleaf.file-input');
  assert.deepEqual(h.getIds, ['asset-id']);
  assert.equal(h.posts.length, 0);
});

test('binary replacement waits for remote bytes instead of treating the existing path as completion', async t => {
  const h = uploadHarness(t, { staleReads: 2 });
  assert.equal((await h.commit()).ok, true);
  assert.equal(h.getIds.length, 3);
  assert.equal(h.posts.length, 0);
});

test('binary replacement recovers a missing DOM id from exact project metadata', async t => {
  const h = uploadHarness(t, { missingDomId: true, metadata: true });
  assert.equal((await h.commit()).ok, true);
  assert.ok(h.metadataReads() > 0);
  assert.deepEqual(h.getIds, ['metadata-id']);
});

test('binary replacement refreshes the file identity while waiting for replacement bytes', async t => {
  const h = uploadHarness(t, { staleReads: 1, rotatingId: true });
  assert.equal((await h.commit()).ok, true);
  assert.deepEqual(h.getIds, ['asset-id', 'replacement-id']);
});

test('binary replacement never claims success for mismatched remote bytes', async t => {
  const h = uploadHarness(t, { staleReads: Infinity });
  const result = await h.commit();
  assert.equal(result.ok, false);
  assert.match(result.reason, /verify the binary replacement/);
});

test('binary verification refuses success or fallback writes after a project switch', async t => {
  const h = uploadHarness(t, { changeProjectOnRead: true });
  const result = await h.commit();
  assert.equal(result.ok, false);
  assert.match(result.reason, /Project changed/);
  assert.equal(h.posts.length, 0);
});

test('multipart fallback resolves the React folder entity id without using a child file id', async t => {
  const h = uploadHarness(t, { nativeTree: true, noInput: true, multipartOk: true });
  const result = await h.commit();
  assert.equal(result.ok, true);
  assert.equal(result.method, 'overleaf.multipart');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.get('folder_id'), 'folder-id');
});

function uploadHarness(t, options = {}) {
  let clock = 1000;
  let projectId = 'qa-project';
  let metadataReads = 0;
  let uploadStarted = false;
  t.mock.method(Date, 'now', () => clock);
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const getIds = [];
  const posts = [];
  const root = {
    rows: [],
    contains: node => root.rows.includes(node),
    querySelectorAll: () => root.rows
  };
  function row(name, type, id, group) {
    const entity = { dataset: { fileId: id, fileType: type } };
    const value = {
      dataset: {},
      getAttribute: key => key === 'role' ? 'treeitem' : key === 'aria-label' ? name : null,
      querySelector: selector => selector.includes('[data-file-id]') ? entity : null,
      closest(selector) {
        if (selector === '[role="tree"]') return group;
        if (selector === '[role="treeitem"]') return value;
        return null;
      }
    };
    return value;
  }
  const folder = row('figures', 'folder', 'folder-id', root);
  const group = { previousElementSibling: folder, parentElement: { closest: () => root } };
  const fileRow = row('probe.png', 'file', 'asset-id', group);
  root.rows = [folder, fileRow];
  const input = { ...fakeInput({ inUppy: true }), dispatchEvent(event) { if (event.type === 'change') uploadStarted = true; } };
  const windowRef = {
    File, FormData, Event, crypto: webcrypto, atob,
    DataTransfer: class {
      constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
    },
    setTimeout(callback, ms) { clock += ms; queueMicrotask(callback); },
    async fetch(url, init = {}) {
      if (init.method === 'POST') {
        uploadStarted = true;
        posts.push({ url, ...init });
        return { ok: options.multipartOk === true, status: 422, text: async () => options.multipartOk ? '{}' : '{"error":"rejected"}' };
      }
      if (uploadStarted) getIds.push(decodeURIComponent(url.split('/').pop()));
      if (options.changeProjectOnRead) projectId = 'other-project';
      const body = !uploadStarted || getIds.length <= (options.staleReads || 0) ? Uint8Array.from([9, 9]) : bytes;
      return { ok: true, arrayBuffer: async () => body.buffer };
    }
  };
  const api = create({
    window: windowRef,
    document: {
      querySelector: selector => options.nativeTree && selector.includes('file-tree-list-root') ? root : null,
      querySelectorAll: selector => selector === 'input[type="file"]' && !options.noInput ? [input] : []
    },
    prepareUploadParent: async () => {},
    isUploadParentCurrent: () => true,
    findFolderNode: () => options.nativeTree ? folder : null,
    treeOperations: {
      getProjectId: () => projectId,
      projectPathExists: () => true,
      findFileTreeManager: () => null,
      findFileTreeNode: path => path !== 'figures/probe.png' || options.nativeTree ? null : {
        dataset: options.missingDomId ? {} : { fileId: options.rotatingId && getIds.length ? 'replacement-id' : 'asset-id' }
      }
    },
    snapshotRouter: {
      async buildProjectFileList() {
        metadataReads += 1;
        return { files: [{ path: 'figures/probe.png', id: options.metadata ? 'metadata-id'
          : options.rotatingId && getIds.length ? 'replacement-id' : 'asset-id' }] };
      }
    }
  });
  return {
    getIds, posts, metadataReads: () => metadataReads,
    async commit() {
      assert.equal(api.begin({ transferId: 'qa-asset-transfer', path: 'figures/probe.png', size: bytes.length,
        previousSha256: createHash('sha256').update(Uint8Array.from([9, 9])).digest('hex'),
        sha256: createHash('sha256').update(bytes).digest('hex'), overwrite: true, mimeType: 'image/png' }).ok, true);
      assert.equal(api.append({ transferId: 'qa-asset-transfer', offset: 0, contentBase64: Buffer.from(bytes).toString('base64') }).ok, true);
      return api.commit({ transferId: 'qa-asset-transfer' });
    }
  };
}
