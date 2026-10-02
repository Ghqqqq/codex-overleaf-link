const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectFiles = require('../extension/src/shared/projectFiles');

const treeOperationsSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/treeOperations.js'),
  'utf8'
);

test('only an explicit new-file read may accept a known empty editor', async () => {
  let content = '';
  const empty = makeTreeNode({ label: 'empty.tex', docId: '111111111111111111111111', openPath: 'empty.tex' });
  const harness = createTreeOperationsHarness({ selectedPath: 'empty.tex', nodes: [empty],
    docs: [{ path: 'empty.tex', id: '111111111111111111111111' }],
    readActiveEditorText: () => content, getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc: {} }) });
  assert.equal((await harness.ops.waitForActiveEditorText('empty.tex', 1)).ok, false);
  assert.equal((await harness.ops.waitForActiveEditorText('empty.tex', 1, { allowEmpty: true })).ok, true);
  assert.equal((await harness.ops.waitForActiveEditorText('other.tex', 1, { allowEmpty: true })).ok, false);
  for (content of ['\n', '\r\n', '\n\n']) {
    assert.equal((await harness.ops.waitForActiveEditorText('empty.tex', 1, { allowEmpty: true })).ok, true);
  }
  content = ' ';
  assert.equal((await harness.ops.waitForActiveEditorText('empty.tex', 1, { allowEmpty: true })).ok, false);
  content = undefined;
  assert.equal((await harness.ops.waitForActiveEditorText('empty.tex', 1, { allowEmpty: true })).ok, false);
});

test('new-file readiness waits past the previous document buffer after its path switches', async () => {
  const node = makeTreeNode({ label: 'new.tex', docId: '111111111111111111111111', openPath: 'new.tex' });
  let reads = 0;
  const harness = createTreeOperationsHarness({ selectedPath: 'new.tex', nodes: [node],
    docs: [{ path: 'new.tex', id: '111111111111111111111111' }],
    readActiveEditorText: () => ++reads === 1 ? 'Previous document content' : '\n',
    getActiveEditorIdentity: () => ({ type: 'contenteditable', node: {} }) });
  const ready = await harness.ops.waitForActiveEditorText('new.tex', 1000, { allowEmpty: true, requireEmpty: true });
  assert.equal(ready.ok, true);
  assert.equal(ready.text, '\n');
  assert.equal(reads, 2);
});

test('new-file empty reads still require a live editor identity', async () => {
  const empty = makeTreeNode({ label: 'empty.tex', docId: '111111111111111111111111', openPath: 'empty.tex' });
  const harness = createTreeOperationsHarness({ selectedPath: 'empty.tex', nodes: [empty],
    docs: [{ path: 'empty.tex', id: '111111111111111111111111' }], readActiveEditorText: () => '' });
  assert.equal((await harness.ops.waitForActiveEditorText('empty.tex', 1, { allowEmpty: true })).ok, false);
});

test('tree operations resolves nested DOM basename nodes through Overleaf doc ids', () => {
  const rootId = '111111111111111111111111';
  const nestedId = '222222222222222222222222';
  const rootNode = makeTreeNode({ label: 'main.tex', docId: rootId, openPath: 'main.tex' });
  const nestedNode = makeTreeNode({ label: 'main.tex', docId: nestedId, openPath: 'sections/main.tex' });
  const harness = createTreeOperationsHarness({
    selectedPath: 'main.tex',
    nodes: [rootNode, nestedNode],
    docs: [
      { path: 'main.tex', id: rootId },
      { path: 'sections/main.tex', id: nestedId }
    ]
  });

  assert.equal(harness.ops.readProjectPathFromNode(nestedNode), 'sections/main.tex');
});

test('tree operations infers nested basename file paths from folder DOM ancestry', () => {
  const fileNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'test.tex',
    textContent: 'descriptiontest.texmore_vertMenu'
  });
  const childList = makeDomNode({
    tagName: 'UL',
    role: 'tree',
    className: 'file-tree-folder-list',
    children: [fileNode]
  });
  const folderNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'example',
    textContent: 'expand_moreexample',
    children: [childList]
  });
  const rootNode = makeDomNode({
    tagName: 'DIV',
    className: 'file-tree',
    children: [folderNode]
  });
  const harness = createTreeOperationsHarness({
    selectedPath: 'test.tex',
    nodes: [rootNode, folderNode, childList, fileNode],
    docs: []
  });

  assert.equal(harness.ops.readProjectPathFromNode(fileNode), 'example/test.tex');
});

