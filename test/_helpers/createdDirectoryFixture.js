'use strict';
const Creator = require('../../extension/src/page/textFileCreator');
const { webcrypto } = require('node:crypto');
function fixture(options = {}) {
  const files = new Map([['main.tex', 'original'], ...Object.entries(options.files || {})]);
  const folders = new Map((options.folders || []).map(path => [path, 'existing-' + path]));
  const expanded = new Set(), removed = [], created = [], proofs = [];
  const state = { project: 'example', current: true, clock: 0, selected: 'main.tex', active: 'main.tex', parent: '', dialog: null, menu: null, reads: 0 };
  const visible = props => ({ getClientRects: () => [{}], getAttribute: () => '', ...props });
  const button = (textContent, click) => visible({ textContent, click });
  class Input { get value() { return this.text || ''; } set value(value) { this.text = value; } getClientRects() { return [{}]; } dispatchEvent() {} }
  const openDelete = path => {
    state.menu = null;
    options.beforeDialog?.(path, { files, folders, state });
    state.dialog = visible({ querySelectorAll(selector) {
      if (selector === 'li') return [button(options.wrongDialog ? 'unrelated' : path.split('/').pop(), () => {})];
      return [button('Cancel', () => { state.dialog = null; }), button('Delete', () => {
        options.beforeDelete?.(path, { files, folders, state });
        if (!options.keepAfterDelete) { files.delete(path); folders.delete(path); }
        removed.push(path); state.dialog = null;
      })];
    } });
  };
  const row = (path, folder) => {
    const entity = { getAttribute: name => name === 'data-file-id' ? (folder ? folders.get(path) : 'file-' + path) || '' : '' };
    const select = () => { state.selected = path; state.parent = folder ? path : path.split('/').slice(0, -1).join('/'); if (!folder) state.active = path; options.onSelect?.(path, { files, folders, state }); };
    const leaf = visible({ click: select, getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }), dispatchEvent(event) {
      if (event.type === 'contextmenu') state.menu = visible({ closest: () => null, querySelectorAll: () => [button('Delete', () => openDelete(path))] });
    } });
    const value = visible({
      getAttribute: name => ({ role: 'treeitem', 'aria-label': path.split('/').pop(),
        'aria-selected': String(state.selected === path), 'aria-expanded': folder ? String(expanded.has(path)) : null }[name] || ''),
      get nextElementSibling() { return folder && expanded.has(path) ? group(path) : null; },
      matches: () => false, closest: () => value,
      querySelector(selector) {
        if (selector === '[data-file-type="folder"]' || selector === '[data-file-type="folder"][data-file-id]') return folder ? entity : null;
        if (selector === '[data-file-type="doc"][data-file-id]') return folder ? null : entity;
        if (selector === '.folder-expand-collapse-button') return folder ? button('Expand', () => { expanded.add(path); }) : null;
        if (selector === '[role="tree"]') return folder && expanded.has(path) ? group(path) : null;
        if (/file-tree-entity|item-name/.test(selector)) return leaf;
        return null;
      }
    });
    return value;
  };
  function group(base) {
    const children = [];
    for (const path of folders.keys()) if (path.split('/').slice(0, -1).join('/') === base) {
      const folder = row(path, true); children.push(folder); if (expanded.has(path)) children.push(group(path));
      if (options.duplicateFolder === path) children.push(row(path, true));
    }
    for (const path of files.keys()) if (path.split('/').slice(0, -1).join('/') === base) children.push(row(path, false));
    return { getAttribute: name => name === 'role' ? 'tree' : '', children: [{ classList: { contains: name => name === 'file-tree-folder-list-inner' }, children }] };
  }
  const openFolder = () => {
    const input = new Input();
    state.dialog = visible({ querySelectorAll: selector => selector === 'button' ? [button('Create', () => {
      const path = [state.parent, input.value].filter(Boolean).join('/');
      folders.set(path, options.noFolderIdentity ? '' : 'created-' + path); created.push(path); state.dialog = null;
      options.onCreated?.(path, { files, folders, state });
    }), button('Cancel', () => { state.dialog = null; })] : [input] });
  };
  const uploadInput = { files: [], dispatchEvent(event) {
    if (event.type !== 'change') return;
    if (!options.skipUpload) for (const file of this.files) files.set([state.parent, file.name].filter(Boolean).join('/'), file.body);
    state.dialog = null;
  } };
  const openUpload = () => { state.dialog = visible({ querySelectorAll: selector => selector === 'input[type="file"]' ? [uploadInput]
    : selector === 'button' ? [button('Cancel', () => { state.dialog = null; })] : [], innerText: 'Upload files' }); };
  const toolbar = { querySelectorAll: () => [button('New folder', openFolder), button('Upload', openUpload),
    ...(options.duplicateUpload ? [button('Upload', openUpload)] : [])] };
  const document = {
    querySelector: selector => selector.includes('file-tree-list-root') ? group('') : toolbar,
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return state.dialog ? [state.dialog] : [];
      if (selector === '[role="menu"]') return state.menu ? [state.menu] : [];
      if (selector.includes('aria-selected')) return state.selected && (files.has(state.selected) || folders.has(state.selected)) ? [row(state.selected, folders.has(state.selected))] : [];
      return [];
    }
  };
  const treeOperations = { getProjectId: () => state.project, getActiveFilePath: () => state.active,
    findFileTreeNode: path => files.has(path) ? row(path, false) : null,
    projectPathExists: path => files.has(path) || folders.has(path), collectProjectTextPaths: () => [...files.keys()], invalidateDomProjectPathCache() {} };
  const creator = Creator.create({ document, treeOperations, now: () => state.clock,
    window: { crypto: webcrypto, HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } }, MouseEvent: class { constructor(type) { this.type = type; } },
      File: class { constructor(parts, name) { this.body = parts.join(''); this.name = name; } },
      DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
      setTimeout(callback, ms = 0) { return setImmediate(() => { state.clock += ms; callback(); }); }, clearTimeout: clearImmediate,
      CodexOverleafProjectFiles: { isTextProjectPath: path => path.endsWith('.tex') } },
    readActiveEditorText: () => files.get(state.active),
    uploadHelpers: { chooseOverleafFileInput: inputs => inputs[0], assignFilesToInput: (input, value) => { input.files = value; } },
    snapshotRouter: { invalidateCache() {}, async fetchProjectZipSnapshot(params) {
      state.reads++; options.onSnapshot?.({ files, folders, state, params });
      return { ok: true, files: [...files].map(([path, content]) => ({ path, content })), skipped: options.skipped || [], ...(options.snapshotMetadata || {}) };
    } }
  });
  const isCurrent = () => state.current;
  return { creator, files, folders, state, removed, created, expanded, proofs,
    create: (path, content = 'generated', opts = {}) => creator.createFile({ type: 'create', path, content }, { isCurrent, ...opts }),
    prepare: path => creator.prepareUploadParent(path, { createMissing: true, isCurrent,
      onCreatedDirectory(proof) { const old = proofs.findIndex(item => item.path === proof.path); if (old < 0) proofs.push(proof); else proofs[old] = proof; } }),
    cleanup: values => creator.cleanupCreatedDirectories(values, { projectId: 'example', isCurrent }),
    undo: (path, createdDirectories) => creator.deleteFile({ type: 'delete', path, undoCreatedFile: { v: 1, kind: 'text', createdDirectories } },
      { undoCreatedFile: true, expectedContent: 'generated', canDelete: () => true, isCurrent }) };
}
module.exports = { fixture };
