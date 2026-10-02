'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, webcrypto } = require('node:crypto');
const { deflateSync, deflateRawSync } = require('node:zlib');
const Native = require('../native-host/src/nativeAssetTransfer');
const Mirror = require('../native-host/src/mirrorWorkspace');
const Broker = require('../extension/src/content/assetTransferBroker');
const Uploader = require('../extension/src/page/binaryAssetUploader');
const Creator = require('../extension/src/page/textFileCreator');
const Tree = require('../extension/src/page/treeOperations');
const Snapshot = require('../extension/src/page/snapshotRouter');
const Files = require('../extension/src/shared/projectFiles');
const Writeback = require('../extension/src/content/writebackController');
const Undo = require('../extension/src/shared/undoOperations');

const PROJECT = 'binary-roundtrip-project';
const TARGET = 'probe.png';
const PNG = makePng();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

for (const compression of [0, 8]) {
  test('root PNG after nested selection keeps bytes, path, save proof and Undo: ZIP ' + compression, async t => {
    const h = await harness(t, { compression });
    const applied = await h.upload();
    const snapshot = await h.snapshot();
    const check = await Writeback.buildSaveCheck(applied, h.before, { projectId: PROJECT });
    const saved = await Writeback.confirmSaveCheck(check, { assertCurrent: h.assertCurrent, readSnapshot: h.snapshot });
    const undone = await h.undo(applied);
    assert.equal(applied.ok, true);
    assert.equal(saved.ok, true, JSON.stringify({ saved, undone, paths: snapshot.files.map(file => file.path) }));
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const actual = snapshot.files.find(file => file.path === TARGET);
    assert.deepEqual(Buffer.from(actual.contentBase64, 'base64'), PNG);
    assert.equal(check.files[0].sha256, sha256(PNG));
    assert.equal(h.server.has(TARGET), false);
    assert.equal(h.server.has('figures/' + TARGET), false);
    assert.equal(h.server.get('main.tex').toString(), 'main original');
    assert.equal(h.server.get('figures/seed.tex').toString(), 'nested original');
    assert.equal(h.submissions.length, 1);
    assert.equal(h.submissions[0].path, TARGET);
    assert.ok(h.chunkReads() > 1, 'Exercise actual native chunk assembly');
    const repeated = await h.undo(applied);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.changedDocument, false);
  });
}

test('native-tree basename fallback cannot certify a misplaced PNG or replay its upload', async t => {
  const h = await harness(t, { forceWrongParent: true });
  const applied = await h.upload();
  const actual = 'figures/' + TARGET;
  assert.deepEqual(h.server.get(actual), PNG);
  assert.equal(h.tree.findFileTreeNode(TARGET), h.rows.get(actual), 'Exercise the real basename-fallback adapter');
  assert.equal(applied.ok, false, 'Remote byte equality alone cannot prove the requested project path');
  assert.equal(applied.applied.length, 0);
  assert.equal(applied.skipped[0].result.changedDocument, true);
  assert.equal(h.submissions.length, 1, 'An uncertain upload must not be submitted again');
  assert.equal(h.posts(), 0);
  assert.equal(h.server.has(TARGET), false);
});

for (const interference of ['bytes', 'identity', 'project', 'cancel']) {
  test('real PNG Undo fails closed when ' + interference + ' changes before confirmation', async t => {
    const h = await harness(t, { interference });
    const applied = await h.upload();
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const result = await h.undo(applied);
    assert.equal(result.ok, false);
    assert.equal(result.changedDocument, false);
    assert.equal(h.server.has(TARGET), true);
    assert.equal(h.deletions(), 0);
    if (interference === 'bytes') assert.notEqual(sha256(h.server.get(TARGET)), sha256(PNG));
  });
}