test('tree operations infers nested files from Overleaf sibling folder-list DOM', () => {
  const folderNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'example',
    textContent: 'expand_moreexample'
  });
  const fileNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'test.tex',
    textContent: 'descriptiontest.tex'
  });
  const nestedList = makeDomNode({
    tagName: 'UL',
    role: 'tree',
    className: 'list-unstyled file-tree-folder-list',
    textContent: 'descriptiontest.tex',
    children: [
      makeDomNode({
        tagName: 'DIV',
        className: 'file-tree-folder-list-inner',
        textContent: 'descriptiontest.tex',
        children: [fileNode]
      })
    ]
  });
  const rootInner = makeDomNode({
    tagName: 'DIV',
    className: 'file-tree-folder-list-inner',
    textContent: 'expand_moreexampledescriptiontest.texdescriptionmain.tex',
    children: [
      folderNode,
      nestedList,
      makeDomNode({
        tagName: 'LI',
        role: 'treeitem',
        ariaLabel: 'main.tex',
        textContent: 'descriptionmain.tex'
      })
    ]
  });
  const rootList = makeDomNode({
    tagName: 'UL',
    role: 'tree',
    className: 'list-unstyled file-tree-folder-list file-tree-list',
    children: [rootInner]
  });
  const rootNode = makeDomNode({
    tagName: 'DIV',
    className: 'file-tree',
    children: [rootList]
  });
  const harness = createTreeOperationsHarness({
    selectedPath: 'main.tex',
    nodes: [rootNode, rootList, rootInner, folderNode, nestedList, ...nestedList.children, fileNode],
    docs: []
  });

  assert.equal(harness.ops.readProjectPathFromNode(fileNode), 'example/test.tex');
});

test('tree operations ignores selected file-tree containers with multiple file labels', () => {
  const selectedContainer = makeDomNode({
    tagName: 'DIV',
    className: 'selected',
    textContent: 'exampledescriptiontest.texdescriptiontest2.texdescriptionmain.tex'
  });
  selectedContainer.openPath = 'bad-active-tree-container';
  const harness = createTreeOperationsHarness({
    selectedPath: 'bad-active-tree-container',
    nodes: [selectedContainer],
    docs: []
  });

  assert.equal(harness.ops.getActiveFilePath(), '');
});

test('tree operations prefers the recently clicked file when stale selected nodes remain', () => {
  const mainNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'main.tex',
    ariaSelected: 'true',
    textContent: 'descriptionmain.tex'
  });
  mainNode.openPath = 'main.tex';
  const nestedNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'test2.tex',
    ariaSelected: 'true',
    textContent: 'descriptiontest2.tex'
  });
  nestedNode.openPath = 'example/test2.tex';
  const folderNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'example',
    ariaExpanded: 'true',
    textContent: 'expand_moreexample',
    children: [nestedNode]
  });
  const harness = createTreeOperationsHarness({
    selectedPath: 'main.tex',
    nodes: [makeDomNode({ className: 'file-tree', children: [mainNode, folderNode] }), mainNode, folderNode, nestedNode],
    docs: [],
    getActiveEditorIdentity: () => ({ id: 'editor-before' }),
    activeEditorIdentityChanged: () => true
  });

  assert.equal(harness.ops.getActiveFilePath(), 'main.tex');

  harness.dispatchWindowClick(nestedNode);

  assert.equal(harness.ops.getActiveFilePath(), 'example/test2.tex');
});


test('tree operations ignores Codex reference buttons when recording file-tree selections', () => {
  const main = makeDomNode({ tagName: 'LI', role: 'treeitem', ariaLabel: 'main.tex' });
  main.openPath = 'main.tex';
  const reference = makeDomNode({ tagName: 'BUTTON', className: 'codex-line-reference' });
  reference.attributes['data-path'] = 'example/test.tex';
  makeDomNode({ id: 'codex-overleaf-panel', children: [reference] });
  const harness = createTreeOperationsHarness({
    selectedPath: 'main.tex', nodes: [main], docs: [],
    getActiveEditorIdentity: () => ({ id: 'editor-before' }),
    activeEditorIdentityChanged: () => true
  });
  harness.dispatchWindowClick(reference);
  assert.equal(harness.ops.getRecentFileTreeSelectionPath(), '');
  assert.equal(harness.ops.getActiveFilePath(), 'main.tex');
});

