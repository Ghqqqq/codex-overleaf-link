'use strict';
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');
const Files = require('../../extension/src/shared/projectFiles');
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(options = {}) {
  const FileMover = require('../../extension/src/page/fileMover');
  const content = options.content ?? 'original contents\n';
  const source = options.source || 'old.tex', target = options.target || 'new.tex';
  const kind = options.kind || 'text';
  const files = new Map([[source, { path: source, id: 'entity-source', type: kind === 'text' ? 'doc' : 'file',
    bytes: Buffer.from(content), comments: [{ id: 'comment-original' }], reviewing: [{ id: 'review-original' }] }]]);
  const folders = new Map([['', 'root-folder'], ['dest', 'dest-folder'], ['source', 'source-folder']]);
  const state = { projectId: 'project-move', current: true, posts: [], snapshots: 0, failCount: 0 };
  const row = record => ({ dataset: {}, getAttribute: name => name === 'data-path' ? record.path
    : name === 'aria-label' ? record.path.split('/').pop() : '',
    closest() { return this; },
    querySelector(selector) {
      if (selector.includes('[data-file-type="folder"]') && record.type !== 'folder') return null;
      if (selector.includes('[data-file-type="doc"]') && record.type !== 'doc') return null;
      if (selector.includes('[data-file-type="file"]') && record.type !== 'file') return null;
      return { dataset: { fileId: record.id, fileType: record.type }, getAttribute: name => name === 'data-file-id' ? record.id : '' };
    } });
  const allRows = () => [...files.values(), ...[...folders].filter(([p]) => p).map(([path, id]) => ({ path, id, type: 'folder' }))].map(row);
  const document = { querySelector(selector) {
    if (selector.includes('meta')) return options.csrfMeta || { content: 'fixture-csrf' };
    if (selector.includes('file-tree-list-root')) return { querySelectorAll: allRows };
    return null;
  }, querySelectorAll: allRows };
  const window = { crypto: webcrypto, document, setTimeout, clearTimeout, atob,
    _ide: { project: { _id: state.projectId, rootFolder: [{ _id: 'root-folder' }] } },
    async fetch(url, init) {
      assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin');
      assert.equal(init.headers['X-Csrf-Token'], 'fixture-csrf');
      const match = String(url).match(/^\/project\/project-move\/(doc|file)\/entity-source\/(rename|move)$/);
      assert.ok(match, 'Only the documented entity metadata endpoints are permitted: ' + url);
      const body = JSON.parse(init.body); const call = { action: match[2], type: match[1], body };
      state.posts.push(call); options.beforePost?.(state, files, call);
      if (options.failStep === state.posts.length) {
        state.failCount++; options.onFailure?.(state, files); return { ok: false, status: options.failStatus || 409 };
      }
      if (options.unknownStep === state.posts.length) throw new Error('Synthetic network failure');
      const file = [...files.values()].find(file => file.id === 'entity-source'); assert.ok(file);
      const oldPath = file.path;
      const parent = oldPath.split('/').slice(0, -1).join('/'), name = oldPath.split('/').pop();
      const newParent = match[2] === 'move' ? [...folders].find(([, id]) => id === body.folder_id)?.[0] : parent;
      assert.notEqual(newParent, undefined);
      const newPath = [newParent, match[2] === 'rename' ? body.name : name].filter(Boolean).join('/');
      if (files.has(newPath)) return { ok: false, status: 409 };
      files.delete(oldPath); file.path = newPath; files.set(newPath, file);
      options.afterPost?.(state, files, call);
      if (options.loseResponseAt === state.posts.length) throw new Error('Synthetic response loss after commit');
      return { ok: true, status: 204 };
    } };
  const treeOperations = {
    getProjectId: () => state.projectId,
    invalidateDomProjectPathCache() {},
    findFileTreeNode: target => allRows().find(node => node.getAttribute('data-path') === target),
    readProjectPathFromNode: node => node.getAttribute('data-path')
  };
  const snapshotRouter = { invalidateCache() {}, async fetchProjectZipSnapshot() {
    state.snapshots++; options.beforeSnapshot?.(state, files);
    const result = { ok: true, id: state.projectId, capabilities: { method: 'overleaf-zip', fullProjectSnapshot: true },
      files: [...files.values()].map(file => ({ path: file.path, source: 'overleaf-zip',
        ...(Files.isTextProjectPath(file.path) ? { content: file.bytes.toString() } : { kind: 'binary', contentBase64: file.bytes.toString('base64') }) })) };
    return options.transformSnapshot ? options.transformSnapshot(result) : result;
  } };
  const mover = FileMover.create({ window, document, treeOperations, snapshotRouter,
    normalizeSafeProjectPath: Files.normalizeSafeProjectPath, delay: async () => {},
    textFileCreator: { findFolderNode: path => treeOperations.findFileTreeNode(path), prepareUploadParent: options.prepareUploadParent,
      cleanupCreatedDirectories: options.cleanupCreatedDirectories } });
  const operation = { type: 'move', path: source, to: target, moveProof: { v: 1, kind, sha256: sha(content) } };
  return { state, files, folders, operation, mover, treeOperations, snapshotRouter, window,
    move: op => mover.moveFile(op || operation, { isCurrent: () => state.current, runProjectId: 'project-move', deadlineAt: options.deadlineAt }) };
}
module.exports = { fixture, sha };
