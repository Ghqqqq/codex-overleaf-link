'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Creator = require('../extension/src/page/textFileCreator');
function fixture() {
  const state = { project: 'example', selected: [], folderId: 'folder-assets', rootId: 'file-main', detached: false };
  const entity = read => ({ getAttribute: attr => attr === 'data-file-id' ? read() : '' });
  const rootEntity = entity(() => state.rootId), folderEntity = entity(() => state.folderId);
  const rootGroup = { getAttribute: name => name === 'role' ? 'tree' : '', children: [],
    querySelectorAll: () => [anchor, folder, other], contains: node => [anchor, folder, other].includes(node) };
  const childGroup = { getAttribute: name => name === 'role' ? 'tree' : '', children: [] };
  const anchor = { getAttribute: name => name === 'aria-selected' ? String(state.selected.includes(anchor)) : '',
    closest: selector => selector === '[role="tree"]' ? state.detached ? childGroup : rootGroup : anchor,
    querySelector(selector) {
      if (selector === '[data-file-type="folder"]') return null;
      if (selector.includes('[data-file-id]')) return rootEntity;
      if (selector.includes('file-tree-entity')) return { click() { state.selected = [anchor]; } };
      return null;
    } };
  const makeFolder = (label, getEntity) => {
    const value = { nextElementSibling: childGroup,
      getAttribute: name => ({ role: 'treeitem', 'aria-label': label, 'aria-expanded': 'true',
        'aria-selected': String(state.selected.includes(value)) }[name] || ''),
      querySelector: selector => selector.includes('data-file-type="folder"') ? getEntity()
        : selector === '.file-tree-entity-button' ? { click() { state.selected = [value]; } } : null,
      closest: selector => selector === '[role="tree"]' ? rootGroup : value };
    return value;
  };
  const folder = makeFolder('assets', () => folderEntity), other = makeFolder('other', () => entity(() => 'folder-other'));
  rootGroup.children = [anchor, folder, childGroup, other];
  const document = { querySelector: () => rootGroup, querySelectorAll: selector => selector.includes('aria-selected') ? state.selected : [] };
  const creator = Creator.create({ document, window: { setTimeout: callback => { queueMicrotask(callback); } },
    treeOperations: { getProjectId: () => state.project, invalidateDomProjectPathCache() {}, projectPathExists: () => true, collectProjectTextPaths: () => ['main.tex'] } });
  return { state, creator, anchor, folder, other, rootGroup, childGroup,
    prepare: path => creator.prepareUploadParent(path, { isCurrent: () => true }) };
}
for (const path of ['', 'assets']) {
  test('captured upload parent remains valid in the same project: ' + (path || 'root'), async () => {
    const f = fixture(), parent = await f.prepare(path);
    assert.equal(f.creator.isUploadParentCurrent(path, parent), true);
  });
  test('selection drift to a different same-project folder rejects upload: ' + (path || 'root'), async () => {
    const f = fixture(), parent = await f.prepare(path); f.state.selected = [f.other];
    assert.equal(f.creator.isUploadParentCurrent(path, parent), false);
  });
  test('native identity mutation on the captured DOM node rejects upload: ' + (path || 'root'), async () => {
    const f = fixture(), parent = await f.prepare(path);
    if (path) f.state.folderId = 'recreated-folder'; else f.state.rootId = 'recreated-file';
    assert.equal(f.creator.isUploadParentCurrent(path, parent), false);
  });
  test('navigation and multiple selected rows reject captured upload parent: ' + (path || 'root'), async () => {
    const f = fixture(), parent = await f.prepare(path); f.state.project = 'another-project';
    assert.equal(f.creator.isUploadParentCurrent(path, parent), false);
    f.state.project = 'example'; f.state.selected = [parent, f.other];
    assert.equal(f.creator.isUploadParentCurrent(path, parent), false);
  });
}
test('root anchor moved into a nested tree cannot authorize root upload', async () => {
  const f = fixture(), parent = await f.prepare(''); f.state.detached = true;
  assert.equal(f.creator.isUploadParentCurrent('', parent), false);
});
test('unprepared and unknown-identity parent nodes cannot authorize upload', async () => {
  const f = fixture(); f.state.selected = [f.folder];
  assert.equal(f.creator.isUploadParentCurrent('assets', f.folder), false);
  f.state.folderId = ''; const parent = await f.prepare('assets');
  assert.equal(f.creator.isUploadParentCurrent('assets', parent), false);
});