test('tree operations ignores data-path attributes outside the native file tree', () => {
  const main = makeDomNode({ tagName: 'LI', role: 'treeitem', ariaLabel: 'main.tex' });
  main.openPath = 'main.tex';
  const unrelated = makeDomNode({ tagName: 'BUTTON' });
  unrelated.attributes['data-path'] = 'example/test.tex';
  const harness = createTreeOperationsHarness({
    selectedPath: 'main.tex', nodes: [main], docs: [],
    getActiveEditorIdentity: () => ({ id: 'editor-before' }),
    activeEditorIdentityChanged: () => true
  });
  harness.dispatchWindowClick(unrelated);
  assert.equal(harness.ops.getRecentFileTreeSelectionPath(), '');
  assert.equal(harness.ops.getActiveFilePath(), 'main.tex');
});

test('tree operations expands collapsed folders before opening nested files', async () => {
  const nodes = [];
  const fileNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'test.tex',
    textContent: 'descriptiontest.tex'
  });
  fileNode.openPath = 'example/test.tex';
  const nestedInner = makeDomNode({
    tagName: 'DIV',
    className: 'file-tree-folder-list-inner',
    textContent: 'descriptiontest.tex',
    children: [fileNode]
  });
  const nestedList = makeDomNode({
    tagName: 'UL',
    role: 'tree',
    className: 'list-unstyled file-tree-folder-list',
    textContent: 'descriptiontest.tex',
    children: [nestedInner]
  });
  const folderNode = makeDomNode({
    tagName: 'LI',
    role: 'treeitem',
    ariaLabel: 'example',
    ariaExpanded: 'false',
    textContent: 'chevron_rightexample'
  });
  const rootInner = makeDomNode({
    tagName: 'DIV',
    className: 'file-tree-folder-list-inner',
    textContent: 'chevron_rightexample',
    children: [folderNode]
  });
  const rootNode = makeDomNode({
    tagName: 'DIV',
    className: 'file-tree',
    children: [rootInner]
  });
  nodes.push(rootNode, rootInner, folderNode);
  folderNode.onClick = () => {
    folderNode.attributes['aria-expanded'] = 'true';
    folderNode.textContent = 'expand_moreexample';
    rootInner.children = [folderNode, nestedList];
    nestedList.parentElement = rootInner;
    nodes.push(nestedList, nestedInner, fileNode);
  };
  const harness = createTreeOperationsHarness({
    selectedPath: 'main.tex',
    nodes,
    docs: []
  });

  const opened = await harness.ops.openFileByPath('example/test.tex');

  assert.equal(opened.ok, true, opened.reason || JSON.stringify(opened));
  assert.equal(harness.getSelectedPath(), 'example/test.tex');
  assert.ok(folderNode.clickCount >= 1, 'folder node should be clicked at least once to expand');
  assert.ok(fileNode.clickCount >= 1, 'file node should be clicked at least once to open');
});

test('tree operations opens nested files without falling back to a root basename match', async () => {
  const rootId = '333333333333333333333333';
  const nestedId = '444444444444444444444444';
  const rootNode = makeTreeNode({ label: 'main.tex', docId: rootId, openPath: 'main.tex' });
  const nestedNode = makeTreeNode({ label: 'main.tex', docId: nestedId, openPath: 'sections/main.tex' });
  const harness = createTreeOperationsHarness({
    selectedPath: 'main.tex',
    nodes: [rootNode, nestedNode],
    docs: [
      { path: 'main.tex', id: rootId },
      { path: 'sections/main.tex', id: nestedId }
    ]
  });

  const opened = await harness.ops.openFileByPath('sections/main.tex');

  assert.equal(opened.ok, true, opened.reason || JSON.stringify(opened));
  assert.equal(harness.getSelectedPath(), 'sections/main.tex');
  assert.equal(rootNode.clickCount, 0);
  assert.ok(nestedNode.clickCount >= 1, 'nested node should be clicked at least once');
});

