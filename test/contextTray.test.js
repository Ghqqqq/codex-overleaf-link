const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const {
  CONTENT_BUNDLE_ENTRY_MARKER,
  getContentBundleSourceOrder
} = require('./_helpers/contentBundleEntry');

const CONTENT_SCRIPT_PATH = path.join(__dirname, '../extension/src/content/contentRuntime.js');
const CONTEXT_TRAY_PATH = path.join(__dirname, '../extension/src/content/contextTray.js');

function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}


function createMinimalDocument() {
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.listeners = {};
      this.className = '';
      this._textContent = '';
      this.title = '';
      this.type = '';
      this.hidden = false;
      this.style = {};
    }

    set textContent(value) {
      this._textContent = String(value || '');
      this.children = [];
    }

    get textContent() {
      return [
        this._textContent,
        ...this.children.map(child => child.textContent || '')
      ].join('');
    }

    append(...children) {
      this.children.push(...children);
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    getAttribute(name) {
      return this.attributes[name];
    }

    addEventListener(type, listener) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(listener);
    }

    dispatchEvent(event) {
      for (const listener of this.listeners[event.type] || []) {
        listener(event);
      }
      return !event.defaultPrevented;
    }

    async click() {
      const event = {
        type: 'click',
        currentTarget: this,
        target: this,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        }
      };
      await Promise.all((this.listeners.click || []).map(listener => listener(event)));
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
      const matches = [];
      const attr = selector.match(/^\[([^\]]+)\]$/)?.[1];
      const visit = node => {
        if (attr && Object.prototype.hasOwnProperty.call(node.attributes, attr)) {
          matches.push(node);
        }
        for (const child of node.children || []) {
          visit(child);
        }
      };
      visit(this);
      return matches;
    }
  }

  return {
    createElement(tagName) {
      return new Element(tagName);
    }
  };
}

