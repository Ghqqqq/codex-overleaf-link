'use strict';
const assert = require('node:assert/strict');
const Creator = require('../../extension/src/page/textFileCreator');

// Synthetic DOM, upload controls and ZIP I/O; creation logic runs the production Creator.
function fixture(options = {}) {
  const files = new Map([['main.tex', 'Existing document'], ...Object.entries(options.initialFiles || {})]);
  const folders = new Set(options.folders || []);
  const expanded = new Set();
  let selectedFolder = '';
  const clicks = [];
  const zipRequests = [];
  let clock = 0;
  let parent = '';
  let dialog = null;
  let active = 'main.tex';
  let current = options.current !== false;
  let projectId = 'example';
  class Input {
    get value() { return this.text || ''; }
    set value(value) { this.text = value; }
    getClientRects() { return [{}]; }
    dispatchEvent() {}
  }
  const button = (label, click) => {
    const icon = options.iconLabels ? ({ 'New file': 'note_add', 'New folder': 'create_new_folder' }[label] || '') : '';
    return {
      textContent: icon + label, getAttribute: () => '', getClientRects: () => [{}], click,
      cloneNode() {
        const copy = { textContent: icon + label };
        copy.querySelectorAll = selector => {
          assert.ok(selector.includes('[aria-hidden="true"]'));
          return icon ? [{ remove() { copy.textContent = label; } }] : [];
        };
        return copy;
      }
    };
  };
  const openDialog = folder => {
    const input = new Input();
    const create = button('Create', () => {
      const target = [parent, input.value].filter(Boolean).join('/');
      clicks.push(target);
      if (folder) folders.add(target);
      else files.set(target, options.initialContent || '');
      dialog = null;
      if (options.cancelOnCreate) current = false;
      if (options.navigateOnCreate) projectId = 'another-project';
    });
    dialog = {
      getClientRects: () => [{}],
      querySelectorAll: selector => selector === 'button' ? [create] : [input]
    };
  };
  const uploadInput = {
    files: [],
    dispatchEvent(event) {
      if (event.type !== 'change') return;
      for (const file of this.files) {
        const target = [parent, file.name].filter(Boolean).join('/');
        clicks.push(target);
        files.set(target, file.body);
      }
      if (options.cancelOnCreate) current = false;
    }
  };
  const openUpload = () => {
    const close = button('Cancel', () => { dialog = null; });
    dialog = { getClientRects: () => [{}], innerText: 'Upload files',
      querySelectorAll: selector => selector === 'input[type="file"]' ? [uploadInput]
        : selector === 'button' ? [close] : [] };
  };
  const toolbar = {
    querySelectorAll: () => [button('New folder', () => openDialog(true)), button('New file', () => openDialog(false)),
      button('Upload', openUpload), ...(options.duplicateCreate ? [button('Upload', openUpload)] : [])]
  };
  const nativeFolderList = base => {
    const children = [];
    for (const folderPath of folders) {
      if (folderPath.split('/').slice(0, -1).join('/') !== base) continue;
      const toggle = () => expanded.has(folderPath) ? expanded.delete(folderPath) : expanded.add(folderPath);
      const control = { click() {
        parent = folderPath;
        selectedFolder = folderPath;
        if (options.collapsibleFolders) toggle();
      } };
      const arrow = { click: toggle };
      const childGroup = nativeFolderList(folderPath);
      const isExpanded = !options.collapsibleFolders || expanded.has(folderPath);
      children.push({
        getAttribute: name => ({ role: 'treeitem', 'aria-label': folderPath.split('/').pop(),
          'aria-selected': selectedFolder === folderPath ? 'true' : 'false',
          'aria-expanded': isExpanded ? 'true' : 'false' }[name] ?? null),
        querySelector: selector => selector === '[data-file-type="folder"]' ? {}
          : selector === '.file-tree-entity-button' ? control
            : selector === '.folder-expand-collapse-button' ? arrow : null,
        nextElementSibling: isExpanded ? childGroup : null,
        matches: () => false
      });
      if (isExpanded) children.push(childGroup);
    }
    return { getAttribute: name => name === 'role' ? 'tree' : null,
      children: [{ classList: { contains: name => name === 'file-tree-folder-list-inner' }, children }] };
  };
  const treeOperations = {
    getProjectId: () => projectId,
    invalidateDomProjectPathCache() {},
    projectPathExists: target => files.has(target) || (!options.nativeFolders && folders.has(target)),
    collectProjectTextPaths: () => Array.from(files.keys()),
    findFileTreeNode: target => files.has(target) || (!options.nativeFolders && folders.has(target)) ? {
      matches: () => true,
      click() { parent = folders.has(target) ? target : target.split('/').slice(0, -1).join('/'); }
    } : null,
    async openFileByPath(target) { active = target; return { ok: files.has(target) }; },
    async waitForActiveEditorText(target) { return { ok: active === target, text: files.get(target) }; }
  };
  const creator = Creator.create({
    now: () => clock,
    window: {
      HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } },
      File: class { constructor(parts, name) { this.body = parts.join(''); this.name = name; } },
      DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
      setTimeout(callback, ms = 0) { clock += ms; queueMicrotask(callback); },
      CodexOverleafProjectFiles: { isTextProjectPath: target => target.endsWith('.tex') }
    },
    document: {
      querySelectorAll: () => dialog ? [dialog] : [],
      querySelector: selector => options.nativeFolders && selector.includes('file-tree-list-root') ? nativeFolderList('') : toolbar
    },
    treeOperations,
    uploadHelpers: { chooseOverleafFileInput: inputs => inputs[0] || null,
      assignFilesToInput(input, selected) { input.files = selected; } },
    snapshotRouter: { invalidateCache() {}, async fetchProjectZipSnapshot(params) {
      zipRequests.push(params);
      clock += Math.min(options.zipReadDurationMs || 0, params.zipTimeoutMs);
      const result = { ok: !options.zipUnavailable && !(options.zipFailsAfterUpload && files.size > 1),
        files: [...Array.from(files, ([path, content]) => ({ path, content })),
          ...(options.serverExisting ? [{ path: options.serverExisting, content: 'collaborator content' }] : [])] };
      return options.zipResponse ? options.zipResponse(result, {
        read: zipRequests.length, params,
        cancel: () => { current = false; },
        navigate: () => { projectId = 'another-project'; }
      }) : result;
    } },
    readActiveEditorText() { throw new Error('Creation must not read a live editor buffer'); },
    replaceActiveEditorText() { throw new Error('Creation must not write a live editor buffer'); }
  });
  return { creator, treeOperations, files, folders, clicks, zipRequests, elapsedMs: () => clock, selectedFolder: () => selectedFolder,
    prepare: (target, prepareOptions = {}) => creator.prepareUploadParent(target, {
      ...prepareOptions, isCurrent: () => current
    }),
    setCurrent(value) { current = value; },
    begin: operations => creator.beginCreateBatch(operations, { isCurrent: () => current }),
    finish: (batch, entries, applied = []) => creator.finishCreateBatch(batch, entries, applied),
    create: (target, content, createOptions = {}) => creator.createFile(
      { type: 'create', path: target, content }, { ...createOptions, isCurrent: () => current }
    ) };
}

module.exports = { fixture };