test('a dropped first click is retried on the re-resolved row before reporting open failure', async () => {
  const nestedId = '444444444444444444444444';
  const nestedNode = makeTreeNode({ label: 'Chap_05.tex', docId: nestedId, openPath: 'Tex/Chap_05.tex' });
  let events = 0;
  // Overleaf ignores the first activation sequence while the previous document settles.
  nestedNode.dispatchEvent = function dispatchEvent() {
    this.clickCount += 1;
    events += 1;
    if (events > 4) this.onClick?.();
    return true;
  };
  const harness = createTreeOperationsHarness({ selectedPath: 'roadmap.md', nodes: [nestedNode],
    docs: [{ path: 'Tex/Chap_05.tex', id: nestedId }] });
  const opened = await harness.ops.openFileByPath('Tex/Chap_05.tex', { activeWaitMs: 50, retryWaitMs: 500 });
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.method, 'dom-click-retry');
  assert.equal(harness.getSelectedPath(), 'Tex/Chap_05.tex');
});

test('open failure diagnostics record the retry outcome', async () => {
  const node = makeTreeNode({ label: 'stuck.tex', docId: '555555555555555555555555', openPath: 'stuck.tex' });
  node.dispatchEvent = function dispatchEvent() { this.clickCount += 1; return true; };
  const harness = createTreeOperationsHarness({ selectedPath: 'main.tex', nodes: [node],
    docs: [{ path: 'stuck.tex', id: '555555555555555555555555' }] });
  const opened = await harness.ops.openFileByPath('stuck.tex', { activeWaitMs: 20, retryWaitMs: 20 });
  assert.equal(opened.ok, false);
  assert.match(opened.reason, /domRetryActive=unknown/);
  assert.equal(node.clickCount, 8, 'both activation sequences were dispatched');
});

test('cold native selection resolves nested paths without the legacy doc registry', () => {
  const file = makeDomNode({ tagName: 'LI', role: 'treeitem', ariaLabel: 'my  draft.tex', ariaSelected: 'true' });
  const root = { contains: node => node === file };
  const folder = makeDomNode({ tagName: 'LI', role: 'treeitem', ariaLabel: 'example' });
  folder.querySelector = selector => selector === '[data-file-type="folder"]' ? {} : null;
  const group = { previousElementSibling: folder, parentElement: { closest: () => root } };
  file.closest = selector => selector === '[role="treeitem"]' ? file : selector === '[role="tree"]' ? group : null;
  file.querySelector = selector => selector === '[data-file-type="doc"][data-file-id]' ? {} : null;
  const harness = createTreeOperationsHarness({ selectedPath: '', nodes: [file], docs: [], nativeTreeRoot: root });
  assert.equal(harness.ops.getActiveFilePath(), 'example/my  draft.tex');
});

for (const attribute of ['data-path', 'data-file-path', 'data-name', 'aria-label', 'title']) {
  test(`file identity preserves icon-like names in ${attribute}`, () => {
    for (const name of ['notes.tex', 'notebook.tex', 'article.tex', 'description.tex',
      'draft.tex', 'folder.tex', 'insert_drive_file.tex', 'book_5_notes.tex', 'note paper.tex', 'my  draft.tex']) {
      const file = makeDomNode({ role: 'treeitem', textContent: `description${name}more_vertMenu` });
      file.attributes[attribute] = name;
      const harness = createTreeOperationsHarness({ selectedPath: '', nodes: [file], docs: [] });
      assert.equal(harness.ops.readProjectPathFromNode(file), name, `${attribute}: ${name}`);
      assert.equal(harness.ops.projectPathExists(name), true, name);
    }
  });
}

test('file tree reads the filename element without treating its letters as icon text', () => {
  const name = makeDomNode({ className: 'item-name', textContent: 'notes.tex' });
  const file = makeDomNode({ role: 'treeitem', textContent: 'descriptionnotes.texmore_vertMenu', children: [name] });
  file.querySelectorAll = selector => selector === '.item-name' ? [name] : [];
  const harness = createTreeOperationsHarness({ selectedPath: '', nodes: [file], docs: [] });
  assert.equal(harness.ops.readProjectPathFromNode(file), 'notes.tex');
  assert.equal(harness.ops.findFileTreeNode('s.tex'), null, 'a truncated alias must not open notes.tex');
  const textOnly = makeDomNode({ role: 'treeitem', textContent: 'notebook.tex' });
  assert.equal(harness.ops.readProjectPathFromNode(textOnly), 'notebook.tex');
});