async function harness(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-binary-roundtrip-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const before = { id: PROJECT, capabilities: { fullProjectSnapshot: true }, files: [
    { path: 'main.tex', content: 'main original' },
    { path: 'figures/seed.tex', content: 'nested original' }
  ] };
  await Mirror.syncOverleafToMirror({ projectId: PROJECT, rootDir, project: before });
  const mirror = Mirror.getProjectMirror(PROJECT, { rootDir });
  fs.writeFileSync(path.join(mirror.workspacePath, TARGET), PNG);
  const prepared = Native.prepareBinaryAssetChanges({ projectId: PROJECT, rootDir, changes: [
    { type: 'binary-create', path: TARGET, size: PNG.length, sha256: sha256(PNG) }
  ] });
  assert.deepEqual(prepared.unsupportedChanges, []);
  const ref = prepared.changes[0].assetRef;
  ref.chunkSize = 37;
  t.after(() => Native.releaseAsset({ token: ref.token }));

  const server = new Map(before.files.map(file => [file.path, Buffer.from(file.content)]));
  const rows = new Map();
  const submissions = [];
  let selected, menu = null, dialog = null, current = true, clock = 1000;
  let uploadPending = Promise.resolve(), posts = 0, deletions = 0, chunkReads = 0;
  t.mock.method(Date, 'now', () => clock);
  const visible = value => ({ disabled: false, getClientRects: () => [{}], getAttribute: () => '', ...value });
  const button = (name, click) => visible({ textContent: name, click });
  const allRows = () => Array.from(rows.values());
  const root = {
    children: [], parentElement: null, dataset: {},
    contains: node => allRows().includes(node),
    getAttribute: key => key === 'role' ? 'tree' : '',
    querySelector: () => null, querySelectorAll: () => allRows(),
    closest: selector => selector === '[role="tree"]' ? root : null
  };
  const group = { children: [], parentElement: root, dataset: {},
    getAttribute: key => key === 'role' ? 'tree' : '', querySelectorAll: () => [],
    closest: selector => selector === '[role="tree"]' ? group : null };
  function makeRow(filePath, type) {
    const parent = filePath.includes('/') ? group : root;
    const entity = { dataset: { fileId: 'id-' + filePath, fileType: type },
      getAttribute: key => key === 'data-file-id' ? entity.dataset.fileId : '' };
    const label = visible({
      textContent: filePath.split('/').pop(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
      click() { selected = row; },
      dispatchEvent(event) {
        if (event.type !== 'contextmenu') return;
        menu = visible({ closest: () => null, querySelectorAll: () => [button('Delete', () => {
          menu = null;
          if (options.interference === 'bytes') {
            const changed = Buffer.from(server.get(filePath)); changed[changed.length - 1] ^= 1; server.set(filePath, changed);
          }
          if (options.interference === 'identity') entity.dataset.fileId += '-replaced';
          if (options.interference === 'project') win.location.pathname = '/project/other';
          if (options.interference === 'cancel') current = false;
          dialog = visible({ querySelectorAll: selector => selector === 'li'
            ? [visible({ textContent: label.textContent })]
            : [button('Cancel', () => { dialog = null; }), button('Delete', () => {
              deletions++; server.delete(filePath); rows.delete(filePath); selected = null; dialog = null;
            })] });
        })] });
      }
    });
    const row = visible({
      textContent: label.textContent, parentElement: parent, dataset: {}, entity, type,
      classList: { contains: () => false },
      getAttribute: key => ({ role: 'treeitem', 'aria-label': label.textContent,
        'aria-selected': selected === row ? 'true' : 'false', 'aria-expanded': type === 'folder' ? 'true' : '' }[key] || ''),
      querySelectorAll: selector => selector === '.item-name' ? [label] : [],
      querySelector(selector) {
        if (selector.includes('entity-button') || selector.includes('entity-details') || selector.includes('.item-name')) return label;
        if (selector.includes('[data-file-type=')) return selector.includes('[data-file-type="' + type + '"]') ? entity : null;
        return selector.includes('[data-file-id]') ? entity : null;
      },
      closest: selector => selector === '[role="treeitem"]' ? row : selector === '[role="tree"]' ? parent : null
    });
    rows.set(filePath, row);
    parent.children.push(row);
    return row;
  }
  makeRow('main.tex', 'doc');
  const folder = makeRow('figures', 'folder');
  folder.nextElementSibling = group; group.previousElementSibling = folder; root.children.push(group);
  makeRow('figures/seed.tex', 'doc');
  selected = folder;
  const input = visible({
    className: 'uppy-Dashboard-input', isConnected: true, multiple: true,
    closest: selector => selector.includes('uppy') ? {} : null,
    dispatchEvent(event) {
      if (event.type !== 'change') return;
      const file = input.files[0];
      const selectedPath = Array.from(rows).find(([, row]) => row === selected)?.[0] || '';
      const parent = options.forceWrongParent ? 'figures'
        : selected?.type === 'folder' ? selectedPath : selectedPath.split('/').slice(0, -1).join('/');
      const filePath = (parent ? parent + '/' : '') + file.name;
      submissions.push({ path: filePath, file });
      uploadPending = file.arrayBuffer().then(buffer => {
        server.set(filePath, Buffer.from(buffer)); makeRow(filePath, 'file');
      });
    }
  });
  const documentRef = {
    querySelector: selector => selector.includes('file-tree-list-root') ? root : null,
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') return [input];
      if (selector === '[role="dialog"]') return dialog ? [dialog] : [];
      if (selector === '[role="menu"]') return menu ? [menu] : [];
      if (selector.includes('aria-selected')) return selected ? [selected] : [];
      if (selector.includes('[role="treeitem"]')) return allRows();
      return [];
    }
  };
  const win = {
    location: { origin: 'https://www.overleaf.com', pathname: '/project/' + PROJECT, href: 'https://www.overleaf.com/project/' + PROJECT },
    document: documentRef, File, FormData, Event, atob, btoa, crypto: webcrypto,
    MouseEvent: class { constructor(type) { this.type = type; } },
    CodexOverleafProjectFiles: Files,
    setTimeout(callback, ms) {
      if (ms >= 1000) return setTimeout(callback, ms);
      clock += ms; return setImmediate(callback);
    },
    clearTimeout,
    DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
    async fetch(url, init = {}) {
      await uploadPending;
      if (init.method === 'POST') { posts++; return new Response('rejected', { status: 422 }); }
      const id = decodeURIComponent(String(url).split('/').pop());
      const entry = Array.from(rows).find(([, row]) => row.entity.dataset.fileId === id);
      return new Response(entry && server.get(entry[0]), { status: entry ? 200 : 404 });
    }
  };
  const tree = Tree.create({ window: win, document: documentRef,
    getActiveFilePathFromEditorStore: () => 'main.tex' });
  const snapshotRouter = Snapshot.create({ window: win, treeOperations: tree });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(String(url), /\/(?:download\/zip|download\/project\/)/);
    await uploadPending;
    return new Response(makeZip(server, options.compression || 0), { headers: { 'content-type': 'application/zip' } });
  });
  const creator = Creator.create({ window: win, document: documentRef, treeOperations: tree, snapshotRouter });
  const uploader = Uploader.create({ window: win, document: documentRef, treeOperations: tree, snapshotRouter,
    prepareUploadParent: creator.prepareUploadParent, findFolderNode: creator.findFolderNode });
  const broker = Broker.create({
    now: () => clock, delay: async ms => { clock += ms; },
    callPageBridge(method, params) {
      const handler = { binaryUploadBegin: 'begin', binaryUploadAppend: 'append',
        binaryUploadCommit: 'commit', binaryUploadStatus: 'status', binaryUploadAbort: 'abort' }[method];
      assert.ok(handler, 'Only the real binary upload RPCs are expected');
      return Promise.resolve(uploader[handler](params));
    },
    async sendBackgroundNative({ method, params }) {
      if (method === 'asset.readChunk') { chunkReads++; return { ok: true, result: Native.readAssetChunk(params) }; }
      assert.equal(method, 'asset.release');
      return { ok: true, result: Native.releaseAsset(params) };
    }
  });
  const isCurrent = () => current && tree.getProjectId() === PROJECT;
  return {
    before, server, rows, tree, submissions,
    posts: () => posts, deletions: () => deletions, chunkReads: () => chunkReads,
    assertCurrent() { assert.equal(isCurrent(), true); },
    snapshot: options => snapshotRouter.buildProjectSnapshot({ ...options, serverOnly: true, includeBinaryFiles: true }),
    upload: () => broker.applyOperations({ runProjectId: PROJECT,
      operations: Writeback.buildSyncApplyOperations(prepared.changes, before) }),
    undo(applied) {
      const checkpoint = Undo.buildCreatedFileUndoCheckpoint(before, applied.applied.map(entry => entry.operation));
      assert.equal(checkpoint.undoOperations.length, 1);
      const operation = checkpoint.undoOperations[0];
      return creator.deleteFile(operation, { undoCreatedFile: true, expectedSha256: operation.undoCreatedFile.sha256,
        isCurrent, canDelete: isCurrent });
    }
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type), out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([name, data])), out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.alloc(16 * 65);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels.set([x * 17, y * 17, 137, 255], y * 65 + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

// Unlike the text-only storedZip helper, preserve raw PNG bytes and actual CRCs.
function makeZip(entries, method) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const fileName = Buffer.from(name), body = method ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, body);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc32(bytes), 16);
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(fileName.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, fileName);
    offset += header.length + fileName.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