test('add context button opens a visible Overleaf project file picker', () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
  const contextTray = readFileIfExists(CONTEXT_TRAY_PATH);
  const composerPanel = readFileIfExists(path.join(__dirname, '../extension/src/content/composerPanel.js'));
  const panelSource = `${contentScript}\n${composerPanel}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );

  assert.match(panelSource, /data-add-context[^>]+aria-expanded="false"/);
  assert.match(panelSource, /data-context-tray/);
  assert.match(panelSource, /data-context-summary/);
  assert.match(panelSource, /data-context-file-list/);
  assert.match(panelSource, /data-context-refresh/);
  assert.match(contentScript, /function toggleContextTray\(/);
  assert.match(contentScript, /Modules\.ContextTray/);
  assert.match(extractFunction(contentScript, 'toggleContextTray'), /contextTrayController\.toggleContextTray\(\)/);
  assert.match(extractFunction(contentScript, 'renderContextFiles'), /contextTrayController\.renderContextFiles\(project\)/);
  assert.doesNotMatch(contentScript, /let contextProject\s*=/);
  assert.doesNotMatch(contentScript, /let contextLoadId\s*=/);
  assert.doesNotMatch(contentScript, /let contextExpandedFolders\s*=/);
  assert.match(contextTray, /createContextTrayController/);
  assert.match(contextTray, /function isContextTrayClickTarget\(/);
  assert.match(contextTray, /function renderContextFiles\(/);
  assert.match(contextTray, /function buildContextTree\(/);
  assert.match(contextTray, /function renderContextTreeNode\(/);
  assert.match(contextTray, /function selectFocusFile\(/);
  assert.match(contextTray, /function renderContextSummary\(/);
  assert.match(contextTray, /nextFocusFiles/);
  assert.match(contextTray, /data-context-summary-remove/);
  assert.match(contextTray, /let contextProject\s*=\s*null/);
  assert.match(contextTray, /let contextLoadId\s*=\s*0/);
  assert.match(contextTray, /let contextExpandedFolders\s*=\s*new Set\(\)/);
  const sourceOrder = getContentBundleSourceOrder();
  assert.ok(
    sourceOrder.indexOf('src/content/diffReviewPanel.js') <
      sourceOrder.indexOf('src/content/contextTray.js'),
    'context tray controller loads after diff review panel'
  );
  assert.ok(
    sourceOrder.indexOf('src/content/contextTray.js') <
      sourceOrder.indexOf(CONTENT_BUNDLE_ENTRY_MARKER),
    'context tray controller loads before the content entry starts the runtime'
  );
  assert.match(i18n, /clearFiles:\s*'清除全部 @file'/);
  assert.match(i18n, /removeContextFile:\s*'从 @context 移除 \{path\}'/);
  assert.match(i18n, /addContext:\s*'添加 @ 上下文'/);
  assert.match(panelSource, /@compile-log/);
  assert.doesNotMatch(panelSource, /@current-section/);
  assert.doesNotMatch(i18n, /@current-section/);
  assert.match(contentScript, /focusFiles: getActiveFocusFiles\(\)/);
  assert.equal(contentScript.includes('Add context uses the active Overleaf project snapshot automatically.'), false);
  assert.match(css, /\.codex-context-tray/);
  assert.match(css, /\.codex-context-tray\s*\{[\s\S]*position: absolute/);
  assert.match(css, /\.codex-composer\s*\{[\s\S]*position: relative/);
  assert.match(css, /\.codex-context-file/);
  assert.match(css, /\.codex-context-folder/);
  assert.match(css, /\.codex-context-folder-name/);
  assert.match(css, /\.codex-context-file\[data-selected="true"\]/);
  assert.match(css, /\.codex-context-summary/);
  assert.match(css, /\.codex-context-summary-chip/);
  assert.match(css, /\.codex-context-summary-remove/);
  assert.match(css, /\.codex-context-summary-remove:hover/);
});

test('context picker preserves project folder hierarchy instead of flattening by file type', () => {
  const contextTray = readFileIfExists(CONTEXT_TRAY_PATH);

  const renderContextFilesBody = contextTray.match(/function renderContextFiles\(project\) \{[\s\S]*?\n    function getContextProjectFiles/)?.[0] || '';

  assert.match(renderContextFilesBody, /buildContextTree\(files\)/);
  assert.match(renderContextFilesBody, /renderContextTreeNode/);
  assert.doesNotMatch(renderContextFilesBody, /sortContextFiles\(project\?\.files/);
  assert.match(contextTray, /file\.path\.split\('\/'\)/);
});

test('context picker requests the cached exact ZIP file list without file contents', () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
  const contextTray = readFileIfExists(CONTEXT_TRAY_PATH);
  const loadContextFilesBody = contextTray.match(/async function loadContextFiles\(options = \{\}\) \{[\s\S]*?\n    async function requestExactContextFiles/)?.[0] || '';
  const requestExactContextFilesBody = contextTray.match(/async function requestExactContextFiles\(\{ force = false \} = \{\}\) \{[\s\S]*?\n    function isExactContextFileListProject/)?.[0] || '';
  const getRunProjectSnapshotBody = contentScript.match(/async function getRunProjectSnapshot\(\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(loadContextFilesBody, /isExactContextFileListProject\(contextProject\)/);
  assert.match(requestExactContextFilesBody, /callPageBridge\('getProjectFileList'/);
  assert.match(requestExactContextFilesBody, /preferExact:\s*true/);
  assert.match(requestExactContextFilesBody, /exactOnly:\s*true/);
  assert.match(requestExactContextFilesBody, /includeBinaryFiles:\s*true/);
  assert.match(requestExactContextFilesBody, /includeContent:\s*false/);
  assert.doesNotMatch(requestExactContextFilesBody, /getProjectSnapshot/);
  assert.doesNotMatch(getRunProjectSnapshotBody, /contextProject\s*=\s*project/);
});

test('context picker renders folders as collapsed expandable tree controls', () => {
  const contextTray = readFileIfExists(CONTEXT_TRAY_PATH);
  const renderContextTreeNodeBody = contextTray.match(/function renderContextTreeNode\(node, container, selected, depth\) \{[\s\S]*?\n    function renderContextSelection/)?.[0] || '';

  assert.match(renderContextTreeNodeBody, /document\.createElement\('details'\)/);
  assert.match(renderContextTreeNodeBody, /document\.createElement\('summary'\)/);
  assert.match(contextTray, /contextExpandedFolders = new Set\(\)/);
  assert.match(renderContextTreeNodeBody, /folder\.open = contextExpandedFolders\.has\(node\.path\)/);
  assert.match(renderContextTreeNodeBody, /folder\.addEventListener\('toggle'/);
  assert.doesNotMatch(renderContextTreeNodeBody, /folder\.open = true/);
});

test('context summary remove button drops only its own selected file', async () => {
  delete require.cache[require.resolve(CONTEXT_TRAY_PATH)];
  const ContextTray = require(CONTEXT_TRAY_PATH);
  const document = createMinimalDocument();
  const summary = document.createElement('div');
  summary.setAttribute('data-context-summary', '');
  const selection = document.createElement('div');
  selection.setAttribute('data-context-selection', '');
  const addButton = document.createElement('button');
  addButton.setAttribute('data-add-context', '');
  const fileList = document.createElement('div');
  fileList.setAttribute('data-context-file-list', '');
  const panel = document.createElement('div');
  panel.append(summary, selection, addButton, fileList);
  let state = {
    session: {
      focusFiles: ['sample.bib', 'main.tex']
    }
  };
  let saveCount = 0;
  const controller = ContextTray.createContextTrayController({
    document,
    getPanel: () => panel,
    getState: () => state,
    setState: nextState => {
      state = nextState;
    },
    saveState: async () => {
      saveCount++;
    },
    tr: key => key
  });

  controller.renderContextSummary();
  const removeButtons = summary.querySelectorAll('[data-context-summary-remove]');
  assert.equal(removeButtons.length, 2);

  await removeButtons[1].click();

  assert.deepEqual(state.session.focusFiles, ['sample.bib']);
  assert.equal(saveCount, 1);
  assert.equal(summary.hidden, false);
  assert.equal(summary.querySelectorAll('[data-context-summary-remove]').length, 1);
  assert.match(summary.textContent, /@context/);
});

test('context summary truncated chips expose full file paths on hover', () => {
  delete require.cache[require.resolve(CONTEXT_TRAY_PATH)];
  const ContextTray = require(CONTEXT_TRAY_PATH);
  const document = createMinimalDocument();
  const summary = document.createElement('div');
  summary.setAttribute('data-context-summary', '');
  const panel = document.createElement('div');
  panel.append(summary);
  const selectedPath = 'CS285-homework-final-version/main-paper/main.tex';
  const controller = ContextTray.createContextTrayController({
    document,
    getPanel: () => panel,
    getState: () => ({
      session: {
        focusFiles: [selectedPath]
      }
    }),
    tr: key => key
  });

  controller.renderContextSummary();

  const chip = summary.children[1];
  const label = chip.children[0];
  assert.equal(chip.title, selectedPath);
  assert.equal(label.title, selectedPath);
  assert.equal(chip.getAttribute('aria-label'), selectedPath);
});

test('context summary hover shows an immediate full-path tooltip', () => {
  delete require.cache[require.resolve(CONTEXT_TRAY_PATH)];
  const ContextTray = require(CONTEXT_TRAY_PATH);
  const document = createMinimalDocument();
  const summary = document.createElement('div');
  summary.setAttribute('data-context-summary', '');
  const panel = document.createElement('div');
  panel.setAttribute('data-panel', '');
  panel.getBoundingClientRect = () => ({ left: 100, top: 20, right: 480, bottom: 720, width: 380, height: 700 });
  panel.append(summary);
  const selectedPath = 'CS285-homework-final-version/main-paper/main.tex';
  const controller = ContextTray.createContextTrayController({
    document,
    getPanel: () => panel,
    getState: () => ({
      session: {
        focusFiles: [selectedPath]
      }
    }),
    tr: key => key
  });

  controller.renderContextSummary();
  const chip = summary.children[1];
  chip.getBoundingClientRect = () => ({ left: 140, top: 640, right: 260, bottom: 668, width: 120, height: 28 });
  chip.dispatchEvent({ type: 'mouseenter', currentTarget: chip, target: chip });

  const tooltip = panel.querySelector('[data-context-summary-tooltip]');
  assert.ok(tooltip, 'tooltip should be mounted inside the panel');
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, selectedPath);
  assert.equal(tooltip.style.top, '586px');

  chip.dispatchEvent({ type: 'mouseleave', currentTarget: chip, target: chip });
  assert.equal(tooltip.hidden, true);
});

test('context picker shows non-text resources but does not allow selecting them as Codex focus files', () => {
  const contextTray = readFileIfExists(CONTEXT_TRAY_PATH);
  const renderContextTreeNodeBody = contextTray.match(/function renderContextTreeNode\(node, container, selected, depth\) \{[\s\S]*?\n    function renderContextSelection/)?.[0] || '';

  assert.match(renderContextTreeNodeBody, /file\.selectable !== false/);
  assert.match(renderContextTreeNodeBody, /button\.disabled = !selectable/);
  assert.match(renderContextTreeNodeBody, /selectable \? file\.path :/);
});

test('context picker closes when clicking anywhere outside the picker and plus button', () => {
  const contextTray = readFileIfExists(CONTEXT_TRAY_PATH);
  const dismissBody = contextTray.match(/function installContextDismiss\(\) \{[\s\S]*?\n    function isContextTrayClickTarget/)?.[0] || '';

  assert.match(dismissBody, /document\.addEventListener\('click'/);
  assert.match(dismissBody, /isContextTrayClickTarget\(event\.target\)/);
  assert.doesNotMatch(dismissBody, /composer\.contains\(event\.target\)/);
});


test('context exact-list prefetch is delayed, default-on, and user-controllable', () => {
  const contextTray = readFileIfExists(CONTEXT_TRAY_PATH);
  const settingsPanel = readFileIfExists(path.join(__dirname, '../extension/src/content/settingsPanel.js'));

  assert.match(contextTray, /function scheduleContextPrefetch\(/);
  assert.match(contextTray, /requestIdleCallback/);
  assert.match(contextTray, /visibilityState === 'hidden'/);
  assert.match(contextTray, /preloadProjectContext !== false/);
  assert.match(contextTray, /loadContextFiles\(\{ force: false, background: true \}\)/);
  assert.match(contextTray, /data-preload-project-context/);
  assert.match(settingsPanel, /data-preload-project-context/);
});