test('notes.tex beside an expanded subfolder opens by its exact full path', async () => {
  const folder = makeDomNode({ role: 'treeitem', ariaLabel: 'col_qa_20260921_full', ariaExpanded: 'true' });
  const sub = makeDomNode({ role: 'treeitem', ariaLabel: 'sub', ariaExpanded: 'true' });
  const nested = makeDomNode({ role: 'treeitem', ariaLabel: 'nested.tex', textContent: 'descriptionnested.tex' });
  const notes = makeDomNode({ role: 'treeitem', ariaLabel: 'notes.tex', textContent: 'descriptionnotes.tex' });
  const rootNotes = makeDomNode({ role: 'treeitem', ariaLabel: 'notes.tex', textContent: 'descriptionnotes.tex' });
  const nestedList = makeDomNode({ role: 'tree', className: 'file-tree-folder-list', children: [nested] });
  const folderList = makeDomNode({ role: 'tree', className: 'file-tree-folder-list', children: [
    makeDomNode({ className: 'file-tree-folder-list-inner', children: [sub, nestedList, notes] })
  ] });
  const root = makeDomNode({ role: 'tree', className: 'file-tree-list', children: [folder, folderList, rootNotes] });
  const nodes = [];
  function collect(node) { nodes.push(node); for (const child of node.children) collect(child); }
  collect(root);
  notes.openPath = 'col_qa_20260921_full/notes.tex';
  rootNotes.openPath = 'notes.tex';
  notes.attributes['data-file-id'] = '111111111111111111111111';
  nested.attributes['data-file-id'] = '222222222222222222222222';
  const harness = createTreeOperationsHarness({ selectedPath: 'notes.tex', nodes, docs: [] });
  assert.equal(harness.ops.readProjectPathFromNode(notes), notes.openPath);
  assert.equal(harness.ops.readProjectPathFromNode(nested), 'col_qa_20260921_full/sub/nested.tex');
  assert.equal(harness.ops.projectPathExists(notes.openPath), true);
  assert.equal(harness.ops.findFileTreeNode(notes.openPath), notes);
  assert.equal(harness.ops.findFileTreeNode('col_qa_20260921_full/s.tex'), null);
  assert.equal(harness.ops.findFileTreeNode('col_qa_20260921_full/sub/notes.tex'), null);
  assert.ok(harness.ops.collectDocRecords().some(record => record.path === notes.openPath && record.id === '111111111111111111111111'));
  const opened = await harness.ops.openFileByPath(notes.openPath);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(harness.getSelectedPath(), notes.openPath);
  assert.equal(rootNotes.clickCount, 0, 'the same-named root file must stay untouched');
  assert.ok(notes.clickCount > 0);
  assert.equal(harness.ops.getActiveFilePath(), notes.openPath);
});

function createTreeOperationsHarness({
  selectedPath,
  nodes,
  docs,
  nativeTreeRoot = null,
  readActiveEditorText = () => 'ready',
  getActiveEditorIdentity = () => null,
  activeEditorIdentityChanged = () => false
}) {
  let currentPath = selectedPath;
  const windowListeners = {};
  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="file-tree-list-root"]') return nativeTreeRoot;
      if (/\[aria-selected="true"\]|\.selected/.test(selector)) {
        return nodes.find(node => node.openPath === currentPath) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (/\[aria-selected="true"\]/.test(selector)) {
        return nodes.filter(node => node.openPath === currentPath || node.getAttribute?.('aria-selected') === 'true');
      }
      if (/\.selected/.test(selector)) {
        return nodes.filter(node => node.openPath === currentPath || /\bselected\b/.test(String(node.className || '')));
      }
      if (/treeitem|role="row"|file-tree|project-tree|data-entity-id|data-doc-id|data-id|data-file-id/.test(selector)) {
        return nodes;
      }
      return [];
    }
  };
  function wrapNodeOnClick(node) {
    const originalOnClick = node.onClick;
    node.onClick = () => {
      originalOnClick?.();
      if (node.openPath) {
        currentPath = node.openPath;
      }
    };
  }
  for (const node of nodes) {
    wrapNodeOnClick(node);
  }
  const originalPush = nodes.push.bind(nodes);
  nodes.push = (...items) => {
    for (const item of items) {
      if (item && typeof item === 'object' && !item.__wrapped) {
        item.__wrapped = true;
        wrapNodeOnClick(item);
      }
    }
    return originalPush(...items);
  };
  const window = {
    location: {
      pathname: '/project/test-project'
    },
    document,
    CodexOverleafProjectFiles: projectFiles,
    _ide: {
      rootFolder: buildInternalDocTree(docs)
    },
    addEventListener(type, handler) {
      windowListeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (windowListeners[type] === handler) {
        delete windowListeners[type];
      }
    },
    setTimeout,
    clearTimeout
  };
  const context = vm.createContext({
    window,
    document,
    Node: class Node {},
    EventTarget: class EventTarget {},
    MouseEvent: class MouseEvent {},
    setTimeout,
    clearTimeout,
    globalThis: window
  });
  vm.runInContext(treeOperationsSource, context, { filename: 'treeOperations.js' });
  const ops = window.CodexOverleafTreeOperations.create({
    window,
    document,
    normalizePath: projectFiles.normalizeSafeProjectPath,
    getActiveEditorIdentity,
    activeEditorIdentityChanged,
    readActiveEditorText
  });
  return {
    ops,
    dispatchWindowClick(target) {
      windowListeners.click?.({
        target,
        isTrusted: true,
        composedPath: () => {
          const ancestors = [];
          for (let node = target; node; node = node.parentElement) ancestors.push(node);
          return ancestors;
        }
      });
    },
    getSelectedPath() {
      return currentPath;
    }
  };
}

function buildInternalDocTree(docs) {
  const root = { name: '', folders: [], docs: [] };
  const folders = new Map([['', root]]);
  for (const doc of docs) {
    const parts = doc.path.split('/');
    const fileName = parts.pop();
    let folderPath = '';
    let parent = root;
    for (const folderName of parts) {
      folderPath = folderPath ? `${folderPath}/${folderName}` : folderName;
      if (!folders.has(folderPath)) {
        const folder = { name: folderName, folders: [], docs: [] };
        folders.set(folderPath, folder);
        parent.folders.push(folder);
      }
      parent = folders.get(folderPath);
    }
    parent.docs.push({ name: fileName, _id: doc.id });
  }
  return root;
}

function makeTreeNode({ label, docId, openPath }) {
  return {
    textContent: label,
    children: [],
    parentElement: null,
    openPath,
    clickCount: 0,
    getAttribute(attribute) {
      if (attribute === 'data-name' || attribute === 'aria-label' || attribute === 'title') {
        return label;
      }
      if (attribute === 'data-entity-id' || attribute === 'data-doc-id' || attribute === 'data-id') {
        return docId;
      }
      return '';
    },
    dispatchEvent() {
      this.clickCount += 1;
      this.onClick?.();
      return true;
    }
  };
}

function makeDomNode({
  tagName = 'DIV',
  role = '',
  className = '',
  id = '',
  ariaLabel = '',
  ariaExpanded = '',
  ariaSelected = '',
  title = '',
  textContent = '',
  children = []
}) {
  const node = {
    tagName,
    className,
    id,
    textContent,
    children,
    parentElement: null,
    clickCount: 0,
    attributes: {
      'aria-expanded': ariaExpanded,
      'aria-selected': ariaSelected
    },
    getAttribute(attribute) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, attribute)) {
        return this.attributes[attribute];
      }
      if (attribute === 'role') {
        return role;
      }
      if (attribute === 'class') {
        return className;
      }
      if (attribute === 'id') {
        return id;
      }
      if (attribute === 'aria-label') {
        return ariaLabel;
      }
      if (attribute === 'title') {
        return title;
      }
      return '';
    },
    dispatchEvent() {
      this.clickCount += 1;
      this.onClick?.();
      return true;
    }
  };
  for (const child of children) {
    child.parentElement = node;
  }
  return node;
}
