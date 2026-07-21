const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const { getContentScriptSource, extractFromContentScript } = require('./_helpers/contentScriptSource');
const { runtimeStubs } = require('./_helpers/runtimeSandbox');
const vm = require('node:vm');

const ReviewHunks = require('../extension/src/content/reviewHunks');

const DIFF_REVIEW_PANEL_PATH = '../extension/src/content/diffReviewPanel.js';


function createMinimalDocument() {
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.className = '';
      this.textContent = '';
      this.title = '';
      this.type = '';
      this.tabIndex = undefined;
    }

    append(...children) {
      this.children.push(...children);
    }

    appendChild(child) {
      this.append(child);
      return child;
    }

    replaceChildren(...children) {
      this.children = children;
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

    focus() {
      this.focused = true;
    }

    blur() {
      this.blurred = true;
      this.focused = false;
    }

    click() {
      const results = [];
      for (const listener of this.listeners.click || []) {
        results.push(listener({ currentTarget: this, target: this }));
      }
      return Promise.all(results);
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
      const matches = [];
      const attr = selector.match(/^\[([^\]]+)\]$/)?.[1];
      if (!attr) {
        return matches;
      }
      const visit = node => {
        if (Object.prototype.hasOwnProperty.call(node.attributes, attr)) {
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
    createTextNode(text) {
      return {
        nodeType: 3,
        textContent: String(text || ''),
        children: []
      };
    },
    createElement(tagName) {
      return new Element(tagName);
    }
  };
}

function collectElementText(node) {
  return [
    node?.textContent || '',
    ...(node?.children || []).map(child => collectElementText(child))
  ].join('');
}

function collectElements(node, predicate, result = []) {
  if (!node) {
    return result;
  }
  if (predicate(node)) {
    result.push(node);
  }
  for (const child of node.children || []) {
    collectElements(child, predicate, result);
  }
  return result;
}

function loadMarkdownRendererHarness(projectFiles = [], options = {}) {
  const contentScript = getContentScriptSource();
  const LineReferences = require('../extension/src/shared/lineReferences');
  const document = createMinimalDocument();
  const pageBridgeCalls = [];
  const toasts = [];
  // v1.4.5: the markdown cluster lives in markdownText.js while the project
  // reference-file helpers stayed in contentRuntime, so the region is
  // assembled from each function's real home instead of one contiguous slice.
  const markdownSource = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/markdownText.js'),
    'utf8'
  );
  const start = markdownSource.indexOf('function renderMarkdownInlineText');
  assert.notEqual(start, -1, 'line-reference renderer helpers should exist');
  const endFunction = extractFunction(markdownSource, 'normalizeInlineOrderedLists');
  const end = markdownSource.indexOf(endFunction) + endFunction.length;
  const markdownRegion = [
    extractFromContentScript( 'getCurrentProjectReferenceFiles'),
    extractFromContentScript( 'captureProjectReferenceFiles'),
    markdownSource.slice(start, end),
    extractFromContentScript( 'isMarkdownHeadingLine'),
    extractFromContentScript( 'isMarkdownListLine'),
    extractFromContentScript( 'isMarkdownOrderedListLine'),
    extractFromContentScript( 'isSameMarkdownListKind'),
    extractFromContentScript( 'stripMarkdownListMarker')
  ].join('\n');

  return Function('document', 'LineReferences', 'projectFiles', 'pageBridgeCalls', 'toasts', 'options', `
    let state = {
      focusFiles: [],
      session: { focusFiles: [] },
      sessions: []
    };
    let currentRunView = { projectFiles };
    function callPageBridge(method, params) {
      pageBridgeCalls.push({ method, params });
      return options.callPageBridge
        ? options.callPageBridge(method, params)
        : Promise.resolve(options.pageBridgeResult || { ok: true });
    }
    function showPluginToast(text, options) {
      toasts.push({ text, options });
    }
    function tr(key) { return key; }
    function tx(english) { return english; }
    ${markdownRegion}
    return {
      buildMarkdownInlineNodes,
      renderMarkdownInlineText,
      renderMarkdownBlockText,
      formatMarkdownLinkLabel,
      formatMarkdownHref,
      pageBridgeCalls,
      toasts
    };
  `)(document, LineReferences, projectFiles, pageBridgeCalls, toasts, options);
}

function findLineReferenceButtons(node) {
  return collectElements(node, item => item.className === 'codex-line-reference');
}

// A fake-DOM node rich enough to exercise the run-card control functions:
// it supports clone-and-replace, parent links, sibling insertion, removal, and
// attribute-selector queries over the subtree. createRunCardDocument() is the
// document façade that mints these nodes.
class RunCardNode {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.parentElement = null;
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.hidden = false;
    this.disabled = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  insertBefore(node, reference) {
    node.parentElement = this;
    const index = this.children.indexOf(reference);
    if (index === -1) {
      this.children.push(node);
    } else {
      this.children.splice(index, 0, node);
    }
    return node;
  }

  replaceWith(node) {
    if (!this.parentElement) {
      return;
    }
    const index = this.parentElement.children.indexOf(this);
    if (index !== -1) {
      node.parentElement = this.parentElement;
      this.parentElement.children[index] = node;
    }
    this.parentElement = null;
  }

  remove() {
    if (!this.parentElement) {
      return;
    }
    const index = this.parentElement.children.indexOf(this);
    if (index !== -1) {
      this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null;
  }

  cloneNode() {
    const copy = new RunCardNode(this.tagName);
    copy.dataset = { ...this.dataset };
    copy.textContent = this.textContent;
    copy.title = this.title;
    copy.type = this.type;
    copy.hidden = this.hidden;
    copy.disabled = this.disabled;
    return copy;
  }

  addEventListener(type, listener) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }

  click() {
    const event = { type: 'click', stopPropagation() {}, defaultPrevented: false };
    for (const listener of this.listeners.click || []) {
      listener(event);
    }
  }

  matchesAttr(attr) {
    return Object.prototype.hasOwnProperty.call(this.dataset, attrToDatasetKey(attr));
  }

  querySelectorAll(selector) {
    const attrs = selector.split(',').map(part => part.trim().replace(/^\[|\]$/g, ''));
    const matches = [];
    const visit = node => {
      if (attrs.some(attr => node.matchesAttr(attr))) {
        matches.push(node);
      }
      for (const child of node.children) {
        visit(child);
      }
    };
    for (const child of this.children) {
      visit(child);
    }
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function attrToDatasetKey(attr) {
  // Mirror the DOM: a data-* attribute maps to a camelCased dataset key with
  // the data- prefix stripped (data-run-accept -> runAccept).
  return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function createRunCardDocument() {
  return {
    createElement(tagName) {
      return new RunCardNode(tagName);
    }
  };
}

// Builds a run-card root with the [data-run-accept] / [data-run-undo] controls
// inside a .run-turn-meta, mirroring renderRunCard's markup, so the control
// functions can be driven directly against it.
function buildRunCardRoot(runId) {
  const root = new RunCardNode('div');
  root.dataset.runId = runId;
  const meta = new RunCardNode('div');
  meta.dataset.runTurnMeta = '';
  const accept = new RunCardNode('button');
  accept.dataset.runAccept = '';
  const undo = new RunCardNode('button');
  undo.dataset.runUndo = '';
  meta.append(accept, undo);
  root.append(meta);
  return root;
}

// Extracts the run-card control functions from contentRuntime.js and wires them
// against fake runs, a fake panel DOM, and stubbed dependencies. configureUndo
// is stubbed: applyTerminalTrackedChangeStatus -> refreshRunCardControls only
// needs the Accept control rebuilt, and the undo machinery is out of scope here.
function loadRunCardControlsHarness(options = {}) {
  const contentScript = getContentScriptSource();
  const document = createRunCardDocument();
  const region = [
    'const TERMINAL_TRACKED_CHANGE_STATUS = new Set([\'accepted\', \'rejected\']);',
    extractFromContentScript( 'isTrackedChangeLifecycleRun'),
    extractFromContentScript( 'configureAcceptButton'),
    extractFromContentScript( 'configureLifecycleUndoButton'),
    extractFromContentScript( 'wireAcceptInlineConfirm'),
    extractFromContentScript( 'applyTerminalTrackedChangeStatus'),
    extractFromContentScript( 'refreshRunCardControls'),
    extractFromContentScript( 'cssEscape')
  ].join('\n');

  return Function('document', 'state', 'panel', 'options', `
    const window = {};
    const trackedChangeInFlight = new Map(options.inFlight || []);
    let saveStateSoonCalls = 0;
    const acceptRunCalls = [];
    const undoRunCalls = [];
    function saveStateSoon() { saveStateSoonCalls++; }
    function findRunRecord(runId) {
      return (state.runs || []).find(run => run.id === runId) || null;
    }
    function acceptRun(runId) { acceptRunCalls.push(runId); }
    function undoRun(runId) { undoRunCalls.push(runId); }
    function getRunUndoCount() { return 0; }
    function tr(key) { return key; }
    function configureUndoButton(root, run) {
      const existing = root.querySelector('[data-run-undo]');
      const button = existing.cloneNode(true);
      existing.replaceWith(button);
      configureLifecycleUndoButton(button, run);
    }
    ${region}
    return {
      configureAcceptButton,
      configureUndoButton,
      applyTerminalTrackedChangeStatus,
      refreshRunCardControls,
      trackedChangeInFlight,
      acceptRunCalls,
      undoRunCalls,
      getSaveStateSoonCalls: () => saveStateSoonCalls
    };
  `)(document, options.state || { runs: [] }, options.panel || null, options);
}

function loadCreateDiffReviewElementForTest(options = {}) {
  delete require.cache[require.resolve(DIFF_REVIEW_PANEL_PATH)];
  const pageBridgeCalls = [];
  const DiffReviewPanel = require(DIFF_REVIEW_PANEL_PATH);
  const controller = DiffReviewPanel.createDiffReviewPanelController({
    document: createMinimalDocument(),
    root: { CodexOverleafReviewHunks: ReviewHunks },
    reviewHunks: ReviewHunks,
    callPageBridge(method, params) {
      pageBridgeCalls.push({ method, params });
      return Promise.resolve(options.pageBridgeResult || { ok: true });
    },
    tr(key) {
      return key;
    }
  });
  const createDiffReviewElement = controller.createDiffReviewElement;
  createDiffReviewElement.pageBridgeCalls = pageBridgeCalls;
  return createDiffReviewElement;
}

test('content runtime guards duplicate initialization and exposes fail-closed state', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /__codexOverleafContentRuntimeInstalled/);
  assert.match(contentScript, /__codexOverleafContentRuntimeState/);
  assert.match(contentScript, /stale-panel-before-runtime-init/);
  assert.match(contentScript, /async-init-failed/);
  assert.match(contentScript, /alreadyInstalled:\s*true/);
});

test('panel renderer has compact overlay behavior for narrow viewports', () => {
  const renderer = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/panelRenderer.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(renderer, /codex-overleaf-panel-compact/);
  assert.match(renderer, /viewportWidth < instance\.minWidth \+ instance\.pageMinWidth/);
  assert.match(renderer, /persist:\s*!compact && options\.persist !== false/);
  assert.match(renderer, /isCompactViewport\(instance\)/);
  assert.match(css, /codex-overleaf-panel-mounted:not\(\.codex-overleaf-panel-compact\) body/);
  assert.match(css, /max-height:\s*calc\(100vh - 24px\)/);
  assert.match(css, /codex-panel-resize-handle[\s\S]*display:\s*none/);
});

test('composer attachments enforce a total raw byte limit before reads', () => {
  const attachments = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerAttachments.js'),
    'utf8'
  );
  const runtime = getContentScriptSource();

  assert.match(runtime, /MAX_COMPOSER_ATTACHMENT_TOTAL_BYTES = 32 \* 1024 \* 1024/);
  assert.match(attachments, /maxAttachmentTotalBytes/);
  assert.match(attachments, /canReserveAttachmentBytes\(fileSize\)/);
  assert.match(attachments, /pendingAttachmentBytes \+= fileSize/);
  assert.match(attachments, /pendingAttachmentBytes = Math\.max\(0, pendingAttachmentBytes - fileSize\)/);
  assert.match(attachments, /readFileAsDataUrl\(file\)/);
});

test('composer defaults to English task modes and keeps Chinese translations available', () => {
  const contentScript = getContentScriptSource().replace(/\r\n/g, '\n');
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );

  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );
  const localSkillsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/localSkillsPanel.js'),
    'utf8'
  );

  assert.match(composerPanel, /data-mode-choice="ask"[\s\S]*>Ask<\/button>/);
  assert.match(composerPanel, /data-mode-choice="confirm"[\s\S]*>Suggest<\/button>/);
  assert.match(composerPanel, /data-mode-choice="auto"[\s\S]*>Auto<\/button>/);
  assert.match(i18n, /modeAsk:\s*'只问不改'/);
  assert.match(i18n, /modeConfirm:\s*'建议修改'/);
  assert.match(i18n, /modeAuto:\s*'自动写入'/);
});

test('composer shows confirm and auto as explicit visible write-mode choices', () => {
  const contentScript = getContentScriptSource();
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const contentSurface = `${contentScript}\n${composerPanel}`;

  assert.match(contentSurface, /class="codex-mode-row"/);
  assert.match(contentSurface, /class="codex-mode-switch"/);
  assert.match(contentSurface, /data-mode-choice="ask"/);
  assert.match(contentSurface, /data-mode-choice="confirm"/);
  assert.match(contentSurface, /data-mode-choice="auto"/);
  assert.match(contentScript, /function selectMode\(/);
  assert.match(contentScript, /function syncModeControls\(/);
  assert.match(contentScript, /querySelectorAll\('\[data-mode-choice\]'\)/);
  assert.match(css, /\.codex-mode-switch\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\[data-mode-choice\]\[data-active="true"\]/);
});

test('run timeline uses user-facing action transcript and undo language', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /我会先理解你的请求/);
  assert.match(contentScript, /正在同步 Overleaf 项目到本地 Codex workspace/);
  assert.match(contentScript, /本地 Codex session 开始运行/);
  assert.match(contentScript, /同步本地 Codex 改动到 Overleaf/);
  assert.match(contentScript, /本地 Codex 改动已同步回 Overleaf/);
  assert.match(contentScript, /undoCheckpointPlain/);
  assert.match(contentScript, /undoNoTraceTitle/);
  assert.doesNotMatch(contentScript, /Starting \$\{state\.mode\} task/);
  assert.doesNotMatch(contentScript, /Apply result:/);
  assert.doesNotMatch(contentScript, /Undo checkpoint recorded:/);
});

test('task runs sync the full project only when a Codex run starts', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function handleTaskResult/)?.[0] || '';

  assert.match(runTaskBody, /getRunProjectSnapshot\(\)/);
  assert.match(contentScript, /preferLightweight:\s*true/);
  assert.match(contentScript, /allowZipFallback:\s*true/);
  assert.match(contentScript, /requireFullProject:\s*true/);
  assert.doesNotMatch(runTaskBody, /getProjectSnapshot', \{ force: true \}/);
  assert.match(runTaskBody, /method: 'codex\.run'/);
  assert.match(runTaskBody, /syncChanges/);
  assert.match(runTaskBody, /applySyncChangesToOverleaf/);
  assert.doesNotMatch(runTaskBody, /scheduleProjectSync\(/);
  assert.match(contentScript, /async function applySyncChangesToOverleaf/);
});

test('project settings expose governed rules and local skills without Overleaf asset upload controls', () => {
  const contentScript = getContentScriptSource();
  const attachmentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerAttachments.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );
  const localSkillsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/localSkillsPanel.js'),
    'utf8'
  );
  const settingsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/settingsPanel.js'),
    'utf8'
  );
  const settingsSource = `${contentScript}\n${settingsPanel}`;

  assert.match(settingsSource, /data-project-settings-panel/);
  assert.match(settingsSource, /data-governance-readonly-patterns/);
  assert.match(settingsSource, /data-governance-writable-patterns/);
  assert.match(settingsSource, /data-sensitive-check-enabled/);
  assert.match(settingsSource, /data-sensitive-confirm-allowed/);
  assert.match(settingsSource, /data-load-codex-local-skills/);
  assert.match(settingsSource, /data-load-codex-overleaf-skills/);
  assert.match(settingsSource, /data-local-skill-list/);
  assert.match(contentScript, /CodexOverleafLocalSkillsPanel/);
  assert.match(contentScript, /getLocalSkillsPanel\(\)\.refreshLocalSkills/);
  assert.match(localSkillsPanel, /codexOverleafSkills/);
  assert.match(localSkillsPanel, /function getCodexOverleafSkillsForSettings/);
  assert.match(localSkillsPanel, /function removeCodexOverleafSkill/);
  assert.match(localSkillsPanel, /params:\s*\{\s*scope:\s*'codex-overleaf'\s*\}/);
  assert.doesNotMatch(contentScript, /data-local-skill-install-id/);
  assert.doesNotMatch(contentScript, /data-local-skill-install-content/);
  assert.doesNotMatch(contentScript, /installLocalSkillFromSettings/);
  assert.doesNotMatch(contentScript, /data-asset-upload/);
  assert.doesNotMatch(contentScript, /uploadSelectedAssets/);
  assert.doesNotMatch(contentScript, /getAssetUploadBaseline/);
  assert.match(contentScript, /function normalizeGovernanceRulesByProject/);
  assert.doesNotMatch(contentScript, /function normalizeSelectedLocalSkillIdsByProject/);
  assert.match(contentScript, /function readSkillLoadingSettingsFromSettings/);
  assert.match(contentScript, /loadCodexLocalSkills/);
  assert.match(contentScript, /loadCodexOverleafSkills/);
  assert.match(contentScript, /governanceRulesByProject/);
  assert.match(contentScript, /method:\s*'skills\.list'/);
  assert.match(localSkillsPanel, /method:\s*'skills\.remove'/);
  assert.doesNotMatch(localSkillsPanel, /projectLocalSkillsTitle/);
  assert.doesNotMatch(localSkillsPanel, /localSkillsEmpty/);
  assert.doesNotMatch(localSkillsPanel, /data-local-skill-selected/);
  assert.match(css, /\.codex-project-settings-panel/);
  assert.match(css, /\.codex-local-skill-list/);
  assert.doesNotMatch(css, /\.codex-local-skill-install-row/);
  assert.doesNotMatch(css, /\.codex-asset-upload-row/);
  assert.match(i18n, /projectSettingsTitle/);
  assert.match(i18n, /governanceReadonlyPatterns/);
  assert.match(i18n, /localSkillsTitle/);
  assert.doesNotMatch(i18n, /projectLocalSkillsTitle/);
  assert.doesNotMatch(i18n, /localSkillsEmpty/);
  // codexOverleafSkillsTitle is the dedicated skills sub-page header title.
  assert.match(i18n, /codexOverleafSkillsTitle/);
  assert.match(i18n, /codexOverleafSkillsEmpty/);
  assert.match(i18n, /loadCodexLocalSkills/);
  assert.match(i18n, /loadCodexOverleafSkills/);
  assert.doesNotMatch(i18n, /assetUploadTitle/);
});

test('project settings renders only Codex Overleaf managed skills', async () => {
  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');
  const document = createMinimalDocument();
  const panel = document.createElement('div');
  const list = document.createElement('div');
  list.setAttribute('data-local-skill-list', '');
  panel.append(list);
  const requests = [];
  let state = {};
  let overleafEnabled = true;
  let slashSkills = [];
  const labels = {
    codexOverleafSkillsEmpty: 'No Codex Overleaf skills installed.',
    codexOverleafSkillsDisabled: 'Codex Overleaf skills are disabled.',
    localSkillRemove: 'Remove'
  };
  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document,
    getPanel: () => panel,
    getState: () => state,
    setState: nextState => {
      state = nextState;
    },
    getCurrentProjectId: () => 'project-1',
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: overleafEnabled }),
    tr: key => labels[key] || key,
    sendBackgroundNative(request) {
      requests.push(request);
      if (request.params?.scope === 'codex-overleaf') {
        return Promise.resolve({
          ok: true,
          result: {
            skills: [
              {
                id: 'auto-rebuttal',
                title: 'Auto Rebuttal',
                scope: 'codex-overleaf'
              }
            ]
          }
        });
      }
      return Promise.resolve({ ok: true, result: { skills: [] } });
    },
    setSlashCodexOverleafSkills(skills) {
      slashSkills = skills;
    }
  });

  await controller.refreshLocalSkills();

  assert.deepEqual(
    requests.map(request => request.params),
    [{ scope: 'codex-overleaf' }]
  );
  assert.equal(slashSkills[0]?.id, 'auto-rebuttal');
  assert.doesNotMatch(collectElementText(list), /project-local/i);
  assert.match(collectElementText(list), /Auto Rebuttal/);

  overleafEnabled = false;
  controller.renderLocalSkillList();

  assert.match(collectElementText(list), /Codex Overleaf skills are disabled/);
  assert.match(collectElementText(list), /Auto Rebuttal/);
});

test('project settings omits the remove button for official skills with removable: false', async () => {
  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');
  const document = createMinimalDocument();
  const panel = document.createElement('div');
  const list = document.createElement('div');
  list.setAttribute('data-local-skill-list', '');
  panel.append(list);
  let state = {};
  const labels = {
    codexOverleafSkillsEmpty: 'No Codex Overleaf skills installed.',
    codexOverleafSkillsDisabled: 'Codex Overleaf skills are disabled.',
    localSkillRemove: 'Remove'
  };
  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document,
    getPanel: () => panel,
    getState: () => state,
    setState: nextState => {
      state = nextState;
    },
    getCurrentProjectId: () => 'project-1',
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: true }),
    tr: key => labels[key] || key,
    sendBackgroundNative() {
      return Promise.resolve({
        ok: true,
        result: {
          skills: [
            {
              id: 'annotated-rewrite',
              title: 'Annotated Rewrite',
              scope: 'codex-overleaf',
              official: true,
              removable: false
            },
            {
              id: 'custom-style',
              title: 'Custom Style',
              scope: 'codex-overleaf',
              official: false,
              removable: true
            }
          ]
        }
      });
    },
    setSlashCodexOverleafSkills() {}
  });

  await controller.refreshLocalSkills();

  const rows = collectElements(
    list,
    node => node.className === 'codex-local-skill-row'
  );
  // Row text now shows the human title only ("Annotated Rewrite"); the id
  // is exposed as the accessible `title` tooltip attribute on the label span
  // for advanced users. Tests find rows by the visible title.
  const officialRow = rows.find(row =>
    collectElementText(row).includes('Annotated Rewrite')
  );
  const customRow = rows.find(row =>
    collectElementText(row).includes('Custom Style')
  );

  assert.ok(officialRow, 'official skill row should be present');
  assert.equal(
    collectElements(officialRow, node => node.tagName === 'BUTTON').length,
    0,
    'official skill should not have a remove button'
  );
  assert.ok(customRow, 'custom skill row should be present');
  assert.ok(
    collectElements(customRow, node => node.tagName === 'BUTTON').length > 0,
    'custom skill should have a remove button'
  );
});

test('composer slash menu offers Codex Overleaf skill installation and installed skills', () => {
  const contentScript = getContentScriptSource();
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );
  const composerSource = `${contentScript}\n${composerPanel}`;
  const keydownBody = contentScript.match(/function handleTaskInputKeydown\(event\) \{[\s\S]*?\n  function createDiffReviewElement/)?.[0] || '';
  const selectBody = extractFromContentScript( 'selectSlashCommand');
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function preflightWriteSafety/)?.[0] || '';

  assert.match(composerSource, /data-slash-menu/);
  assert.match(composerSource, /data-slash-command="install-skill"/);
  assert.match(composerSource, /data-slash-command-kind/);
  assert.match(contentScript, /scope:\s*'codex-overleaf'/);
  assert.match(composerSource, /data-composer-skill-context/);
  assert.match(composerSource, /data-composer-skill-label/);
  assert.match(composerSource, /data-composer-skill-clear/);
  assert.match(keydownBody, /handleSlashMenuKeydown\(event\)/);
  assert.match(contentScript, /function updateSlashMenuForTaskInput/);
  assert.match(contentScript, /function refreshCodexOverleafSkillsForSlashMenu/);
  assert.match(contentScript, /function selectSlashCommand/);
  assert.match(contentScript, /function activateSkillInstallerComposerContext/);
  assert.match(contentScript, /function activateCodexOverleafSkillComposerContext/);
  assert.match(contentScript, /function getComposerSkillInvocationForRun/);
  assert.match(contentScript, /async function runSkillInstallerTask/);
  assert.match(selectBody, /activateSkillInstallerComposerContext\(\)/);
  assert.match(selectBody, /activateCodexOverleafSkillComposerContext/);
  assert.match(runTaskBody, /const submittedSkillInvocation = getComposerSkillInvocationForRun\(\)/);
  assert.match(runTaskBody, /submittedSkillInvocation\?\.id === 'skill-installer'[\s\S]*runSkillInstallerTask/);
  assert.match(runTaskBody, /try\s*\{[\s\S]*?if \(submittedSkillInvocation\?\.id === 'skill-installer'\)[\s\S]*runSkillInstallerTask/);
  assert.match(runTaskBody, /finally\s*\{[\s\S]*setRunning\(false\)[\s\S]*nativeChannel\.clearActiveRequest\(\)/);
  assert.match(runTaskBody, /skillInvocation:\s*submittedSkillInvocation/);
  assert.match(contentScript, /skipMirrorSync:\s*true/);
  assert.doesNotMatch(contentScript, /function showCodexOverleafSkillInstallDialog/);
  assert.match(css, /\.codex-slash-menu/);
  assert.match(css, /\.codex-composer-skill-context/);
  assert.doesNotMatch(css, /\.codex-skill-install-dialog/);
  assert.match(i18n, /slashInstallSkillTitle/);
  assert.match(i18n, /slashUseSkillSubtitle/);
  assert.match(i18n, /skillInstallerComposerLabel/);
  assert.match(i18n, /skillInstallerComposerClear/);
});

test('task runs use sensitive preflight, skill toggles, governance gating, binary confirmation, and audit summaries', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function preflightWriteSafety/)?.[0] || '';
  const applyBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  async function verifyPostWriteSaveState/)?.[0] || '';

  assert.match(contentScript, /CodexOverleafGovernanceRules/);
  assert.match(contentScript, /CodexOverleafSensitiveScan/);
  assert.match(contentScript, /CodexOverleafAuditRecords/);
  assert.doesNotMatch(runTaskBody, /submittedSelectedSkillIds/);
  assert.match(runTaskBody, /const submittedSkillLoadingSettings = getSkillLoadingSettings\(\)/);
  assert.match(runTaskBody, /createAuditDraftForRun/);
  assert.match(runTaskBody, /runSensitivePreflight\(\{\s*task,\s*project/);
  assert.match(runTaskBody, /runSensitivePreflight\(\{[\s\S]*useExistingMirror/);
  assert.doesNotMatch(runTaskBody, /selectedSkillIds:\s*submittedSelectedSkillIds/);
  assert.match(runTaskBody, /skillLoadingSettings:\s*submittedSkillLoadingSettings/);
  assert.match(runTaskBody, /finalizeAuditRecord/);
  assert.match(runTaskBody, /sensitiveFindings/);
  assert.match(applyBody, /evaluateGovernedOperations/);
  assert.match(applyBody, /buildGovernanceSkippedApplyResult/);
  assert.match(applyBody, /confirmBinaryOperations/);
  assert.match(applyBody, /binary-create|overwrite-binary/);
  assert.match(applyBody, /blockedFiles/);
  assert.match(applyBody, /skippedFiles/);
  assert.match(applyBody, /appliedFiles/);
  assert.match(contentScript, /buildAuditDiffSummary/);
  assert.doesNotMatch(contentScript, /fullDiff\s*:/);
  assert.doesNotMatch(contentScript, /compileLog\s*:/);
});

test('composer supports pasted or dropped turn attachments without Overleaf asset writeback', () => {
  const contentScript = getContentScriptSource();
  const attachmentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerAttachments.js'),
    'utf8'
  );
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function preflightWriteSafety/)?.[0] || '';
  const clearBody = extractFromContentScript( 'clearTaskComposer');
  const scriptOrder = manifest.content_scripts[0].js;

  assert.match(composerPanel, /data-attachment-strip/);
  assert.ok(
    scriptOrder.indexOf('src/content/composerAttachments.js') < scriptOrder.indexOf('src/contentScript.js'),
    'composer attachment controller loads before contentScript'
  );
  assert.match(composerPanel, /'paste'/);
  assert.match(composerPanel, /'dragover'/);
  assert.match(composerPanel, /'drop'/);
  assert.match(contentScript, /onPaste:\s*handleComposerPaste/);
  assert.match(contentScript, /onDragOver:\s*handleComposerDragOver/);
  assert.match(contentScript, /onDrop:\s*handleComposerDrop/);
  assert.match(attachmentScript, /createComposerAttachmentController/);
  assert.match(contentScript, /function addComposerAttachmentFiles/);
  assert.match(contentScript, /function renderComposerAttachments/);
  assert.match(runTaskBody, /const submittedAttachments = getComposerAttachmentsForRun\(\)/);
  assert.match(runTaskBody, /attachments:\s*submittedAttachments/);
  assert.match(clearBody, /composerAttachmentController\.clear\(\)/);
  assert.doesNotMatch(contentScript, /User-selected asset upload/);
  assert.doesNotMatch(contentScript, /asset_upload_rejected/);
  assert.doesNotMatch(contentScript, /mode:\s*'asset-upload'/);
});

test('composer paste collects clipboard file items once when files and items both expose the same paste', () => {
  const attachmentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerAttachments.js'),
    'utf8'
  );
  const collectFilesFromDataTransfer = vm.runInNewContext(`
    ${extractFunction(attachmentScript, 'normalizeAttachmentName')}
    (${extractFunction(attachmentScript, 'collectFilesFromDataTransfer')})
  `);
  const filesEntry = { name: 'image.png', type: 'image/png', size: 128, lastModified: 1 };
  const itemEntry = { name: 'clipboard-image.png', type: 'image/png', size: 128, lastModified: 2 };

  const files = collectFilesFromDataTransfer({
    files: [filesEntry],
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => itemEntry }
    ]
  });

  assert.equal(files.length, 1);
  assert.equal(files[0], itemEntry);
});

test('composer attachment adds dedupe the same file while async reads are pending', async () => {
  const attachmentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerAttachments.js'),
    'utf8'
  );
  const sandbox = {
    window: {},
    document: {},
    console,
    setTimeout,
    clearTimeout
  };
  const pendingReads = [];
  sandbox.FileReader = class FakeFileReader {
    readAsDataURL() {
      pendingReads.push(() => {
        this.result = 'data:image/png;base64,aGVsbG8=';
        this.onload?.();
      });
    }
  };
  vm.runInNewContext(attachmentScript, sandbox);
  const controller = sandbox.window.CodexOverleafComposerAttachments.createComposerAttachmentController({
    getPanel: () => ({ querySelector: () => null }),
    tx: (en) => en,
    tr: (key) => key,
    appendPlainLog() {}
  });
  const file = { name: 'image.png', type: 'image/png', size: 128 };

  const first = controller.addFiles([file]);
  const second = controller.addFiles([file]);
  for (const resolve of pendingReads.splice(0)) {
    resolve();
  }
  await Promise.all([first, second]);

  assert.equal(controller.getAttachmentsForRun().length, 1);
});

test('composer and run history render image previews and file attachment icons', () => {
  const contentScript = getContentScriptSource();
  const attachmentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerAttachments.js'),
    'utf8'
  );
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const composerMarkup = composerPanel.match(/<form class="codex-composer" data-composer-form>[\s\S]*?<\/form>/)?.[0] || '';
  const startRunBody = contentScript.match(/function startRunView\(\{[\s\S]*?\n  function finishRunView/)?.[0] || '';
  const renderCardBody = contentScript.match(/function renderRunCard\(run\) \{[\s\S]*?\n  function getRunStatusText/)?.[0] || '';
  const renderAttachmentsBody = attachmentScript.match(/function renderAttachmentPreviewList[\s\S]*?\n  function showAttachmentPreviewDialog/)?.[0] || '';

  assert.ok(
    composerMarkup.indexOf('data-attachment-strip') < composerMarkup.indexOf('<textarea data-task'),
    'attachment previews render above the composer textarea'
  );
  assert.match(attachmentScript, /function buildAttachmentPreviewData/);
  assert.match(contentScript, /function createRunAttachmentSnapshots/);
  assert.match(startRunBody, /attachments = \[\]/);
  assert.match(startRunBody, /attachments:\s*createRunAttachmentSnapshots\(attachments\)/);
  assert.match(renderCardBody, /data-run-attachments/);
  assert.match(renderCardBody, /renderAttachmentPreviewList\(run\.attachments/);
  assert.match(renderAttachmentsBody, /document\.createElement\('img'\)/);
  assert.match(renderAttachmentsBody, /codex-attachment-file-icon/);
  assert.match(renderAttachmentsBody, /showAttachmentPreviewDialog\(attachment/);
  assert.match(attachmentScript, /function showAttachmentPreviewDialog\(attachment/);
  assert.match(attachmentScript, /data-attachment-preview-dialog/);
  assert.match(css, /\.codex-attachment-preview-list/);
  assert.match(css, /\.codex-attachment-preview-card/);
  assert.match(css, /\.codex-attachment-preview-dialog/);
});

test('reused mirror sensitive preflight scans native mirror before Codex dispatch', () => {
  const contentScript = getContentScriptSource();
  const preflightBody = extractFromContentScript( 'runSensitivePreflight');

  assert.match(preflightBody, /useExistingMirror/);
  assert.match(preflightBody, /scanNativeMirrorSensitiveFindings/);
  assert.doesNotMatch(preflightBody, /sensitiveCheckEnabled === false \|\| !SensitiveScan/);
  assert.match(contentScript, /method:\s*'mirror\.scanSensitive'/);
  assert.match(contentScript, /mirror-sensitive-scan-unavailable/);
});

test('post-write compile summaries are included in the final completion report', () => {
  const contentScript = getContentScriptSource();
  const applyBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  async function verifyPostWriteSaveState/)?.[0] || '';
  const compileBody = contentScript.match(/async function autoRecompileAfterWriteback[\s\S]*?\n  async function resolveCompileLogContext/)?.[0] || '';

  assert.match(applyBody, /const compileSummary = appliedPaths\.length/);
  assert.match(applyBody, /appendCompileSummaryToConclusion\(writebackConclusion,\s*compileSummary\)/);
  assert.match(compileBody, /return buildPostWriteCompileSummary/);
  assert.match(compileBody, /callPageBridge\('getCompileLog'/);
  assert.match(contentScript, /function appendCompileSummaryToConclusion/);
});

test('task run snapshots request binary assets so local LaTeX can see Figures directories', () => {
  const contentScript = getContentScriptSource();
  const getRunProjectSnapshotBody = contentScript.match(/async function getRunProjectSnapshot\(\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(getRunProjectSnapshotBody, /includeBinaryFiles:\s*true/);
  assert.match(getRunProjectSnapshotBody, /zipOnly:\s*true/);
  assert.match(contentScript, /资源文件/);
});

test('task run snapshots bypass cache so Codex sees the latest Overleaf state', () => {
  const contentScript = getContentScriptSource();
  const getRunProjectSnapshotBody = contentScript.match(/async function getRunProjectSnapshot\(\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(getRunProjectSnapshotBody, /force:\s*true/);
  assert.match(getRunProjectSnapshotBody, /maxAgeMs:\s*0/);
});

test('whole-project ZIP sync waits long enough before falling back to focused files', () => {
  const contentScript = getContentScriptSource();
  const getRunProjectSnapshotBody = contentScript.match(/async function getRunProjectSnapshot\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const timeoutBody = contentScript.match(/function getPageBridgeTimeoutMs\(method\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(contentScript, /const RUN_SNAPSHOT_ZIP_TIMEOUT_MS\s*=\s*30000/);
  assert.match(contentScript, /const SNAPSHOT_PAGE_BRIDGE_TIMEOUT_MS\s*=\s*70000/);
  assert.match(getRunProjectSnapshotBody, /zipTimeoutMs:\s*RUN_SNAPSHOT_ZIP_TIMEOUT_MS/);
  assert.match(timeoutBody, /return SNAPSHOT_PAGE_BRIDGE_TIMEOUT_MS/);
});

test('task run blocks unfocused partial project snapshots before they can rewrite the local mirror', () => {
  const contentScript = getContentScriptSource();
  const warningsBody = contentScript.match(/function getProjectSnapshotWarnings\(project\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(warningsBody, /fullProjectSnapshot/);
  assert.match(contentScript, /没有读到完整的 Overleaf 项目/);
  assert.match(contentScript, /snapshotWarnings\.blocking\.length && !warmMirrorReuse\.useExistingMirror && !focusedPartialSnapshot/);
  assert.match(contentScript, /只读到你选择的上下文文件/);
});

test('fresh warm mirror can carry a run when Overleaf only returns a partial snapshot', () => {
  const contentScript = getContentScriptSource();
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );

  assert.match(contentScript, /async function resolveWarmMirrorReuse/);
  assert.match(contentScript, /Full project snapshot was not captured/);
  assert.match(contentScript, /classifyMirrorHealth\(mirrorStatus\)/);
  assert.match(contentScript, /mirrorHealth\.reusable/);
  assert.match(contentScript, /tr\('warmMirrorPartialOverlayTitle'\)/);
  assert.match(i18n, /没有读到完整 Overleaf 项目，但本地 workspace 刚同步过/);
  assert.match(contentScript, /mergeProjectWithSyncChangeBaseFiles\(project,\s*syncChanges\)/);
});

test('successful Overleaf writeback refreshes page snapshot cache and native mirror baseline', () => {
  const contentScript = getContentScriptSource();
  const applyBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  function buildSyncApplyOperations/)?.[0] || '';

  assert.match(applyBody, /refreshProjectMirrorAfterWriteback\(project, applied, saveVerification\)/);
  assert.match(contentScript, /invalidateProjectSnapshot/);
  assert.match(contentScript, /method:\s*'mirror\.sync'/);
});

test('post-write side effects wait for verified Overleaf save state', () => {
  const contentScript = getContentScriptSource();
  const applyBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  function buildSyncApplyOperations/)?.[0] || '';
  const verifyBody = contentScript.match(/async function verifyPostWriteSaveState[\s\S]*?\n  async function refreshProjectMirrorAfterWriteback/)?.[0] || '';

  const applyIndex = applyBody.indexOf("await callPageBridge('applyOperations'");
  const verifyIndex = applyBody.indexOf('verifyPostWriteSaveState()');
  const refreshIndex = applyBody.indexOf('refreshProjectMirrorAfterWriteback(project, applied, saveVerification)');
  const recompileIndex = applyBody.indexOf('autoRecompileAfterWriteback(appliedPaths, saveVerification)');

  assert.ok(applyIndex >= 0, 'applyOperations call is present');
  assert.ok(verifyIndex > applyIndex, 'save verification happens after applyOperations');
  assert.ok(refreshIndex > verifyIndex, 'mirror refresh happens after save verification');
  assert.ok(recompileIndex > verifyIndex, 'auto compile happens after save verification');
  assert.match(verifyBody, /callPageBridge\('waitForSaveState', \{\s*deadlineMs:\s*5000,\s*requirePositiveSignal:\s*true\s*\}\)/);
  assert.match(verifyBody, /state:\s*'verified_saved'/);
  assert.match(verifyBody, /state:\s*'unknown_timeout'/);
  assert.match(verifyBody, /state:\s*'unavailable'/);
  assert.match(applyBody, /appendPostWriteSaveVerificationWarning\(saveVerification\)/);
});

test('empty or malformed apply results do not trigger save verification', () => {
  const contentScript = getContentScriptSource();
  const applyBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  function buildSyncApplyOperations/)?.[0] || '';
  const helperBody = contentScript.match(/function hasApplyResultEntries\(applied = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const appliedHelperBody = contentScript.match(/function getAppliedEntries\(applied = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const skippedHelperBody = contentScript.match(/function getSkippedEntries\(applied = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const hasApplyResultEntries = Function(`${appliedHelperBody}\n${skippedHelperBody}\nreturn (${helperBody});`)();

  assert.match(contentScript, /function hasApplyResultEntries\(applied = \{\}\)/);
  assert.match(contentScript, /function getAppliedEntries\(applied = \{\}\)/);
  assert.match(helperBody, /getAppliedEntries\(applied\)/);
  assert.match(helperBody, /getSkippedEntries\(applied\)/);
  assert.match(appliedHelperBody, /Array\.isArray\(applied\?\.applied\)/);
  assert.match(skippedHelperBody, /Array\.isArray\(applied\?\.skipped\)/);
  assert.equal(hasApplyResultEntries({ applied: 'x' }), false);
  assert.equal(hasApplyResultEntries({ skipped: { length: 1 } }), false);
  assert.equal(hasApplyResultEntries({ applied: [], skipped: [] }), false);
  assert.equal(hasApplyResultEntries({ applied: [{}] }), true);
  assert.equal(hasApplyResultEntries({ skipped: [{}] }), true);
  assert.match(applyBody, /const hasConfirmedApplyResult = hasApplyResultEntries\(applied\)/);
  // v1.6.2: the save-verify probe + its warning gate on the count of APPLIED
  // writes, so an all-skipped (zero-write) run never wastes ~5s probing nor
  // emits the misleading "could not verify saved" warning.
  assert.match(applyBody, /const saveVerification = appliedPaths\.length\s*\n?\s*\?[\s\S]*?verifyPostWriteSaveState\(\)[\s\S]*?:/);
  assert.match(applyBody, /if \(appliedPaths\.length\) \{[\s\S]*?appendPostWriteSaveVerificationWarning\(saveVerification\)/);
});

test('malformed skipped apply result entries are not treated as partial writeback', () => {
  const contentScript = getContentScriptSource();
  const applyBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  async function verifyPostWriteSaveState/)?.[0] || '';
  const applyTaskBody = contentScript.match(/async function applyTaskOperations[\s\S]*?\n  async function ensureReviewingBeforeWrite/)?.[0] || '';
  const recordUndoBody = contentScript.match(/function recordUndoFromApply\(project, applyResult\) \{[\s\S]*?\n  function normalizeApplyTrackedChanges/)?.[0] || '';
  const helperBody = contentScript.match(/function getSkippedEntries\(applied = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(contentScript, /function getSkippedEntries\(applied = \{\}\)/);
  const getSkippedEntries = Function(`return (${helperBody});`)();
  assert.match(helperBody, /Array\.isArray\(applied\?\.skipped\)/);
  assert.deepEqual(getSkippedEntries({ skipped: 'x' }), []);
  assert.deepEqual(getSkippedEntries({ skipped: { length: 1 } }), []);
  assert.deepEqual(getSkippedEntries({ skipped: [{}] }), [{}]);
  assert.match(applyBody, /const skippedEntries = getSkippedEntries\(applied\)/);
  assert.doesNotMatch(applyBody, /applied\?\.skipped\?\.length|applied\.skipped\?\.length/);
  assert.match(recordUndoBody, /const skippedEntries = getSkippedEntries\(applyResult\)/);
  assert.doesNotMatch(recordUndoBody, /applyResult\.skipped\?\.length/);
  assert.match(applyTaskBody, /\.\.\.getSkippedEntries\(applied\)/);
  assert.doesNotMatch(applyTaskBody, /\.\.\.\(applied\.skipped \|\| \[\]\)/);
});

test('post-write mirror refresh waits for verified save but auto compile still delegates to compile bridge', () => {
  const contentScript = getContentScriptSource();
  const refreshBody = contentScript.match(/async function refreshProjectMirrorAfterWriteback[\s\S]*?\n  function getAppliedOperationPaths/)?.[0] || '';
  const autoCompileBody = contentScript.match(/async function autoRecompileAfterWriteback[\s\S]*?\n  async function resolveCompileLogContext/)?.[0] || '';
  const saveWarningBody = contentScript.match(/function appendPostWriteSaveVerificationWarning[\s\S]*?\n  async function refreshProjectMirrorAfterWriteback/)?.[0] || '';

  assert.match(refreshBody, /async function refreshProjectMirrorAfterWriteback\(project = \{\}, applied = \{\}, saveVerification = \{\}\)/);
  assert.match(autoCompileBody, /async function autoRecompileAfterWriteback\(writtenPaths = \[\], saveVerification = \{\}\)/);
  assert.match(refreshBody, /saveVerification\?\.state !== 'verified_saved'[\s\S]*?return;/);
  assert.doesNotMatch(autoCompileBody, /saveVerification\?\.state !== 'verified_saved'[\s\S]*?return;/);
  assert.ok(
    refreshBody.indexOf("saveVerification?.state !== 'verified_saved'") < refreshBody.indexOf("callPageBridge('invalidateProjectSnapshot'"),
    'mirror refresh checks verified save before invalidating snapshot cache'
  );
  assert.ok(
    refreshBody.indexOf("saveVerification?.state !== 'verified_saved'") < refreshBody.indexOf("callPageBridge('getProjectSnapshot'"),
    'mirror refresh checks verified save before fetching a fresh snapshot'
  );
  assert.ok(
    refreshBody.indexOf("saveVerification?.state !== 'verified_saved'") < refreshBody.indexOf("method: 'mirror.sync'"),
    'mirror refresh checks verified save before syncing native mirror'
  );
  assert.match(autoCompileBody, /callPageBridge\('triggerCompile', \{[\s\S]*requireVerifiedSave:\s*saveVerification\?\.state === 'verified_saved'/);
  assert.match(autoCompileBody, /saveVerification\?\.state !== 'verified_saved'[\s\S]*Overleaf save was not verified, but Auto Compile is on/);
  assert.doesNotMatch(saveWarningBody, /auto compile (?:was|were) skipped/);
});

test('no-change writeback path does not wait for Overleaf save verification', () => {
  const contentScript = getContentScriptSource().replace(/\r\n/g, '\n');
  const applyBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  function buildSyncApplyOperations/)?.[0] || '';
  const noChangeBlock = applyBody.match(/if \(!operations\.length\) \{[\s\S]*?return \{[\s\S]*?\n      \};\n    \}/)?.[0] || '';

  assert.doesNotMatch(noChangeBlock, /verifyPostWriteSaveState/);
  assert.ok(
    noChangeBlock.length && applyBody.indexOf(noChangeBlock) < applyBody.indexOf('verifyPostWriteSaveState'),
    'no-change path returns before save verification'
  );
});

test('post-write mirror refresh refuses partial snapshots before touching native baseline', () => {
  const contentScript = getContentScriptSource();
  const refreshBody = contentScript.match(/async function refreshProjectMirrorAfterWriteback[\s\S]*?\n  function mergeVerifiedAppliedFiles/)?.[0] || '';

  assert.match(refreshBody, /capabilities\?\.fullProjectSnapshot/);
  assert.match(refreshBody, /没有读到完整项目/);
  assert.match(refreshBody, /return;\s*\}\s*\n\s*const syncedProject/);
});

test('idle background sync does not poll or touch the Overleaf editor', () => {
  const contentScript = getContentScriptSource();
  const initBody = contentScript.match(/async function init\(\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.doesNotMatch(initBody, /initWarmMirror/);
  assert.doesNotMatch(initBody, /scheduleProjectSync/);
  assert.doesNotMatch(initBody, /mirror\.sync/);
  assert.doesNotMatch(contentScript, /setInterval\(\(\) => \{[\s\S]*syncMirrorBackground/);
  assert.doesNotMatch(contentScript, /function scheduleProjectSync/);
  assert.doesNotMatch(initBody, /scheduleProbeRefresh/);
  assert.doesNotMatch(initBody, /installInteractionRefresh/);
});

test('mirror prefetch is non-invasive and never enables editor navigation', () => {
  const contentScript = getContentScriptSource();
  const prefetchBody = contentScript.match(/async function syncMirrorPrefetch[\s\S]*?\n  function/)?.[0] || '';

  assert.match(prefetchBody, /allowEditorNavigation:\s*false/);
  assert.match(prefetchBody, /requireFullProject:\s*true/);
  assert.doesNotMatch(prefetchBody, /openFileByPath/);
});

test('warm send checks mirror status before full project snapshot fallback', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function preflightWriteSafety/)?.[0] || '';

  assert.match(runTaskBody, /resolveWarmRunStart/);
  assert.ok(runTaskBody.indexOf('resolveWarmRunStart') < runTaskBody.indexOf('getRunProjectSnapshot'));
});

test('send waits for in-flight mirror prefetch before starting codex run', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function preflightWriteSafety/)?.[0] || '';
  const helperBody = contentScript.match(/async function settleMirrorPrefetchBeforeRun\(\) \{[\s\S]*?\n  function/)?.[0] || '';

  assert.match(runTaskBody, /await awaitRunStep\(settleMirrorPrefetchBeforeRun\(\)\)/);
  assert.ok(runTaskBody.indexOf('await awaitRunStep(settleMirrorPrefetchBeforeRun())') < runTaskBody.indexOf("method: 'codex.run'"));
  assert.match(helperBody, /mirrorPrefetchState\.timer/);
  assert.match(helperBody, /window\.clearTimeout\(mirrorPrefetchState\.timer\)/);
  assert.match(helperBody, /mirrorPrefetchState\.inFlight/);
  assert.match(helperBody, /await mirrorPrefetchState\.inFlight/);
  assert.match(helperBody, /isExpectedPrefetchSkip/);
});

test('warm send verifies a non-invasive current or focus overlay before reusing mirror', () => {
  const contentScript = getContentScriptSource();
  const warmStartBody = contentScript.match(/async function resolveWarmRunStart[\s\S]*?\n  async function prepareMirrorStaleRetry/)?.[0] || '';

  assert.match(warmStartBody, /callPageBridge\('getProjectSnapshot'/);
  assert.match(warmStartBody, /allowEditorNavigation:\s*false/);
  assert.match(warmStartBody, /allowZipFallback:\s*false/);
  assert.match(warmStartBody, /restrictToRequestedPathsOnly:\s*true/);
  assert.match(warmStartBody, /buildSnapshotFileOverlays/);
  assert.match(warmStartBody, /catch \(error\)[\s\S]*useExistingMirror:\s*false/);
  assert.doesNotMatch(warmStartBody, /fileOverlays:\s*\[\]/);
  assert.doesNotMatch(warmStartBody, /fullProjectSnapshot:\s*true[\s\S]*method:\s*'warm-mirror'/);
});

test('focused OT freshness is checked before project-level warm mirror freshness', () => {
  const contentScript = getContentScriptSource();
  const otWarmMirrorController = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/otWarmMirrorController.js'),
    'utf8'
  );
  const warmStartBody = contentScript.match(/async function resolveWarmRunStart[\s\S]*?\n  async function prepareMirrorStaleRetry/)?.[0] || '';

  assert.match(warmStartBody, /otWarmMirrorController\.canUseOtWarmStart/);
  assert.ok(
    warmStartBody.indexOf('canUseOtWarmStart') < warmStartBody.indexOf('isMirrorReusable'),
    'OT per-file freshness must be considered before project-level freshness rejects the mirror'
  );
  assert.match(warmStartBody, /enabled:\s*isExperimentalOtEnabled\(\)/);
  assert.match(warmStartBody, /focusFiles/);
  assert.match(warmStartBody, /otWarmStart:\s*true/);
  assert.match(warmStartBody, /reason:\s*'ot_focus_fresh'/);
  assert.match(warmStartBody, /fullProjectSnapshot:\s*false/);
  assert.match(warmStartBody, /method:\s*'ot-warm-mirror'/);
  assert.match(otWarmMirrorController, /reason:\s*'no_focus_files'/);
  assert.doesNotMatch(warmStartBody, /otFreshFileCount/);
});

test('OT warm starts route focus restrictions through the shared writeback policy', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  function buildCodexRunParams/)?.[0] || '';
  const runParamBlocks = Array.from(runTaskBody.matchAll(/buildCodexRunParams\(\{[\s\S]*?submittedMode\s*\}/g))
    .map(match => match[0]);

  assert.match(
    runTaskBody,
    /restrictToFocusFiles\s*=\s*runController\.shouldRestrictWritebackToFocus\(\{\s*focusFiles,\s*focusedPartialSnapshot:\s*warmMirrorReuse\.partialSnapshot,\s*otWarmStart\s*\}\)/
  );
  assert.ok(runParamBlocks.length >= 3, 'initial, mirror-stale retry, and thread-resume run params should be visible');
  for (const block of runParamBlocks) {
    assert.match(block, /otWarmStart/);
    assert.match(block, /restrictToFocusFiles/);
  }
});

test('experimental OT warm mirror polls page OT events and patches the native mirror', () => {
  const contentScript = getContentScriptSource();
  const pollBody = extractFromContentScript( 'pollOtEvents');
  const flushBody = extractFromContentScript( 'flushOtPatchBatch');

  assert.match(contentScript, /CodexOverleafOtWarmMirrorController/);
  assert.match(contentScript, /function scheduleOtEventPolling/);
  assert.match(contentScript, /function clearOtEventPolling/);
  assert.match(pollBody, /otWarmMirrorController\.shouldPauseOtWarmMirror\(\{\s*running:\s*Boolean\(getCurrentRunView\(\)\)\s*\}\)/);
  assert.match(pollBody, /callPageBridge\('getOtStatus'/);
  assert.match(pollBody, /callPageBridge\('drainOtEvents'/);
  assert.match(pollBody, /queueOtPatchEvents/);
  assert.match(flushBody, /otWarmMirrorController\.buildPatchFilesRequest/);
  assert.match(flushBody, /method:\s*'mirror\.patchFiles'/);
  assert.match(flushBody, /sendBackgroundNative\(request\)/);
  assert.match(contentScript, /flushOtPatchBatch/);
});

test('invalid native OT patch results mark the warm mirror inconsistent using skippedFiles fields', () => {
  const contentScript = getContentScriptSource();
  const flushBody = extractFromContentScript( 'flushOtPatchBatch');

  assert.match(flushBody, /skippedFiles/);
  assert.match(flushBody, /skippedCount/);
  assert.match(flushBody, /updateOtStatusDisplay\('inconsistent'\)/);
  assert.doesNotMatch(flushBody, /result\?\.skipped\b|result\.skipped\b/);
});

test('native OT patch success requires valid appliedCount and appliedFiles evidence', () => {
  const contentScript = getContentScriptSource();
  const flushBody = extractFromContentScript( 'flushOtPatchBatch');

  assert.match(flushBody, /appliedFiles/);
  assert.match(flushBody, /appliedCount/);
  assert.match(flushBody, /Array\.isArray\(result\?\.appliedFiles\)/);
  assert.match(flushBody, /Number\.isFinite\(Number\(result\?\.appliedCount\)\)/);
  assert.match(flushBody, /appliedCount <= 0/);
  assert.match(flushBody, /appliedFiles\.length !== appliedCount/);
  const invalidResultIndex = flushBody.indexOf("otWarmMirrorState.lastErrorCode = 'mirror_patch_invalid_result'");
  const inconsistentIndex = flushBody.indexOf("updateOtStatusDisplay('inconsistent')", invalidResultIndex);
  const observingIndex = flushBody.indexOf("updateOtStatusDisplay('observing')");

  assert.ok(invalidResultIndex >= 0, 'invalid applied evidence sets a native patch result error code');
  assert.ok(inconsistentIndex > invalidResultIndex, 'invalid applied evidence marks OT status inconsistent');
  assert.ok(
    observingIndex > inconsistentIndex,
    'invalid applied evidence is handled before the successful observing status'
  );
});

test('warm mirror overlays preserve active file alongside focused files', () => {
  const contentScript = getContentScriptSource();
  const helperBody = contentScript.match(/function buildSnapshotFileOverlays\(project = \{\}, focusFiles = \[\], options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(helperBody, /activePath/);
  assert.match(helperBody, /focusSet\.has/);
  assert.match(helperBody, /normalizedPath === activePath/);
  assert.doesNotMatch(helperBody, /focusFiles\.length\s*\?\s*textFiles\.filter\(file => focusSet\.has/);
});

test('ask mode is not blocked by write-safety preconditions', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function handleTaskResult/)?.[0] || '';
  const codexSessionRunner = fs.readFileSync(
    path.join(__dirname, '../native-host/src/codexSessionRunner.js'),
    'utf8'
  );

  assert.doesNotMatch(runTaskBody, /state\.mode !== 'ask' && state\.requireReviewing/);
  assert.match(runTaskBody, /const submittedMode = state\.mode/);
  assert.match(runTaskBody, /mode:\s*submittedMode/);
  assert.match(codexSessionRunner, /params\.mode === 'ask'/);
  assert.match(codexSessionRunner, /sandboxMode: 'read-only'/);
  assert.match(codexSessionRunner, /approvalPolicy: 'never'/);
});

test('ask mode ignores unexpected local Codex writeback changes without failing the answer', () => {
  const contentScript = getContentScriptSource();
  const applySyncBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  async function verifyPostWriteSaveState/)?.[0] || '';
  const guardEnd = applySyncBody.indexOf('let operations = buildSyncApplyOperations');
  const guardBody = guardEnd > -1 ? applySyncBody.slice(0, guardEnd) : applySyncBody;

  // v1.6.3 carve: the orchestrator reads panel state through the getState()
  // accessor (mutable runtime binding), same semantics.
  assert.match(applySyncBody, /const runMode = options\.mode \|\| getState\(\)\.mode/);
  assert.match(applySyncBody, /options\.mode === 'ask'/);
  assert.match(applySyncBody, /Ask mode ignored local file changes/);
  assert.match(contentScript, /mode:\s*submittedMode/);
  assert.match(contentScript, /resolveWarmMirrorReuse\(project,[\s\S]*mode:\s*submittedMode/);
  assert.doesNotMatch(contentScript, /mode:\s*state\.mode,[\s\S]*unsupportedChanges: response\.result\.unsupportedChanges/);
  assert.ok(applySyncBody.indexOf("options.mode === 'ask'") < applySyncBody.indexOf('buildSyncApplyOperations'));
  assert.match(guardBody, /return \{/);
  assert.match(guardBody, /hasSkippedOperations:\s*false/);
  assert.match(guardBody, /resultStatus:\s*'ask_ignored_local_changes'/);
  assert.doesNotMatch(guardBody, /status:\s*'failed'/);
  assert.doesNotMatch(guardBody, /callPageBridge\('applyOperations'/);
});

test('composer clears the submitted task as soon as Codex accepts the run', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function handleTaskResult/)?.[0] || '';

  assert.match(runTaskBody, /currentRunView = startRunView\(/);
  // Submitted binary attachments are captured by the run record and then
  // cleared with the text so they cannot leak into the next turn.
  assert.match(runTaskBody, /clearTaskComposer\(\{ keepAttachments: false \}\)/);
  assert.match(contentScript, /function clearTaskComposer\(/);
  const clearBody = extractFromContentScript('clearTaskComposer');
  assert.match(clearBody, /if \(!keepAttachments\)/,
    'attachment clearing must be gated on keepAttachments');
  assert.match(contentScript, /taskInput\.value = ''/);
  assert.match(contentScript, /task: ''/);
});

test('deleting a UI session also clears plugin-isolated Codex history', () => {
  const contentScript = getContentScriptSource();
  // v1.4.7: deleteSessionWithConfirm lives in sessionManager.js; extract it
  // precisely instead of slicing to a runtime-side anchor.
  const deleteBody = extractFromContentScript('deleteSessionWithConfirm');

  assert.match(deleteBody, /codex\.history\.clearPlugin/);
  assert.match(deleteBody, /threadId:\s*target\.codexThreadId/);
  assert.match(deleteBody, /deleteSessionMessage/);
  assert.doesNotMatch(deleteBody, /清理插件隔离的本地 Codex 历史/);
  assert.doesNotMatch(deleteBody, /This deletes local session history/);
});

test('session deletion status uses plugin toast instead of task transcript space', () => {
  const contentScript = getContentScriptSource();
  const panelRenderer = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/panelRenderer.js'),
    'utf8'
  );
  const sessionPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/sessionPanel.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const contentSurface = `${contentScript}\n${sessionPanel}\n${panelRenderer}`;
  // v1.4.7: deleteSessionWithConfirm lives in sessionManager.js; extract it
  // precisely instead of slicing to a runtime-side anchor.
  const deleteBody = extractFromContentScript('deleteSessionWithConfirm');
  const plainLogBody = contentScript.match(/function appendPlainLog\(text\) \{[\s\S]*?\n  function updateProbeNotice/)?.[0] || '';
  const toastCss = css.match(/#codex-overleaf-panel \.codex-toast-region \{[\s\S]*?\n\}/)?.[0] || '';
  const taskSectionIndex = contentSurface.indexOf('<section class="codex-task-section">');
  const toastRegionIndex = contentSurface.indexOf('<div class="codex-toast-region" data-toast-region');
  const threadSectionIndex = contentSurface.indexOf('<section class="codex-thread-section">');

  assert.match(contentSurface, /data-toast-region/);
  assert.match(contentScript, /function showPluginToast\(/);
  assert.ok(taskSectionIndex >= 0, 'task section exists');
  assert.ok(toastRegionIndex > taskSectionIndex, 'toast region renders below task section');
  assert.ok(threadSectionIndex > toastRegionIndex, 'toast region renders above the transcript');
  assert.doesNotMatch(toastCss, /position:\s*(?:fixed|absolute|sticky)/);
  assert.doesNotMatch(toastCss, /top:\s*44px/);
  assert.match(deleteBody, /showPluginToast/);
  assert.doesNotMatch(deleteBody, /appendPlainLog/);
  assert.doesNotMatch(plainLogBody, /log\.append\(item\)/);
});

test('run history renders as a compact single-column transcript without persistent speaker rails', () => {
  const contentScript = getContentScriptSource();
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(contentScript, /root\.className = 'transcript-turn run-card'/);
  assert.match(contentScript, /class="run-prompt"/);
  assert.match(contentScript, /data-run-process/);
  assert.match(contentScript, /class="run-activity-list"/);
  assert.match(contentScript, /data-run-report/);
  assert.match(contentScript, /data-run-process-summary/);
  assert.doesNotMatch(contentScript, /data-run-technical-log/);
  assert.doesNotMatch(contentScript, />技术详情</);
  assert.doesNotMatch(contentScript, /<summary>Task<\/summary>/);
  assert.doesNotMatch(contentScript, /class="run-speaker"/);
  assert.doesNotMatch(contentScript, />你<\/div>/);
  assert.doesNotMatch(contentScript, />Codex<\/div>/);
  assert.doesNotMatch(css, /grid-template-columns:\s*46px minmax/);
  assert.match(css, /\.run-activity\s*\{[\s\S]*grid-template-columns:\s*14px minmax\(0,\s*1fr\)/);
});

test('activity rows are compact lines, not per-event cards with persistent timestamps', () => {
  const contentScript = getContentScriptSource();
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(contentScript, /function renderActivityLine\(/);
  assert.match(contentScript, /className = 'run-activity'/);
  assert.doesNotMatch(contentScript, /details\.className = 'run-event'/);
  assert.doesNotMatch(contentScript, /class="run-event"/);
  assert.match(css, /\.run-activity\s*\{[\s\S]*min-height:\s*20px/);
  assert.match(css, /\.run-activity-time\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /\.run-process/);
  assert.doesNotMatch(css, /\.run-technical-log/);
});

test('completed runs collapse processing history behind a processed summary', () => {
  const contentScript = getContentScriptSource();
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(contentScript, /function finishRunView\(/);
  assert.match(contentScript, /const visibleView = getCurrentRunViewForRender\(\)/);
  assert.match(contentScript, /collapseRunProcess\(visibleView/);
  assert.match(contentScript, /formatProcessedSummary/);
  assert.match(contentScript, /已处理/);
  assert.match(contentScript, /runProcess\.open = false/);
  assert.match(css, /\.run-process summary/);
});

test('context compaction appears as a lightweight checkpoint inside processed history', () => {
  const contentScript = getContentScriptSource();
  const agentTranscript = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/agentTranscript.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(agentTranscript, /上下文已压缩，Codex 继续处理/);
  assert.match(agentTranscript, /kind:\s*'checkpoint'/);
  assert.match(contentScript, /row\.dataset\.kind = event\.kind \|\| 'activity'/);
  assert.match(contentScript, /collapseRunProcess\(visibleView/);
  assert.match(css, /\.run-activity\[data-kind="checkpoint"\]/);
  assert.match(css, /\.run-activity\[data-kind="checkpoint"\]\s+\.run-activity-title::before/);
  assert.doesNotMatch(agentTranscript, /技术详情[^']*上下文已压缩/);
});

test('run log autoscroll follows realtime output unless the user scrolls upward', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /let logAutoFollow = true/);
  assert.match(contentScript, /let userScrollIntentUntil = 0/);
  assert.match(contentScript, /function bindLogAutoFollow\(/);
  assert.match(contentScript, /function getLogScrollContainer\(/);
  assert.match(contentScript, /querySelector\('\[data-log\]'\)/);
  assert.doesNotMatch(contentScript, /querySelector\('\[data-main\]'\)\s*\|\| panel\?\.querySelector\('\[data-log\]'\)/);
  assert.match(contentScript, /function isLogNearBottom\(/);
  assert.match(contentScript, /function markUserScrollIntent\(/);
  assert.match(contentScript, /Date\.now\(\) <= userScrollIntentUntil/);
  assert.match(contentScript, /function scrollLogToBottom\(/);
  assert.match(contentScript, /requestAnimationFrame/);
  assert.match(contentScript, /scrollLogToBottom\(\{ force: true \}\)/);
  assert.match(contentScript, /scrollLogToBottom\(\)/);
});

test('scroll engine coalesces writes, re-checks intent at paint, and exposes a jump-to-latest affordance', () => {
  const contentScript = getContentScriptSource();
  // Single rAF coalesces a burst into one write per frame (no double reflow):
  // the rAF id guard means a second call within the same frame returns early.
  assert.match(contentScript, /let scrollLogRafId = 0/);
  assert.match(contentScript, /if \(scrollLogRafId\)\s*\{[\s\S]*?return/);
  // A forced scroll must survive the coalesce so it is never dropped.
  assert.match(contentScript, /scrollLogPendingForce/);
  // The paint-time write re-checks follow intent (closes the one-frame fight).
  assert.match(contentScript, /const writeNow = \(\) =>[\s\S]*?scrollLogPendingForce \|\| logAutoFollow \|\| isLogNearBottom/);
  // Floating jump-to-latest button: created lazily in the non-scrolling thread
  // section, toggled by the scroll handler + the unread counter.
  assert.match(contentScript, /function ensureJumpToLatestButton\(/);
  assert.match(contentScript, /function updateJumpToLatestButton\(/);
  assert.match(contentScript, /tl-jump-latest/);
  assert.match(contentScript, /closest\?\.\('\.codex-thread-section'\)/);
  assert.match(contentScript, /let unreadSinceDetach = 0/);
  // The scroll handler keeps the button state current.
  assert.match(contentScript, /updateJumpToLatestButton\(scroller\)/);
});

test('panel.css ships the jump-to-latest button, dark scrollbar, and motion primitives', () => {
  const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');
  // Floating button needs a positioned, non-scrolling host.
  assert.match(css, /\.codex-thread-section\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.tl-jump-latest\s*\{[\s\S]*?position:\s*absolute/);
  // button.hidden must actually hide it: the id+class display rule out-specifies
  // the UA [hidden] rule, so an explicit [hidden] override is required.
  assert.match(css, /\.tl-jump-latest\[hidden\]\s*\{\s*display:\s*none/);
  // Themed scrollbar on the scroll container (was the light native default);
  // the thumb hue is now the border-strong token so it tracks dark/light.
  // v1.6.4 hoisted the webkit rules panel-wide so every scroll region
  // (sessions, settings, diff, trays) shares the same themed scrollbar.
  assert.match(css, /\.col-log[\s\S]*?scrollbar-color:\s*var\(--tl-border-strong\)/);
  assert.match(css, /#codex-overleaf-panel ::-webkit-scrollbar-thumb/);
  // Motion primitives + reduced-motion guard.
  assert.match(css, /@keyframes tl-fade-in/);
  assert.match(css, /@keyframes tl-spin/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // The running step's glyph spins; new rows slide in (transform+opacity
  // only, v1.7.7 — composited, never reflows neighbors).
  assert.match(css, /\.run-activity\[data-status="running"\] \.run-activity-dot::before\s*\{[\s\S]*?animation:\s*tl-spin/);
  assert.match(css, /@keyframes tl-slide-in/);
  assert.match(css, /\.run-activity\s*\{[\s\S]*?animation:\s*tl-slide-in/);
  // v1.7.7 liveliness: the running card's sticky header carries a scan line,
  // and the live tail line breathes an ellipsis.
  assert.match(css, /@keyframes tl-scan/);
  assert.match(css, /\.transcript-turn\[data-status="running"\] \.run-process summary \.run-scan::before\s*\{[\s\S]*?animation:\s*tl-scan/);
  // The sweep lives on a dedicated .run-scan element — summary::after is the
  // expand/collapse chevron and must stay untouched.
  const timeline = fs.readFileSync(path.join(__dirname, '../extension/src/content/runTimelineView.js'), 'utf8');
  assert.match(timeline, /class="run-scan" aria-hidden="true"/);
  assert.match(css, /@keyframes tl-ellipsis/);
  assert.match(css, /:not\(:has\(~ \.run-activity\)\) \.run-activity-title::after/);
  // v1.7.7 readability: activity narration wraps instead of ellipsizing.
  assert.match(css, /\.run-activity-title\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(css.match(/\.run-activity-title\s*\{[\s\S]*?\}/)[0], /text-overflow/,
    'activity titles must not single-line-ellipsize');
});

test('streamed assistant text shrinks with the panel and wraps mixed-language content', () => {
  const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');
  const activityListRule = css.match(/\.run-activity-list\s*\{[\s\S]*?\}/)?.[0] || '';
  const streamRule = css.match(/\.run-stream\s*\{[\s\S]*?\}/)?.[0] || '';
  const streamTextRule = css.match(/\.run-stream-text\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(activityListRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(activityListRule, /min-width:\s*0/);
  assert.match(streamRule, /box-sizing:\s*border-box/);
  assert.match(streamRule, /width:\s*100%/);
  assert.match(streamRule, /min-width:\s*0/);
  assert.match(streamTextRule, /max-width:\s*100%/);
  assert.match(streamTextRule, /white-space:\s*pre-wrap/);
  assert.match(streamTextRule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(streamTextRule, /white-space:\s*nowrap/);
});

test('Option B visual: glyph status rows, sticky current-step header, left-rule stream', () => {
  const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');
  // Status glyphs: idle ·, completed ✓, failed ✕. Running is a CSS-drawn arc
  // ring (v1.7.6) — the old ◐ character wobbled because a font glyph does not
  // rotate around its visual center. Both running spinners share the ring +
  // the unified 800ms cadence.
  assert.match(css, /\.run-activity-dot::before\s*\{[\s\S]*?content:\s*"·"/);
  assert.match(css, /\.run-activity\[data-status="running"\] \.run-activity-dot::before\s*\{[\s\S]*?content:\s*""[\s\S]*?border-radius:\s*50%[\s\S]*?animation:\s*tl-spin 800ms/);
  assert.doesNotMatch(css, /content:\s*"◐"/, 'the wobbling half-circle glyph must not return');
  assert.match(css, /\.run-activity\[data-status="completed"\] \.run-activity-dot::before\s*\{[\s\S]*?content:\s*"✓"/);
  assert.match(css, /\.run-activity\[data-status="failed"\] \.run-activity-dot::before\s*\{[\s\S]*?content:\s*"✕"/);
  // Stale-spinner guard (v1.7.6): a running-status line stops spinning once
  // the run settled or a newer activity line landed below it.
  assert.match(css, /\.transcript-turn:not\(\[data-status="running"\]\) \.run-activity\[data-status="running"\] \.run-activity-dot::before/);
  assert.match(css, /\.run-activity\[data-status="running"\]:has\(~ \.run-activity\) \.run-activity-dot::before/);
  // Sticky current-step header: the run-process summary pins to top with a
  // status glyph mirroring the card's data-status.
  assert.match(css, /\.run-process summary\s*\{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*0/);
  assert.match(css, /\.transcript-turn\[data-status="running"\] \.run-process summary::before\s*\{[\s\S]*?content:\s*""[\s\S]*?animation:\s*tl-spin 800ms/);
  // Stream rows carry a role-colored left rule.
  assert.match(css, /\.run-stream\s*\{[\s\S]*?border-left:\s*2px solid/);
  assert.match(css, /\.run-stream\[data-stream-role="assistant"\]\s*\{[\s\S]*?border-left-color:\s*var\(--tl-accent\)/);
});

test('Option B JS: live-elapsed tick + collapsed step count', () => {
  const contentScript = getContentScriptSource();
  // A 1s tick updates the sticky header's live elapsed while a run is in flight.
  assert.match(contentScript, /function startRunElapsedTick\(/);
  assert.match(contentScript, /function stopRunElapsedTick\(/);
  assert.match(contentScript, /runElapsedTimer = window\.setInterval/);
  // The tick is started in startRunView and stopped in finishRunView.
  assert.match(contentScript, /startRunElapsedTick\(\);[\s\S]{0,80}renderSessionList\(\)/);
  // collapseRunProcess appends the step count.
  assert.match(contentScript, /function countRunActivitySteps\(/);
  assert.match(contentScript, /\$\{stepCount\} steps/);
});

test('task session navigation stays pinned while the transcript scrolls', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(css, /\.codex-vscode-main\s*\{[\s\S]*display:\s*flex/);
  assert.match(css, /\.codex-vscode-main\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(css, /\.codex-vscode-main\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.codex-task-section\s*\{[\s\S]*flex:\s*0 0 auto/);
  assert.match(css, /\.codex-task-section\s*\{[\s\S]*max-height:/);
  assert.match(css, /\.codex-task-section\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.codex-thread-section\s*\{[\s\S]*flex:\s*1 1 auto/);
  assert.match(css, /\.codex-thread-section\s*\{[\s\S]*min-height:\s*0/);
  assert.match(css, /\.col-log\s*\{[\s\S]*overflow-y:\s*auto/);
});

test('running Codex tasks do not block switching to another session for reading history', () => {
  const contentScript = getContentScriptSource();
  const switchBody = contentScript.match(/async function switchSession\(sessionId\) \{[\s\S]*?\n  async function deleteSessionWithConfirm/)?.[0] || '';

  assert.doesNotMatch(switchBody, /Finish the current Codex task before switching sessions/);
  assert.doesNotMatch(switchBody, /if \(currentRunView\)/);
  assert.match(contentScript, /sessionId:\s*state\.activeSessionId/);
  assert.match(contentScript, /findRunRecord\(currentRunView\.recordId,\s*currentRunView\.sessionId\)/);
});

test('running Codex tasks only lock the running session, not the whole session list', () => {
  const contentScript = getContentScriptSource();
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const sessionPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/sessionPanel.js'),
    'utf8'
  );
  const startNewBody = contentScript.match(/async function startNewSession\(\) \{[\s\S]*?\n  async function switchSession/)?.[0] || '';
  // v1.4.7: deleteSessionWithConfirm lives in sessionManager.js; extract it
  // precisely instead of slicing to a runtime-side anchor.
  const deleteBody = extractFromContentScript('deleteSessionWithConfirm');
  const setRunningBody = contentScript.match(/function setRunning\(running\) \{[\s\S]*?\n  function startRunView/)?.[0] || '';
  // v1.4.6: renderRunHistory moved into runTimelineView.js, so the slice ends
  // at the next function that stayed in the runtime.
  const sessionListBody = contentScript.match(/function renderSessionList\(options = \{\}\) \{[\s\S]*?\n  function getSessionDisplayTitle/)?.[0] || '';

  assert.doesNotMatch(startNewBody, /Finish the current Codex task before starting a new session/);
  assert.doesNotMatch(setRunningBody, /\[data-new-session\]'\)\.disabled = running/);
  assert.match(deleteBody, /isSessionRunning\(target\)/);
  assert.doesNotMatch(deleteBody, /currentRunView\?\.sessionId === sessionId/);
  assert.doesNotMatch(deleteBody, /Finish the current Codex task before deleting a session/);
  assert.match(sessionListBody, /pinnedSessionIds:\s*getRunningSessionIds\(\)/);
  assert.doesNotMatch(sessionListBody, /pinnedSessionIds:\s*\[currentRunView\?\.sessionId\]\.filter\(Boolean\)/);
  assert.match(sessionPanel, /const isRunningSession = instance\.isSessionRunning\(session\)/);
  assert.doesNotMatch(sessionPanel, /const isRunningSession = currentRunView\?\.sessionId === session\.id/);
  assert.match(sessionPanel, /row\.dataset\.running = isRunningSession \? 'true' : 'false'/);
  assert.match(sessionPanel, /deleteButton\.disabled = isRunningSession/);
  assert.match(contentScript, /function isSessionRunning\(session\) \{/);
  assert.match(contentScript, /run\.status === 'running'/);
  assert.match(css, /\.codex-session-row\[data-running="true"\]/);
  assert.match(css, /codex-session-spin/);
});

test('running tasks are only marked interrupted when restoring persisted state after reload', () => {
  const contentScript = getContentScriptSource();
  const sessionState = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/sessionState.js'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );

  assert.match(contentScript, /normalizePanelState\(await loadStoredState\(\),\s*\{\s*restoreRunningRuns:\s*true\s*\}\)/);
  assert.match(sessionState, /restoreRunningRuns/);
  assert.doesNotMatch(sessionState, /Run interrupted by page reload/);
  assert.doesNotMatch(sessionState, /Interrupted by page reload/);
  assert.match(sessionState, /i18n\.t\(locale, 'restoredRunStoppedTitle'\)/);
  assert.match(i18n, /页面刷新后已停止跟踪这轮任务/);
});

test('session list keeps the selected historical session reachable', () => {
  const contentScript = getContentScriptSource();
  const sessionState = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/sessionState.js'),
    'utf8'
  );

  assert.match(contentScript, /selectVisibleSessionsForList/);
  assert.match(contentScript, /state\.activeSessionId/);
  assert.match(sessionState, /function selectVisibleSessionsForList/);
  assert.match(sessionState, /activeSessionId/);
});

test('session titles auto-name once and can be manually renamed inline', () => {
  const contentScript = getContentScriptSource();
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const sessionPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/sessionPanel.js'),
    'utf8'
  );
  const startRunBody = contentScript.match(/function startRunView\([^)]*\) \{[\s\S]*?\n  function finishRunView/)?.[0] || '';

  assert.match(startRunBody, /active\?\.titleSource !== 'manual'/);
  assert.match(startRunBody, /deriveSessionTitle/);
  assert.match(sessionPanel, /codex-session-rename/);
  assert.match(sessionPanel, /codex-session-title-input/);
  assert.match(sessionPanel, /function beginRename/);
  // A real custom title pins to 'manual'; an empty value, the New Session
  // placeholder, or the auto-derived title stay 'auto' (so renaming an empty
  // session can't resurrect a ghost).
  assert.match(contentScript, /titleSource: isCustom \? 'manual' : 'auto'/);
  assert.match(css, /\.codex-session-rename/);
  assert.match(css, /\.codex-session-title-input/);
});

test('high-volume Codex stream output is throttled before panel rendering and storage writes', () => {
  const contentScript = getContentScriptSource();
  const appendRunEventBody = contentScript.match(/function appendRunEvent\(input = \{\}\) \{[\s\S]*?\n  function getCurrentRunViewForRender/)?.[0] || '';

  assert.match(contentScript, /STREAM_RENDER_FLUSH_MS/);
  assert.match(contentScript, /STREAM_SAVE_DELAY_MS/);
  assert.match(contentScript, /pendingStreamRenderEvents = new Map\(\)/);
  assert.match(contentScript, /function scheduleStreamEventRender/);
  assert.match(contentScript, /function flushPendingStreamRenders/);
  assert.match(contentScript, /function scheduleRunStateSave/);
  assert.match(appendRunEventBody, /scheduleRunStateSave\(event\.kind\)/);
  assert.match(appendRunEventBody, /scheduleStreamEventRender\(renderedEvent\)/);
  assert.match(appendRunEventBody, /if \(event\.kind === 'stream'\) \{[\s\S]*scheduleStreamEventRender\(renderedEvent\)/);
});

test('reviewing safety toggle is labeled instead of a mysterious check icon', () => {
  const contentScript = getContentScriptSource();
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(`${contentScript}\n${composerPanel}`, /data-i18n="requireReviewing">Track</);
  assert.match(i18n, /requireReviewing:\s*'留痕'/);
  assert.match(i18n, /开启后，写入前会确认并尝试切到 Overleaf Reviewing\/Track Changes；删除仍需确认。/);
  assert.match(css, /\.codex-review-label/);
});

test('write paths enforce Overleaf Reviewing before applying changes when requested', () => {
  const contentScript = getContentScriptSource();
  const pageBridge = fs.readFileSync(
    path.join(__dirname, '../extension/src/pageBridge.js'),
    'utf8'
  );
  const applySyncBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  function buildSyncApplyOperations/)?.[0] || '';
  const applyTaskBody = contentScript.match(/async function applyTaskOperations[\s\S]*?\n  function partitionOperationsForApply/)?.[0] || '';

  assert.match(contentScript, /async function ensureReviewingBeforeWrite/);
  assert.match(applySyncBody, /const runRequireReviewing = typeof options\.requireReviewing === 'boolean'/);
  assert.match(applySyncBody, /await ensureReviewingBeforeWrite\(operations,\s*\{\s*requireReviewing:\s*runRequireReviewing\s*\}\)/);
  assert.match(applySyncBody, /requireReviewing:\s*runRequireReviewing/);
  assert.match(applySyncBody, /requireEditing:\s*!runRequireReviewing/);
  assert.doesNotMatch(applySyncBody, /requireReviewing:\s*state\.requireReviewing === true/);
  assert.match(applyTaskBody, /await ensureReviewingBeforeWrite\(partitioned\.safe,\s*\{\s*requireReviewing:\s*runRequireReviewing\s*\}\)/);
  assert.match(applyTaskBody, /requireReviewing:\s*runRequireReviewing/);
  assert.match(applyTaskBody, /requireEditing:\s*!runRequireReviewing/);
  assert.doesNotMatch(applyTaskBody, /requireReviewing:\s*state\.requireReviewing === true/);
  assert.match(pageBridge, /method === 'ensureReviewing'/);
  assert.match(pageBridge, /method === 'ensureEditing'/);
  assert.match(pageBridge, /function ensureReviewing\(/);
  assert.match(pageBridge, /function ensureEditing\(/);
  assert.match(pageBridge, /requireReviewing:\s*params\.requireReviewing === true/);
  assert.match(pageBridge, /requireEditing:\s*params\.requireEditing === true/);
  const writebackRouter = fs.readFileSync(path.join(__dirname, '../extension/src/page/writebackRouter.js'), 'utf8');
  assert.match(writebackRouter, /buildReviewingRequiredBlockedResult/);
  assert.match(writebackRouter, /buildEditingRequiredBlockedResult/);
});

test('write tasks preflight Reviewing or Editing before syncing or starting local Codex', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function handleTaskResult/)?.[0] || '';
  const preflightIndex = runTaskBody.indexOf('preflightWriteSafety({');
  const snapshotIndex = runTaskBody.indexOf('getRunProjectSnapshot()');
  const codexRunIndex = runTaskBody.indexOf("method: 'codex.run'");
  const preflightBody = contentScript.match(/async function preflightWriteSafety\([^)]*\) \{[\s\S]*?\n  async function handleTaskResult/)?.[0] || '';

  assert.match(contentScript, /async function preflightWriteSafety\(/);
  assert.ok(preflightIndex > -1);
  assert.ok(snapshotIndex > -1);
  assert.ok(codexRunIndex > -1);
  assert.ok(preflightIndex < snapshotIndex);
  assert.ok(preflightIndex < codexRunIndex);
  assert.match(runTaskBody, /const submittedRequireReviewing = state\.requireReviewing === true/);
  assert.match(runTaskBody, /preflightWriteSafety\(\{\s*mode:\s*submittedMode,\s*requireReviewing:\s*submittedRequireReviewing\s*\}\)/);
  assert.match(preflightBody, /const mode = options\.mode \|\| state\.mode/);
  assert.match(preflightBody, /const requireReviewing = typeof options\.requireReviewing === 'boolean'/);
  assert.match(preflightBody, /mode === 'ask'/);
  assert.match(preflightBody, /const method = requireReviewing \? 'ensureReviewing' : 'ensureEditing'/);
  assert.match(preflightBody, /callPageBridge\(method/);
  assert.match(preflightBody, /任务未开始：无法开启 Overleaf 留痕/);
  assert.match(preflightBody, /任务未开始：无法切换到 Overleaf Editing/);
  assert.match(preflightBody, /const finishTitle = requireReviewing/);
  assert.match(preflightBody, /tx\('Not started: could not enable Track Changes', '未开始：无法开启留痕'\)/);
  assert.match(preflightBody, /tx\('Not started: could not switch to Editing', '未开始：无法切换到 Editing'\)/);
  assert.match(preflightBody, /finishRunView\(finishTitle, 'failed'\)/);
});

test('native side-effecting requests are gated on compatibility before dispatch', () => {
  const contentScript = getContentScriptSource();
  const sendNativeBody = extractFromContentScript( 'sendNative');
  const sendBackgroundNativeBody = extractFromContentScript( 'sendBackgroundNative');
  const ensureBody = extractFromContentScript( 'ensureNativeCompatibilityForMethod');

  assert.match(contentScript, /NATIVE_COMPATIBILITY_GATED_METHODS/);
  for (const method of [
    'codex.run',
    'task.run',
    'task.confirm',
    'mirror.sync',
    'mirror.patchFiles',
    'codex.history.clearPlugin'
  ]) {
    assert.match(contentScript, new RegExp(method.replace(/[.]/g, '\\.')));
  }
  assert.match(ensureBody, /CodexOverleafCompatibility\?\.buildBridgePingParams/);
  assert.match(ensureBody, /CodexOverleafCompatibility\?\.evaluateNativeCompatibility/);
  assert.match(ensureBody, /CodexOverleafCompatibility\?\.isNativeMethodAllowed/);
  assert.match(ensureBody, /native_update_required/);
  assert.match(ensureBody, /formatNativeCompatibilityBlockedMessage/);
  assert.match(sendNativeBody, /await ensureNativeCompatibilityForMethod\(payload\?\.method\)/);
  assert.match(sendNativeBody, /attachNativeCompatibilityEvidence/);
  assert.match(sendBackgroundNativeBody, /await ensureNativeCompatibilityForMethod\(payload\?\.method\)/);
  assert.match(sendBackgroundNativeBody, /attachNativeCompatibilityEvidence/);
});

test('cancellation during native compatibility gate prevents codex.run dispatch', async () => {
  const contentScript = getContentScriptSource();
  const sendNativeBody = extractFromContentScript( 'sendNative');

  let cancellationRequested = false;
  let nativeSent = false;
  const sendNative = Function(
    'ensureNativeCompatibilityForMethod',
    'nativeChannel',
    'attachNativeCompatibilityEvidence',
    'throwIfCancelledBeforeNativeDispatch',
    `return (${sendNativeBody});`
  )(
    async () => {
      cancellationRequested = true;
      return { ok: true, compatibility: { status: 'ok' } };
    },
    {
      sendNative() {
        nativeSent = true;
        return Promise.resolve({ ok: true });
      }
    },
    payload => payload,
    () => {
      if (cancellationRequested) {
        const error = new Error('Codex run was cancelled by the user');
        error.code = 'codex_cancelled';
        throw error;
      }
    }
  );

  await assert.rejects(
    sendNative({ method: 'codex.run', params: { task: 'write' } }),
    /Codex run was cancelled by the user/
  );
  assert.equal(nativeSent, false);
});

test('read-only native discovery and diagnostics bypass the compatibility run gate', () => {
  const contentScript = getContentScriptSource();
  const loadModelBody = extractFromContentScript( 'loadModelOptions');
  const mirrorFreshnessBody = extractFromContentScript( 'getMirrorFreshness');
  const inspectBody = extractFromContentScript( 'inspectNativeEnvironment');

  assert.match(loadModelBody, /method:\s*'codex\.models'/);
  assert.match(mirrorFreshnessBody, /method:\s*'mirror\.status'/);
  assert.match(inspectBody, /method:\s*'bridge\.ping'/);
  assert.doesNotMatch(loadModelBody, /ensureNativeCompatibilityForMethod/);
  assert.doesNotMatch(mirrorFreshnessBody, /ensureNativeCompatibilityForMethod/);
  assert.doesNotMatch(inspectBody, /ensureNativeCompatibilityForMethod/);
});

test('write preflight gives natural feedback for automatic Reviewing or Editing activation', () => {
  const contentScript = getContentScriptSource();
  const preflightBody = contentScript.match(/async function preflightWriteSafety\([^)]*\) \{[\s\S]*?\n  async function handleTaskResult/)?.[0] || '';

  assert.match(preflightBody, /正在确认 Overleaf 留痕状态/);
  assert.match(preflightBody, /正在确认 Overleaf Editing 模式/);
  assert.match(preflightBody, /已开启 Overleaf 留痕，开始处理任务/);
  assert.match(preflightBody, /Overleaf 留痕已经开启，开始处理任务/);
  assert.match(preflightBody, /已切到 Overleaf Editing，开始处理任务/);
  assert.match(preflightBody, /Overleaf 已在 Editing 模式，开始处理任务/);
  assert.match(preflightBody, /你可能没有权限，或 Overleaf 当前页面没有暴露切换入口/);
  assert.match(preflightBody, /请在 Overleaf 手动切到 Editing 后重试/);
});

test('native and raw agent events go through the human transcript mapper', () => {
  const contentScript = getContentScriptSource();
  const appendNativeEventBody = contentScript.match(/function appendNativeEvent\([^)]*\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(contentScript, /CodexOverleafAgentTranscript/);
  assert.match(appendNativeEventBody, /mapAgentEventToActivity\(event,\s*\{\s*locale:\s*getLocale\(\)\s*\}\)/);
  assert.match(contentScript, /appendTechnicalEvent/);
  assert.doesNotMatch(contentScript, /function mapAgentActivity\(event\)/);
});

test('Codex JSONL messages and tool progress become visible without raw command labels', () => {
  const contentScript = getContentScriptSource();
  const agentTranscript = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/agentTranscript.js'),
    'utf8'
  );

  assert.match(agentTranscript, /codex\.agent\.message/);
  assert.match(agentTranscript, /codex\.command\.started/);
  assert.match(agentTranscript, /summarizeCommandActivity/);
  assert.doesNotMatch(contentScript, /Codex 说/);
  assert.doesNotMatch(contentScript, /Codex 正在运行命令/);
  assert.doesNotMatch(contentScript, /命令已完成/);
});

test('Codex realtime deltas update one stream instead of appending raw event rows', () => {
  const contentScript = getContentScriptSource();
  const agentTranscript = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/agentTranscript.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(agentTranscript, /kind:\s*'stream'/);
  assert.match(agentTranscript, /streamKey:\s*getCodexStreamKey/);
  assert.match(contentScript, /function upsertRunStreamRecordEvent\(/);
  assert.match(contentScript, /function upsertStreamEvent\(/);
  assert.match(contentScript, /className = 'run-stream'/);
  assert.match(contentScript, /function renderMarkdownInlineText\(/);
  assert.match(contentScript, /document\.createElement\('strong'\)/);
  assert.doesNotMatch(contentScript, /run-stream-text[\s\S]{0,240}\.innerHTML/);
  assert.match(css, /\.run-stream-text/);
  assert.match(agentTranscript, /if \(method === 'item\/reasoning\/textDelta'\) \{\s*return technicalOnly\(event, locale\);\s*\}/);
  assert.doesNotMatch(contentScript, /technicalDetail:\s*normalizeRawAgentEvent\(event\)/);
});

test('final assistant summary is collected from all assistant stream messages', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /function getAssistantAnswerForCurrentRun\(/);
  assert.match(contentScript, /\.filter\(event =>[\s\S]*event\.streamRole === 'assistant'/);
  assert.match(contentScript, /\.map\(event => cleanFinalAnswer\(event\.title\)\)/);
  assert.match(contentScript, /\.join\('\\n\\n'\)/);
  assert.doesNotMatch(contentScript, /function getLatestAssistantAnswerForCurrentRun\(/);
});

test('same UI session records final assistant summary for the next Codex turn', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /function buildSessionHistoryResult/);
  assert.match(contentScript, /const assistantMessage = response\.result\.assistantMessage \|\| getAssistantAnswerForCurrentRun\(\)/);
  assert.match(contentScript, /result:\s*buildSessionHistoryResult\(\{[\s\S]*assistantMessage,/);
  assert.match(contentScript, /const syncChanges = response\.result\.syncChanges \|\| \[\]/);
  assert.match(contentScript, /syncChanges\s*\n\s*\}\)/);
});

test('post-run session persistence failures do not turn ask results into failed analysis', () => {
  const contentScript = getContentScriptSource();
  const successPath = contentScript.match(/const syncOutcome = await applySyncChangesToOverleaf[\s\S]*?Codex 结果已生成，但保存本地会话记录失败[\s\S]*?\}\);/)?.[0] || '';

  assert.match(successPath, /try\s*\{/);
  assert.match(successPath, /await saveState\(\)/);
  assert.match(successPath, /catch \(persistenceError\)/);
  assert.match(successPath, /Codex 结果已生成，但保存本地会话记录失败/);
  assert.doesNotMatch(successPath, /throw persistenceError/);
});

test('completion report is structured around user outcomes rather than a one-line status', () => {
  const contentScript = getContentScriptSource();
  const agentTranscript = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/agentTranscript.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(contentScript, /function appendCompletionReport\(/);
  assert.match(contentScript, /buildHumanCompletionReport/);
  assert.match(contentScript, /translateRawError/);
  assert.match(contentScript, /assistantMessage/);
  assert.match(contentScript, /getAssistantAnswerForCurrentRun/);
  assert.match(contentScript, /className = 'run-final-answer'/);
  assert.match(contentScript, /renderMarkdownBlockText\(body/);
  assert.match(contentScript, /function renderMarkdownBlockText\(/);
  assert.match(contentScript, /function formatMarkdownHref\(/);
  assert.match(contentScript, /workspace\/\$\{fileLabel\}:\$\{line\}/);
  assert.match(css, /\.run-final-answer ul/);
  assert.match(css, /\.run-final-answer a/);
  assert.doesNotMatch(contentScript, /body\.textContent = formatEventDetail\(event\.detail \|\| \{\}\)/);
  assert.match(agentTranscript, /结论/);
  assert.match(agentTranscript, /检查范围/);
  assert.match(agentTranscript, /发现/);
  assert.match(agentTranscript, /写入结果/);
  assert.match(agentTranscript, /可撤销/);
  assert.match(agentTranscript, /下一步/);
  assert.doesNotMatch(contentScript, /nextStep: response\.error\.message/);
  assert.doesNotMatch(contentScript, /本地 Codex 返回错误/);
  assert.doesNotMatch(extractFromContentScript('appendCompletionReport'), /Summary:/);
});

test('writeback completion report keeps Codex final summary as the conclusion', () => {
  const contentScript = getContentScriptSource();
  const applyBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  function buildSyncApplyOperations/)?.[0] || '';
  const writebackReportBlock = applyBody.match(/const summaryLine = appendChangeSummary[\s\S]*?appendCompletionReport\(\{[\s\S]*?\n    \}\);/)?.[0] || '';

  assert.match(applyBody, /const assistantMessage = cleanFinalAnswer/);
  assert.match(writebackReportBlock, /assistantMessage/);
  assert.doesNotMatch(writebackReportBlock, /conclusion:\s*applied\.skipped\?\.length\s*\?[\s\S]*:\s*'本地 Codex 改动已同步回 Overleaf。'/);
});

test('completion report renderer turns inline numbered findings into readable ordered lists', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /function normalizeInlineOrderedLists\(/);
  assert.match(contentScript, /document\.createElement\('ol'\)/);
  assert.match(contentScript, /isMarkdownOrderedListLine/);
});

test('auto mode shows a readonly diff after applying Codex changes', () => {
  const contentScript = getContentScriptSource();
  const diffReviewPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diffReviewPanel.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const applySyncBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  function buildSyncApplyOperations/)?.[0] || '';

  assert.match(contentScript, /function renderReadOnlyDiffReview\(/);
  assert.match(contentScript, /diffReviewPanel\.renderReadOnlyDiffReview\(syncChanges,\s*title\)/);
  assert.match(applySyncBody, /const applied = operations\.length[\s\S]*renderReadOnlyDiffReview\(getAppliedSyncChanges\(syncChanges, applied\)/);
  assert.match(contentScript, /function getAppliedSyncChanges\(/);
  assert.match(diffReviewPanel, /dataset\.readonly = 'true'/);
  assert.match(css, /\.codex-diff-review\[data-readonly="true"\]/);
  assert.doesNotMatch(applySyncBody, /本地 Codex 改动预览：\$\{syncChanges\.filter/);
});

test('confirm diff review uses immediate per-file decisions and batch accept reject actions', () => {
  const contentScript = getContentScriptSource();
  const diffReviewPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diffReviewPanel.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const wrapperBody = contentScript.match(/function createDiffReviewElement\(syncChanges[\s\S]*?\n  function renderReadOnlyDiffReview/)?.[0] || '';
  const createDiffBody = diffReviewPanel.match(/function createDiffReviewElement\(syncChanges[\s\S]*?\n    function renderDiffReview/)?.[0] || '';
  const renderDiffBody = diffReviewPanel.match(/function renderDiffReview\(syncChanges\) \{[\s\S]*?\n    function renderReadOnlyDiffReview/)?.[0] || '';

  assert.match(wrapperBody, /return diffReviewPanel\.createDiffReviewElement\(syncChanges,\s*options\)/);
  assert.match(wrapperBody, /return diffReviewPanel\.renderDiffReview\(syncChanges\)/);
  assert.match(createDiffBody, /card\.dataset\.decision = readonly \? 'accepted' : 'pending'/);
  assert.match(createDiffBody, /function decideFileChange\(path, accepted\)/);
  assert.match(createDiffBody, /status\.textContent = accepted \? tr\('diffAccepted'\) : tr\('diffRejected'\)/);
  assert.match(renderDiffBody, /acceptAllBtn\.textContent = tr\('diffAcceptAll'\)/);
  assert.match(renderDiffBody, /rejectAllBtn\.textContent = tr\('diffRejectAll'\)/);
  assert.match(renderDiffBody, /review\.decidePendingChanges\(true\)/);
  assert.match(renderDiffBody, /review\.decidePendingChanges\(false\)/);
  assert.doesNotMatch(renderDiffBody, /finish\(syncChanges\)/);
  assert.doesNotMatch(renderDiffBody, /finish\(\[\]\)/);
  assert.doesNotMatch(renderDiffBody, /应用选中/);
  assert.match(renderDiffBody, /finishIfAllDecided/);
  assert.match(css, /\.codex-diff-file\[data-decision="accepted"\]/);
  assert.match(css, /\.codex-diff-toolbar-summary/);
});

test('confirm diff review renders hunk controls and resolves accepted hunk patches', () => {
  const contentScript = getContentScriptSource();
  const diffReviewPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diffReviewPanel.js'),
    'utf8'
  );
  const createDiffBody = diffReviewPanel.match(/function createDiffReviewElement\(syncChanges[\s\S]*?\n    function renderDiffReview/)?.[0] || '';
  const renderDiffBody = diffReviewPanel.match(/function renderDiffReview\(syncChanges\) \{[\s\S]*?\n    function renderReadOnlyDiffReview/)?.[0] || '';

  assert.match(contentScript, /CodexOverleafReviewHunks/);
  assert.match(createDiffBody, /window\.CodexOverleafReviewHunks/);
  assert.match(createDiffBody, /data-diff-hunk-accept/);
  assert.match(createDiffBody, /data-diff-hunk-reject/);
  assert.match(createDiffBody, /data-diff-hunk-jump/);
  assert.match(createDiffBody, /buildAcceptedSyncChanges\(syncChanges,\s*decisions\)/);
  assert.match(renderDiffBody, /review\.getAcceptedChanges\(\)/);
  assert.match(renderDiffBody, /buildAcceptedSyncChanges/);
});

test('confirm diff review exposes editor-native hunk review limits and shortcuts', () => {
  const contentScript = getContentScriptSource();
  const diffReviewPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diffReviewPanel.js'),
    'utf8'
  );
  const createDiffBody = diffReviewPanel.match(/function createDiffReviewElement\(syncChanges[\s\S]*?\n    function renderDiffReview/)?.[0] || '';

  assert.match(diffReviewPanel, /const MAX_INITIAL_REVIEW_HUNKS = 20/);
  assert.match(diffReviewPanel, /const MAX_INITIAL_HUNK_LINES = 80/);
  assert.match(createDiffBody, /container\.tabIndex = 0/);
  assert.match(createDiffBody, /handleDiffReviewKeydown/);
  assert.match(createDiffBody, /addEventListener\('keydown', handleDiffReviewKeydown\)/);
  assert.match(createDiffBody, /callPageBridge\('jumpToPosition',\s*\{\s*path/);
  assert.match(createDiffBody, /case 'j'/);
  assert.match(createDiffBody, /case 'k'/);
  assert.match(createDiffBody, /case 'a'/);
  assert.match(createDiffBody, /case 'r'/);
  assert.match(createDiffBody, /case 'Enter'/);
  assert.match(createDiffBody, /case 'Escape'/);
  assert.match(createDiffBody, /isDiffReviewEditableTarget/);
  assert.match(createDiffBody, /MAX_INITIAL_REVIEW_HUNKS/);
  assert.match(createDiffBody, /MAX_INITIAL_HUNK_LINES/);
});

test('hunk review buttons return only the accepted patch subset', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' },
        { from: 6, to: 10, expected: 'beta', insert: 'BETA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] },
        { lines: [{ type: 'remove', text: 'beta' }, { type: 'add', text: 'BETA' }] }
      ]
    }
  ];

  const review = createDiffReviewElement(syncChanges);
  const acceptButtons = review.container.querySelectorAll('[data-diff-hunk-accept]');
  const rejectButtons = review.container.querySelectorAll('[data-diff-hunk-reject]');
  acceptButtons[0].click();
  rejectButtons[1].click();

  assert.equal(review.getPendingCount(), 0);
  assert.deepEqual(review.getAcceptedChanges(), [
    {
      ...syncChanges[0],
      patches: [syncChanges[0].patches[0]]
    }
  ]);
});

test('hunk decision collapses the decided hunk and advances focus to the next pending hunk', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' },
        { from: 6, to: 10, expected: 'beta', insert: 'BETA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] },
        { lines: [{ type: 'remove', text: 'beta' }, { type: 'add', text: 'BETA' }] }
      ]
    }
  ];

  const review = createDiffReviewElement(syncChanges);
  review.container.querySelector('[data-diff-hunk-accept]').click();
  const hunks = review.container.querySelectorAll('[data-diff-review-hunk]');

  assert.equal(hunks[0].dataset.collapsed, 'true');
  assert.equal(hunks[0].dataset.focused, 'false');
  assert.equal(hunks[1].dataset.focused, 'true');
});

test('bulk hunk decisions preserve already decided hunks and fill only pending hunks', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' },
        { from: 6, to: 10, expected: 'beta', insert: 'BETA' },
        { from: 11, to: 16, expected: 'gamma', insert: 'GAMMA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] },
        { lines: [{ type: 'remove', text: 'beta' }, { type: 'add', text: 'BETA' }] },
        { lines: [{ type: 'remove', text: 'gamma' }, { type: 'add', text: 'GAMMA' }] }
      ]
    }
  ];

  const acceptRest = createDiffReviewElement(syncChanges);
  acceptRest.container.querySelector('[data-diff-hunk-reject]').click();
  acceptRest.decidePendingChanges(true);
  assert.deepEqual(acceptRest.getAcceptedChanges()[0]?.patches, [
    syncChanges[0].patches[1],
    syncChanges[0].patches[2]
  ]);

  const rejectRest = createDiffReviewElement(syncChanges);
  rejectRest.container.querySelector('[data-diff-hunk-accept]').click();
  rejectRest.decidePendingChanges(false);
  assert.deepEqual(rejectRest.getAcceptedChanges()[0]?.patches, [
    syncChanges[0].patches[0]
  ]);
});

test('file hunk decisions preserve already decided hunks and fill only pending file hunks', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' },
        { from: 6, to: 10, expected: 'beta', insert: 'BETA' },
        { from: 11, to: 16, expected: 'gamma', insert: 'GAMMA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] },
        { lines: [{ type: 'remove', text: 'beta' }, { type: 'add', text: 'BETA' }] },
        { lines: [{ type: 'remove', text: 'gamma' }, { type: 'add', text: 'GAMMA' }] }
      ]
    }
  ];

  const acceptRest = createDiffReviewElement(syncChanges);
  acceptRest.container.querySelector('[data-diff-hunk-reject]').click();
  acceptRest.decideFileChange('main.tex', true);
  assert.deepEqual(acceptRest.getAcceptedChanges()[0]?.patches, [
    syncChanges[0].patches[1],
    syncChanges[0].patches[2]
  ]);

  const rejectRest = createDiffReviewElement(syncChanges);
  rejectRest.container.querySelector('[data-diff-hunk-accept]').click();
  rejectRest.decideFileChange('main.tex', false);
  assert.deepEqual(rejectRest.getAcceptedChanges()[0]?.patches, [
    syncChanges[0].patches[0]
  ]);
});

test('hunk review renders patch text when display diff has fewer hunks than patches', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' },
        { from: 20, to: 24, expected: 'beta', insert: 'BETA' },
        { from: 40, to: 45, expected: 'gamma', insert: 'GAMMA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] }
      ]
    }
  ];

  const review = createDiffReviewElement(syncChanges);
  const lineTexts = review.container
    .querySelectorAll('[data-diff-line]')
    .map(line => line.textContent);

  assert.equal(review.container.querySelectorAll('[data-diff-review-hunk]').length, 3);
  assert.deepEqual(lineTexts, [
    'alpha',
    'ALPHA',
    'beta',
    'BETA',
    'gamma',
    'GAMMA'
  ]);
});

test('hunk jump button calls page bridge with path and offset metadata', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 6, to: 10, expected: 'beta', insert: 'BETA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'beta' }, { type: 'add', text: 'BETA' }] }
      ]
    }
  ];

  const review = createDiffReviewElement(syncChanges);
  review.container.querySelector('[data-diff-hunk-jump]').click();

  assert.deepEqual(JSON.parse(JSON.stringify(createDiffReviewElement.pageBridgeCalls)), [
    {
      method: 'jumpToPosition',
      params: { path: 'main.tex', from: 6, to: 10 }
    }
  ]);
});

test('large diff review initially limits hunks and long hunk lines with explicit expansion controls', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const patches = Array.from({ length: 22 }, (_, index) => ({
    from: index * 10,
    to: index * 10 + 1,
    expected: `old-${index}`,
    insert: `new-${index}`
  }));
  const longLines = Array.from({ length: 85 }, (_, index) => ({
    type: index % 2 ? 'add' : 'remove',
    text: `line-${index}`
  }));
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches,
      diff: patches.map((patch, index) => ({
        lines: index === 0 ? longLines : [{ type: 'add', text: patch.insert }]
      }))
    }
  ];

  const review = createDiffReviewElement(syncChanges);
  assert.equal(review.container.querySelectorAll('[data-diff-review-hunk]').length, 20);
  assert.equal(review.container.querySelectorAll('[data-diff-line]').length, 99);
  assert.equal(review.container.querySelectorAll('[data-diff-show-more-hunks]').length, 1);
  assert.equal(review.container.querySelectorAll('[data-diff-hunk-expand]').length, 1);

  review.container.querySelector('[data-diff-hunk-expand]').click();
  assert.equal(review.container.querySelectorAll('[data-diff-line]').length, 104);

  review.container.querySelector('[data-diff-show-more-hunks]').click();
  assert.equal(review.container.querySelectorAll('[data-diff-review-hunk]').length, 22);
});

test('large diff review applies initial hunk budget globally across files', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const buildChange = pathName => {
    const patches = Array.from({ length: 12 }, (_, index) => ({
      from: index * 10,
      to: index * 10 + 1,
      expected: `${pathName}-old-${index}`,
      insert: `${pathName}-new-${index}`
    }));
    return {
      type: 'write',
      path: pathName,
      patches,
      diff: patches.map(patch => ({
        lines: [{ type: 'add', text: patch.insert }]
      }))
    };
  };

  const review = createDiffReviewElement([
    buildChange('main.tex'),
    buildChange('sections/intro.tex')
  ]);

  assert.equal(review.container.querySelectorAll('[data-diff-review-hunk]').length, 20);
  assert.equal(review.container.querySelectorAll('[data-diff-show-more-hunks]').length, 1);

  review.container.querySelector('[data-diff-show-more-hunks]').click();
  assert.equal(review.container.querySelectorAll('[data-diff-review-hunk]').length, 24);
});

test('large diff review preserves decided hunk status after show more rerender', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const patches = Array.from({ length: 22 }, (_, index) => ({
    from: index * 10,
    to: index * 10 + 1,
    expected: `old-${index}`,
    insert: `new-${index}`
  }));
  const review = createDiffReviewElement([
    {
      type: 'write',
      path: 'main.tex',
      patches,
      diff: patches.map(patch => ({
        lines: [{ type: 'add', text: patch.insert }]
      }))
    }
  ]);

  review.container.querySelector('[data-diff-hunk-accept]').click();
  review.container.querySelector('[data-diff-show-more-hunks]').click();

  assert.equal(review.container.querySelectorAll('[data-diff-hunk-status]').length, 1);
  assert.equal(review.container.querySelectorAll('[data-diff-hunk-accept]').length, 21);
  assert.equal(review.container.querySelectorAll('[data-diff-hunk-reject]').length, 21);
  assert.equal(review.container.querySelectorAll('[data-diff-hunk-jump]').length, 21);
});

test('diff review shortcuts ignore focused hunk action buttons', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const review = createDiffReviewElement([
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] }
      ]
    }
  ]);
  const jumpButton = review.container.querySelector('[data-diff-hunk-jump]');
  const event = {
    type: 'keydown',
    key: 'Enter',
    target: jumpButton,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    }
  };

  review.container.dispatchEvent(event);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(createDiffReviewElement.pageBridgeCalls, []);
});

test('hunk jump failure renders visible hunk-level status text', async () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest({
    pageBridgeResult: { ok: false, reason: 'editor unavailable' }
  });
  const review = createDiffReviewElement([
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] }
      ]
    }
  ]);

  await review.container.querySelector('[data-diff-hunk-jump]').click();

  const status = review.container.querySelector('[data-diff-hunk-jump-status]');
  assert.ok(status);
  assert.match(status.textContent, /editor unavailable/);
  assert.equal(review.container.querySelector('[data-diff-review-hunk]').dataset.jumpStatus, 'failed');
});

test('diff review keyboard shortcuts are scoped and only prevent handled keys', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' },
        { from: 6, to: 10, expected: 'beta', insert: 'BETA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] },
        { lines: [{ type: 'remove', text: 'beta' }, { type: 'add', text: 'BETA' }] }
      ]
    }
  ];
  const review = createDiffReviewElement(syncChanges);
  const dispatchKey = (key, target = review.container) => {
    const event = {
      type: 'keydown',
      key,
      target,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      }
    };
    review.container.dispatchEvent(event);
    return event;
  };

  assert.equal(dispatchKey('x').defaultPrevented, false);
  assert.equal(dispatchKey('a', { tagName: 'INPUT' }).defaultPrevented, false);
  assert.equal(dispatchKey('a').defaultPrevented, true);
  assert.equal(dispatchKey('j').defaultPrevented, true);
  assert.equal(dispatchKey('r').defaultPrevented, true);
  assert.equal(dispatchKey('Escape').defaultPrevented, true);
  assert.equal(review.container.blurred, true);
  assert.equal(review.getPendingCount(), 0);
  assert.deepEqual(review.getAcceptedChanges()[0]?.patches, [syncChanges[0].patches[0]]);
});

test('file-level hunk review action preserves previous hunk decisions for that file', () => {
  const createDiffReviewElement = loadCreateDiffReviewElementForTest();
  const syncChanges = [
    {
      type: 'write',
      path: 'main.tex',
      patches: [
        { from: 0, to: 5, expected: 'alpha', insert: 'ALPHA' },
        { from: 6, to: 10, expected: 'beta', insert: 'BETA' }
      ],
      diff: [
        { lines: [{ type: 'remove', text: 'alpha' }, { type: 'add', text: 'ALPHA' }] },
        { lines: [{ type: 'remove', text: 'beta' }, { type: 'add', text: 'BETA' }] }
      ]
    }
  ];

  const review = createDiffReviewElement(syncChanges);
  review.container.querySelector('[data-diff-hunk-reject]').click();
  review.decideFileChange('main.tex', true);

  assert.equal(review.getPendingCount(), 0);
  assert.deepEqual(
    review.getAcceptedChanges()[0]?.patches,
    [syncChanges[0].patches[1]]
  );
});

test('auto recompile is based on successfully applied Overleaf writes', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  function buildCodexRunParams/)?.[0] || '';
  const applySyncBody = contentScript.match(/async function applySyncChangesToOverleaf[\s\S]*?\n  async function refreshProjectMirrorAfterWriteback/)?.[0] || '';

  assert.doesNotMatch(runTaskBody, /response\.result\.syncChanges[\s\S]*autoRecompileAfterWriteback/);
  assert.match(applySyncBody, /const appliedPaths = getAppliedOperationPaths\(applied\)/);
  assert.match(applySyncBody, /autoRecompileAfterWriteback\(appliedPaths, saveVerification\)/);
  assert.match(contentScript, /preferUiClick:\s*true/);
});

test('@compile-log context is preserved across Codex run retries', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  function buildCodexRunParams/)?.[0] || '';

  assert.match(contentScript, /function buildCodexRunParams\(/);
  assert.match(runTaskBody, /compileLogContext = await awaitRunStep\(resolveCompileLogContext\(\)\)/);
  assert.match(runTaskBody, /mirror_stale[\s\S]*buildCodexRunParams\([\s\S]*compileLogContext/);
  assert.match(runTaskBody, /thread_resume_failed[\s\S]*buildCodexRunParams\([\s\S]*compileLogContext/);
});

test('runTask freezes submitted custom instructions for initial and retry codex runs', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  function buildCodexRunParams/)?.[0] || '';
  const submittedModeIndex = runTaskBody.indexOf('const submittedMode = state.mode');
  const submittedReviewingIndex = runTaskBody.indexOf('const submittedRequireReviewing = state.requireReviewing === true');
  const submittedCustomInstructionsIndex = runTaskBody.indexOf('const submittedCustomInstructions = getCustomInstructionsForCurrentProject()');
  const taskIndex = runTaskBody.indexOf('const task = String(');
  const runParamBlocks = Array.from(runTaskBody.matchAll(/buildCodexRunParams\(\{[\s\S]*?submittedMode\s*\}/g))
    .map(match => match[0]);

  assert.match(contentScript, /function getCustomInstructionsForCurrentProject\(/);
  assert.ok(submittedModeIndex >= 0, 'runTask should freeze the submitted mode');
  assert.ok(submittedReviewingIndex > submittedModeIndex, 'runTask should freeze reviewing after mode');
  assert.ok(
    submittedCustomInstructionsIndex > submittedReviewingIndex,
    'runTask should freeze custom instructions with the submitted run options'
  );
  assert.ok(
    taskIndex > submittedCustomInstructionsIndex,
    'runTask should freeze custom instructions before later run setup can observe settings changes'
  );
  assert.equal(
    runParamBlocks.length,
    3,
    'initial, mirror-stale retry, and thread-resume run params should be visible'
  );
  for (const block of runParamBlocks) {
    assert.match(block, /customInstructions:\s*submittedCustomInstructions/);
    assert.doesNotMatch(block, /getCustomInstructionsForCurrentProject\(\)/);
  }
});

test('content script run-param wrapper uses explicit custom instructions before falling back to getter', () => {
  const contentScript = getContentScriptSource();
  const wrapperBody = contentScript.match(/function buildCodexRunParams\(\{[\s\S]*?\n  function appendRunCancelledReport/)?.[0] || '';
  const wrapperSource = wrapperBody.replace(/\n  function appendRunCancelledReport$/, '');
  const harness = Function(`
    let getterCalls = 0;
    let getterValue = 'fresh getter value';
    const runController = {
      buildCodexRunParams(params) {
        return params;
      }
    };
    const providerSettingsCoordinator = {
      getRunSelection() { return null; }
    };
    const state = {
      mode: 'auto',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      codexOverleafSkills: [],
      codexOverleafSkillEnabled: {}
    };
    let currentRunView = null;
    function getCurrentProjectId() { return 'project-123'; }
    function getCustomInstructionsForCurrentProject() {
      getterCalls++;
      return getterValue;
    }
    function getCodexOverleafSkillEnabled() {
      const map = state.codexOverleafSkillEnabled;
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }
    function isCodexOverleafSkillEnabled(skillId) {
      const map = getCodexOverleafSkillEnabled();
      if (!Object.prototype.hasOwnProperty.call(map, skillId)) {
        return true;
      }
      return map[skillId] !== false;
    }
    function getEnabledCodexOverleafSkillIds() {
      const skills = Array.isArray(state.codexOverleafSkills) ? state.codexOverleafSkills : [];
      return skills
        .map(skill => String(skill && skill.id || '').trim())
        .filter(id => id && isCodexOverleafSkillEnabled(id));
    }
    ${wrapperSource}
    return {
      buildCodexRunParams,
      setGetterValue(value) { getterValue = value; },
      getGetterCalls: () => getterCalls
    };
  `)();

  const explicit = harness.buildCodexRunParams({
    task: '润色摘要',
    customInstructions: 'submitted frozen instructions'
  });
  assert.equal(explicit.customInstructions, 'submitted frozen instructions');
  assert.equal(harness.getGetterCalls(), 0);

  harness.setGetterValue('fallback getter instructions');
  const fallback = harness.buildCodexRunParams({ task: '检查语法' });
  assert.equal(fallback.customInstructions, 'fallback getter instructions');
  assert.equal(harness.getGetterCalls(), 1);
  assert.match(wrapperBody, /customInstructions:\s*customInstructions === undefined\s*\?\s*getCustomInstructionsForCurrentProject\(\)\s*:\s*customInstructions/);
});

test('warm mirror stale retry fetches a real snapshot before full-sync retry', () => {
  const contentScript = getContentScriptSource();
  const staleRetryBody = contentScript.match(/if \(!response\.ok && response\.error\?\.code === 'mirror_stale' && useExistingMirror\) \{[\s\S]*?\n      \}/)?.[0] || '';

  assert.match(staleRetryBody, /const staleRetry = await awaitRunStep\(prepareMirrorStaleRetry/);
  assert.match(staleRetryBody, /project = staleRetry\.project/);
  assert.match(staleRetryBody, /getRunProjectSnapshot\(\)/);
  assert.ok(
    staleRetryBody.indexOf('getRunProjectSnapshot()') < staleRetryBody.indexOf('useExistingMirror: false'),
    'mirror_stale retry must fetch a real snapshot before disabling mirror reuse'
  );
});

test('warm mirror writeback does not seed new empty files as existing base files', () => {
  const contentScript = getContentScriptSource();
  const helperBody = contentScript.match(/function mergeProjectWithSyncChangeBaseFiles\(project = \{\}, syncChanges = \[\]\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const existsHelperBody = contentScript.match(/function syncChangeHasPreviousFile\(change = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const helper = Function(`${existsHelperBody}\nreturn (${helperBody});`)();
  const merged = helper({ files: [] }, [
    { type: 'write', path: 'new-empty.tex', previousContent: '', content: 'new' },
    { type: 'write', path: 'existing.tex', previousExists: true, previousContent: '', content: 'changed' },
    { type: 'write', path: 'empty-existing.tex', previousExists: true, previousContent: '', content: 'now not empty' },
    { type: 'write', path: 'legacy-existing.tex', previousContent: 'before', content: 'after' }
  ]);

  assert.deepEqual(merged.files.map(file => file.path), ['existing.tex', 'empty-existing.tex', 'legacy-existing.tex']);
  assert.doesNotMatch(helperBody, /typeof change\.previousContent !== 'string'/);
  assert.match(existsHelperBody, /change\.previousExists === true|change\.baselineExists === true/);
});

test('mirror prefetch treats expected busy failures as non-retained skips', () => {
  const contentScript = getContentScriptSource();
  const prefetchBody = contentScript.match(/async function syncMirrorPrefetch[\s\S]*?\n  function/)?.[0] || '';
  const skipHelperBody = contentScript.match(/function isExpectedPrefetchSkip[\s\S]*?\n  async function syncMirrorPrefetch/)?.[0] || '';

  assert.match(prefetchBody, /isExpectedPrefetchSkip/);
  assert.match(prefetchBody, /return \{ ok: false, skipped: true/);
  assert.match(skipHelperBody, /project_locked/);
  assert.match(skipHelperBody, /project_changed/);
});

test('warm synthetic runs announce mirror reuse without logging empty snapshot copy', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function preflightWriteSafety/)?.[0] || '';
  const initialRunBody = runTaskBody.split(/\/\/ Handle mirror_stale error by retrying with full sync/)[0] || '';
  const initialRunLines = initialRunBody.split('\n');
  const snapshotLogLineIndex = initialRunLines.findIndex(line => line.includes('appendLog(formatProjectSnapshotUserLog(project))'));

  assert.match(initialRunBody, /if \(!useExistingMirror\) \{[\s\S]*formatProjectSnapshotUserLog\(project\)/);
  assert.ok(snapshotLogLineIndex > 0);
  assert.match(initialRunLines[snapshotLogLineIndex - 1], /if \(!useExistingMirror\) \{/);
});

test('compile page bridge calls use long-running timeouts', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /function getPageBridgeTimeoutMs\(method\)/);
  assert.match(contentScript, /const COMPILE_PAGE_BRIDGE_TIMEOUT_MS\s*=\s*75000/);
  assert.match(contentScript, /method === 'triggerCompile' \|\| method === 'getCompileLog'/);
  assert.match(contentScript, /return COMPILE_PAGE_BRIDGE_TIMEOUT_MS/);
  assert.match(contentScript, /const timeoutMs = getPageBridgeTimeoutMs\(method\)/);
});

test('tracked-change undo page bridge calls have enough time to reject many changes', () => {
  const contentScript = getContentScriptSource();
  const timeoutBody = contentScript.match(/function getPageBridgeTimeoutMs\(method\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(timeoutBody, /method === 'rejectTrackedChanges'/);
  assert.match(timeoutBody, /return 120000/);
});

test('partial writeback report tells the user what already changed and how to recover', () => {
  const contentScript = getContentScriptSource();
  const appendApplyResultBody = contentScript.match(/function appendApplyResult\(result\) \{[\s\S]*?\n  function formatOperationType/)?.[0] || '';
  // v1.4.7: appendApplyResult moved into applyResultFormatters.js while the
  // partial-writeback warning stayed in the runtime, so cross-file index
  // ordering is meaningless; the structural contract is that the warning is
  // its own function, not nested inside appendApplyResult.
  assert.match(contentScript, /function appendPartialWritebackWarning\(/);
  assert.doesNotMatch(appendApplyResultBody, /function appendPartialWritebackWarning/);
  assert.match(contentScript, /部分写入已完成/);
  assert.match(contentScript, /写入被跳过/);
  assert.match(contentScript, /function formatWritebackSkippedNextStep/);
  assert.match(contentScript, /这轮没有任何内容写入。请查看跳过原因，处理后重试。/);
  assert.match(contentScript, /undoRun/);
  assert.match(contentScript, /undoPartialRun/);
  assert.match(contentScript, /recordUndoFromApply\(project, applied\)[\s\S]*appendPartialWritebackWarning\(applied\)/);
  assert.match(contentScript, /appendPartialWritebackWarning\(applied\)/);
});

test('undo flow blocks legacy full-file replaceAll restores that would mark whole documents changed', () => {
  const contentScript = getContentScriptSource();
  const undoRunBody = contentScript.match(/async function undoRun\(runId\) \{[\s\S]*?\n  function recordUndoFromApply/)?.[0] || '';

  assert.match(contentScript, /const MAX_SAFE_UNDO_REPLACEALL_CHARS/);
  assert.match(contentScript, /function findUnsafeFullFileUndoOperation\(/);
  assert.match(undoRunBody, /findUnsafeFullFileUndoOperation\(undoOperations,\s*\{/);
  assert.match(undoRunBody, /allowSnapshotRestore:\s*undoRestore\.snapshotRestore/);
  assert.match(contentScript, /undoUnsafeFullFileTitle/);
});

test('undo flow uses no-trace restoring instead of requiring Reviewing write mode', () => {
  const contentScript = getContentScriptSource();
  const undoRunBody = contentScript.match(/async function undoRun\(runId\) \{[\s\S]*?\n  function findUnsafeFullFileUndoOperation/)?.[0] || '';

  assert.doesNotMatch(undoRunBody, /ensureReviewingBeforeWrite\(run\.undoOperations\)/);
  assert.match(undoRunBody, /reviewingPolicy:\s*'no-trace-undo'/);
  assert.match(contentScript, /undoNoTraceTitle/);
});

test('no-trace undo restores original file snapshots in one operation per file', () => {
  const contentScript = getContentScriptSource();
  const undoRunBody = contentScript.match(/async function undoRun\(runId\) \{[\s\S]*?\n  async function undoRunTrackedChanges/)?.[0] || '';
  const recordUndoBody = contentScript.match(/function recordUndoFromApply\(project, applyResult\) \{[\s\S]*?\n  function normalizeApplyTrackedChanges/)?.[0] || '';

  assert.match(contentScript, /function buildNoTraceUndoRestoreOperations\(run\)/);
  assert.match(contentScript, /function hasNoTraceSnapshotUndo\(run\)/);
  assert.match(contentScript, /buildSnapshotRestoreUndo/);
  assert.match(undoRunBody, /const undoRestore = buildNoTraceUndoRestore\(run\)/);
  assert.match(undoRunBody, /const undoOperations = undoRestore\.operations/);
  assert.match(undoRunBody, /operations:\s*selectedOperations/);
  assert.match(undoRunBody, /baseFiles:\s*run\.undoBaseFiles \|\| \[\]/);
  assert.match(recordUndoBody, /record\.undoExpectedFiles = selectExpectedFilesForTrackedUndo\(project, combinedAppliedOperations, \[\]\)/);
  assert.doesNotMatch(recordUndoBody, /record\.undoExpectedFiles = \[\]/);
});

test('no-trace undo marks button applied when verified restore succeeds despite stale leftover skips', () => {
  const contentScript = getContentScriptSource();
  const undoRunBody = contentScript.match(/async function undoRun\(runId\) \{[\s\S]*?\n  async function undoRunTrackedChanges/)?.[0] || '';

  assert.match(contentScript, /function isUndoResultEffectivelyApplied\(run, result\)/);
  assert.match(undoRunBody, /const undoApplied = isUndoResultEffectivelyApplied\(run, result\)/);
  assert.match(undoRunBody, /status:\s*undoApplied \? 'completed' : result\.skipped\?\.length \? 'failed' : 'completed'/);
  assert.match(undoRunBody, /setRunUndoStatus\(runId,\s*undoApplied && fullSelection \? 'applied' : 'partial'\)/);
});

test('reviewing write undo rejects Overleaf tracked changes instead of text patching', () => {
  const contentScript = getContentScriptSource();
  const undoRunBody = contentScript.match(/async function undoRun\(runId\) \{[\s\S]*?\n  function appendUndoReviewingPolicyEvent/)?.[0] || '';
  const recordUndoBody = contentScript.match(/function recordUndoFromApply\(project, applyResult\) \{[\s\S]*?\n  function appendRunRecordEvent/)?.[0] || '';

  assert.match(undoRunBody, /rejectTrackedChanges/);
  assert.match(undoRunBody, /run\.undoTrackedChanges/);
  assert.match(recordUndoBody, /applyResult\?\.trackedChanges/);
  assert.match(recordUndoBody, /undoTrackedChanges/);
  assert.match(recordUndoBody, /undoCheckpointMissing/);
});

test('reviewing write undo passes post-run content so Overleaf native undo can revert the whole transaction', () => {
  const contentScript = getContentScriptSource();
  const pageBridge = fs.readFileSync(
    path.join(__dirname, '../extension/src/pageBridge.js'),
    'utf8'
  );
  // v1.8.0 phase 7: the editor-undo reject flow lives in
  // trackedChangesLifecycle.js; pin across router + lifecycle.
  const writebackRouter = fs.readFileSync(
    path.join(__dirname, '../extension/src/page/writebackRouter.js'),
    'utf8'
  ) + fs.readFileSync(
    path.join(__dirname, '../extension/src/page/trackedChangesLifecycle.js'),
    'utf8'
  );
  const undoRunBody = contentScript.match(/async function undoRunTrackedChanges\(runId, run\) \{[\s\S]*?\n  function getRunUndoCount/)?.[0] || '';
  const undoCountBody = contentScript.match(/function getRunUndoCount\(run\) \{[\s\S]*?\n  function appendUndoReviewingPolicyEvent/)?.[0] || '';
  const recordUndoBody = contentScript.match(/function recordUndoFromApply\(project, applyResult\) \{[\s\S]*?\n  function normalizeApplyTrackedChanges/)?.[0] || '';

  assert.match(contentScript, /buildExpectedFilesAfterOperations/);
  assert.match(contentScript, /function buildTrackedUndoPostFiles\(run\)/);
  assert.match(contentScript, /function hasTrackedEditorUndo\(run\)/);
  assert.match(undoRunBody, /postFiles:\s*buildTrackedUndoPostFiles\(run\)/);
  assert.match(contentScript, /hasTrackedEditorUndo\(run\)/);
  assert.match(undoCountBody, /hasTrackedEditorUndo\(run\)\s*\?\s*1\s*:\s*0/);
  assert.match(recordUndoBody, /hasTrackedEditorUndo\(record\)/);
  assert.match(recordUndoBody, /undoCheckpointNative/);
  assert.match(writebackRouter, /function rejectTrackedChangesViaEditorUndo/);
  assert.match(writebackRouter, /rejectTrackedChangesViaEditorUndo\(expectedFiles,\s*postFiles,\s*applied\)[\s\S]*?if \(!trackedChanges\.length\)/);
  assert.match(writebackRouter, /function findEditorUndoControl/);
  assert.match(writebackRouter, /method:\s*'overleaf-editor-undo'/);
});

test('run card adds a blue Accept changes button before the Undo button', () => {
  const contentScript = getContentScriptSource();
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const renderRunCardBody = contentScript.match(/function renderRunCard\(run\) \{[\s\S]*?\n  function getRunStatusText/)?.[0] || '';

  // The Accept changes button markup sits in .run-turn-meta before [data-run-undo].
  const metaMarkup = renderRunCardBody.match(/<div class="run-turn-meta">[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(metaMarkup, /data-run-accept/);
  assert.match(metaMarkup, /data-run-undo/);
  assert.ok(
    metaMarkup.indexOf('data-run-accept') < metaMarkup.indexOf('data-run-undo'),
    'Accept changes button must come before the Undo button'
  );
  assert.match(renderRunCardBody, /configureAcceptButton\(root, run\)/);
  // Distinct from the diff panel's diffAcceptAll key.
  assert.match(css, /#codex-overleaf-panel \.run-turn-meta \[data-run-accept\]/);
});

test('Accept changes i18n keys are distinct from the diff panel keys in both locales', () => {
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );

  assert.match(i18n, /runAcceptTracked:\s*'Accept changes'/);
  assert.match(i18n, /runAcceptTrackedConfirm:/);
  assert.match(i18n, /runAcceptTrackedCancel:/);
  assert.match(i18n, /runAcceptTrackedDone:\s*'Accepted'/);
  // The superseded partial / closed-ledger keys are gone in both locales.
  assert.doesNotMatch(i18n, /runAcceptTrackedRetry/);
  assert.doesNotMatch(i18n, /runAcceptTrackedResolvedElsewhere/);
});

test('configureAcceptButton renders Accept All from trackedChangeStatus for tracked-change-lifecycle runs', () => {
  const contentScript = getContentScriptSource();
  const acceptBody = contentScript.match(/function configureAcceptButton\(root, run\) \{[\s\S]*?\n  (?:async )?function /)?.[0] || '';

  assert.match(contentScript, /function configureAcceptButton\(root, run\)/);
  // Mirrors configureUndoButton's clone-and-replace pattern.
  assert.match(acceptBody, /cloneNode\(true\)/);
  assert.match(acceptBody, /replaceWith\(button\)/);
  // Renders by trackedChangeStatus.
  assert.match(acceptBody, /trackedChangeStatus/);
  assert.match(acceptBody, /isTrackedChangeLifecycleRun\(run\)/);
  // pending shows the actionable button.
  assert.match(acceptBody, /'pending'/);
  // accepted -> disabled "Accepted" label.
  assert.match(acceptBody, /runAcceptTrackedDone/);
  // rejected -> the button stays present but greyed (both buttons greyed).
  assert.match(acceptBody, /'rejected'/);
  // No superseded partial / resolved-elsewhere model.
  assert.doesNotMatch(acceptBody, /partial_accept/);
  assert.doesNotMatch(acceptBody, /runAcceptTrackedRetry/);
  assert.doesNotMatch(acceptBody, /resolved_elsewhere/);
});

test('run worlds split: legacy-undo runs never show Accept All and keep the undoStatus path', () => {
  const contentScript = getContentScriptSource();

  // A run is in the tracked-change lifecycle iff trackedChangeStatus is set OR
  // undoTrackedChanges.length > 0.
  assert.match(contentScript, /function isTrackedChangeLifecycleRun\(run\)/);
  const worldBody = contentScript.match(/function isTrackedChangeLifecycleRun\(run\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(worldBody, /trackedChangeStatus/);
  assert.match(worldBody, /undoTrackedChanges/);

  // configureUndoButton branches on the run world: lifecycle runs render from
  // trackedChangeStatus, legacy-undo runs keep the existing undoStatus path.
  const undoBody = contentScript.match(/function configureUndoButton\(root, run\) \{[\s\S]*?\n  function refreshRunCard/)?.[0] || '';
  assert.match(undoBody, /isTrackedChangeLifecycleRun\(run\)/);
  // Legacy path still uses undoStatus.
  assert.match(undoBody, /run\.undoStatus/);
});

test('acceptRun uses an inline confirm flow before dispatching acceptTrackedChanges', () => {
  const contentScript = getContentScriptSource();
  const acceptRunBody = contentScript.match(/async function acceptRun\(runId\) \{[\s\S]*?\n  (?:async )?function /)?.[0] || '';

  assert.match(contentScript, /async function acceptRun\(runId\)/);
  // Inline confirm: the accept only fires through the page bridge.
  assert.match(acceptRunBody, /callPageBridge\('acceptTrackedChanges'/);
  assert.match(acceptRunBody, /trackedChanges:\s*run\.undoTrackedChanges/);
  // Accept All passes the run's own forward writeback operations so the page
  // layer replays the exact targeted patches instead of a whole-file overwrite.
  assert.match(acceptRunBody, /appliedOperations:\s*Array\.isArray\(run\.appliedOperations\)/);
  // The accept button shows an inline Confirm / Cancel before firing.
  const inlineConfirm = contentScript.match(/function wireAcceptInlineConfirm\(button, runId\) \{[\s\S]*?\n  (?:async )?function /)?.[0] || '';
  assert.match(inlineConfirm, /runAcceptTrackedConfirm/);
  assert.match(inlineConfirm, /runAcceptTrackedCancel/);
  // The accept dispatches only on the Confirm click.
  assert.match(inlineConfirm, /confirmBtn\.addEventListener\('click'[\s\S]*?acceptRun\(runId\)/);
});

test('acceptRun drives the run to a decisive terminal accepted via the §7 settlement helper, with no partial / closed-ledger model', () => {
  const contentScript = getContentScriptSource();

  // The closed-ledger classifier is gone; a single decisive terminal helper remains.
  assert.doesNotMatch(contentScript, /function applyTrackedChangeLedger\(/);
  assert.match(contentScript, /function applyTerminalTrackedChangeStatus\(/);
  const terminalBody = contentScript.match(/function applyTerminalTrackedChangeStatus\([\s\S]*?\n  \}/)?.[0] || '';
  // It sets the terminal status and empties the heavy payload. The decision
  // about *whether* to land in a terminal status is now made by the §7
  // settlement helper (`applyAcceptSettlement`/`applyRejectSettlement`).
  assert.match(terminalBody, /run\.trackedChangeStatus = status/);
  assert.match(terminalBody, /run\.undoTrackedChanges = \[\]/);
  assert.match(terminalBody, /run\.undoExpectedFiles = \[\]/);
  // No partial / resolved-elsewhere branching.
  assert.doesNotMatch(terminalBody, /partial_accept/);
  assert.doesNotMatch(terminalBody, /resolved_elsewhere/);

  // acceptRun reaches terminal 'accepted' through the settlement helper, which
  // calls `applyTerminalTrackedChangeStatus(runId, 'accepted')` only when
  // post-action proof is sufficient.
  const acceptRunBody = contentScript.match(/async function acceptRun\(runId\) \{[\s\S]*?\n  (?:async )?function /)?.[0] || '';
  assert.match(acceptRunBody, /applyAcceptSettlement\(runId,\s*result\)/);
  // The applyAcceptSettlement helper still terminates at applyTerminalTrackedChangeStatus
  // when the result is proof-clean.
  const settlementBody = contentScript.match(/function applyAcceptSettlement\([\s\S]*?\n  function /)?.[0] || '';
  assert.match(settlementBody, /applyTerminalTrackedChangeStatus\(runId,\s*'accepted'\)/);
});

// Behavioral coverage for the run-card state machine: these drive the actual
// extracted control functions against fake runs / fake DOM, complementing the
// source-text assertions above.

function trackedRefs() {
  return [
    { key: 'k1', id: 'i1', path: 'main.tex', label: 'change one' },
    { key: 'k2', id: 'i2', path: 'main.tex', label: 'change two' }
  ];
}

test('configureAcceptButton renders the Accept All control per trackedChangeStatus (behavioral)', () => {
  const cases = [
    // pending -> actionable.
    { status: 'pending', refs: trackedRefs(), expect: { hidden: false, disabled: false, text: 'runAcceptTracked' } },
    // accepted -> disabled "Accepted" label.
    { status: 'accepted', refs: [], expect: { hidden: false, disabled: true, text: 'runAcceptTrackedDone' } },
    // rejected -> Accept All stays present but greyed (both buttons greyed).
    { status: 'rejected', refs: [], expect: { hidden: false, disabled: true, text: 'runAcceptTracked' } }
  ];

  for (const testCase of cases) {
    const run = { id: 'run-1', trackedChangeStatus: testCase.status, undoTrackedChanges: testCase.refs };
    const harness = loadRunCardControlsHarness({ state: { runs: [run] } });
    const root = buildRunCardRoot('run-1');

    harness.configureAcceptButton(root, run);
    const accept = root.querySelector('[data-run-accept]');

    assert.equal(accept.hidden, testCase.expect.hidden, `${testCase.status}: hidden`);
    if (!testCase.expect.hidden) {
      assert.equal(accept.disabled, testCase.expect.disabled, `${testCase.status}: disabled`);
      assert.equal(accept.textContent, testCase.expect.text, `${testCase.status}: label`);
    }
  }
});

test('terminal runs keep both Accept All and Undo visible but disabled (behavioral)', () => {
  // accepted -> Accept All disabled "Accepted"; Undo present but disabled/greyed.
  const acceptedRun = { id: 'run-a', trackedChangeStatus: 'accepted', undoTrackedChanges: [] };
  let harness = loadRunCardControlsHarness({ state: { runs: [acceptedRun] } });
  let root = buildRunCardRoot('run-a');
  harness.configureAcceptButton(root, acceptedRun);
  harness.configureUndoButton(root, acceptedRun);
  let accept = root.querySelector('[data-run-accept]');
  let undo = root.querySelector('[data-run-undo]');
  assert.equal(accept.hidden, false, 'accepted: Accept All visible');
  assert.equal(accept.disabled, true, 'accepted: Accept All disabled');
  assert.equal(accept.textContent, 'runAcceptTrackedDone', 'accepted: Accept All label');
  assert.equal(undo.hidden, false, 'accepted: Undo still visible');
  assert.equal(undo.disabled, true, 'accepted: Undo disabled/greyed');

  // rejected -> Undo disabled "Undone"; Accept All present but disabled/greyed.
  const rejectedRun = { id: 'run-r', trackedChangeStatus: 'rejected', undoTrackedChanges: [] };
  harness = loadRunCardControlsHarness({ state: { runs: [rejectedRun] } });
  root = buildRunCardRoot('run-r');
  harness.configureAcceptButton(root, rejectedRun);
  harness.configureUndoButton(root, rejectedRun);
  accept = root.querySelector('[data-run-accept]');
  undo = root.querySelector('[data-run-undo]');
  assert.equal(undo.hidden, false, 'rejected: Undo visible');
  assert.equal(undo.disabled, true, 'rejected: Undo disabled');
  assert.equal(undo.textContent, 'undoApplied', 'rejected: Undo label');
  assert.equal(accept.hidden, false, 'rejected: Accept All still visible');
  assert.equal(accept.disabled, true, 'rejected: Accept All disabled/greyed');
});

test('configureAcceptButton hides the Accept All control entirely for legacy-undo runs (behavioral)', () => {
  // No trackedChangeStatus and no tracked-change refs -> not a lifecycle run.
  const run = { id: 'run-legacy', undoOperations: [{ type: 'edit', path: 'main.tex' }] };
  const harness = loadRunCardControlsHarness({ state: { runs: [run] } });
  const root = buildRunCardRoot('run-legacy');

  harness.configureAcceptButton(root, run);

  const accept = root.querySelector('[data-run-accept]');
  assert.equal(accept.hidden, true);
  // No inline-confirm pair was wired for a non-lifecycle run.
  assert.equal(root.querySelectorAll('[data-run-accept-confirm]').length, 0);
});

test('configureAcceptButton drops orphaned inline-confirm buttons on mid-confirm re-render (behavioral)', () => {
  const run = { id: 'run-1', trackedChangeStatus: 'pending', undoTrackedChanges: trackedRefs() };
  const harness = loadRunCardControlsHarness({ state: { runs: [run] } });
  const root = buildRunCardRoot('run-1');

  harness.configureAcceptButton(root, run);
  // Open the inline confirm flow: clicking Accept All appends a Confirm/Cancel pair.
  root.querySelector('[data-run-accept]').click();
  assert.equal(root.querySelectorAll('[data-run-accept-confirm]').length, 1);
  assert.equal(root.querySelectorAll('[data-run-accept-cancel]').length, 1);

  // A re-render now fires while the confirm pair is showing.
  harness.configureAcceptButton(root, run);

  assert.equal(
    root.querySelectorAll('[data-run-accept-confirm]').length, 0,
    'stale Confirm button must be removed on re-render'
  );
  assert.equal(
    root.querySelectorAll('[data-run-accept-cancel]').length, 0,
    'stale Cancel button must be removed on re-render'
  );
  // Exactly one Accept control remains, freshly rebuilt and visible.
  const accepts = root.querySelectorAll('[data-run-accept]');
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0].hidden, false);
});

test('applyTerminalTrackedChangeStatus: accept reaches terminal accepted, refs emptied (behavioral)', () => {
  const run = {
    id: 'run-1',
    trackedChangeStatus: 'pending',
    undoTrackedChanges: trackedRefs(),
    undoExpectedFiles: [{ path: 'main.tex', content: 'x' }]
  };
  const panel = new RunCardNode('div');
  panel.append(buildRunCardRoot('run-1'));
  const harness = loadRunCardControlsHarness({ state: { runs: [run] }, panel });

  harness.applyTerminalTrackedChangeStatus('run-1', 'accepted');

  assert.equal(run.trackedChangeStatus, 'accepted');
  assert.deepEqual(run.undoTrackedChanges, []);
  assert.deepEqual(run.undoExpectedFiles, []);
});

test('applyTerminalTrackedChangeStatus: reject reaches terminal rejected, refs emptied (behavioral)', () => {
  const run = {
    id: 'run-r',
    trackedChangeStatus: 'pending',
    undoTrackedChanges: trackedRefs(),
    undoExpectedFiles: [{ path: 'main.tex', content: 'x' }]
  };
  const panel = new RunCardNode('div');
  panel.append(buildRunCardRoot('run-r'));
  const harness = loadRunCardControlsHarness({ state: { runs: [run] }, panel });

  harness.applyTerminalTrackedChangeStatus('run-r', 'rejected');

  assert.equal(run.trackedChangeStatus, 'rejected');
  assert.deepEqual(run.undoTrackedChanges, []);
  assert.deepEqual(run.undoExpectedFiles, []);
});

test('applyTerminalTrackedChangeStatus: terminal is unconditional and decisive — there is no partial state (behavioral)', () => {
  // Even with refs still present (a best-effort accept that left some refs),
  // the run reaches the terminal status and the payload is emptied — no retry.
  const run = {
    id: 'run-1',
    trackedChangeStatus: 'pending',
    undoTrackedChanges: trackedRefs(),
    undoExpectedFiles: [{ path: 'main.tex', content: 'x' }]
  };
  const panel = new RunCardNode('div');
  panel.append(buildRunCardRoot('run-1'));
  const harness = loadRunCardControlsHarness({ state: { runs: [run] }, panel });

  harness.applyTerminalTrackedChangeStatus('run-1', 'accepted');

  assert.equal(run.trackedChangeStatus, 'accepted');
  assert.deepEqual(run.undoTrackedChanges, []);
  assert.deepEqual(run.undoExpectedFiles, []);
  // A non-terminal value is ignored — only terminal transitions are allowed.
  const pendingRun = { id: 'run-2', trackedChangeStatus: 'pending', undoTrackedChanges: trackedRefs(), undoExpectedFiles: [] };
  const harness2 = loadRunCardControlsHarness({ state: { runs: [pendingRun] }, panel: (() => { const p = new RunCardNode('div'); p.append(buildRunCardRoot('run-2')); return p; })() });
  harness2.applyTerminalTrackedChangeStatus('run-2', 'pending');
  assert.equal(pendingRun.trackedChangeStatus, 'pending');
  assert.equal(pendingRun.undoTrackedChanges.length, 2);
});

test('configureAcceptButton: needs_review keeps Accept actionable without exposing a third button state (behavioral)', () => {
  // §7 settlement matrix: a needs_review run means proof was insufficient. Both
  // Accept and Undo stay visible AND actionable, but the primary controls still
  // render as the same executable state as pending.
  const run = { id: 'run-nr', trackedChangeStatus: 'needs_review', undoTrackedChanges: trackedRefs() };
  const harness = loadRunCardControlsHarness({ state: { runs: [run] } });
  const root = buildRunCardRoot('run-nr');

  harness.configureAcceptButton(root, run);
  harness.configureUndoButton(root, run);

  const accept = root.querySelector('[data-run-accept]');
  const undo = root.querySelector('[data-run-undo]');
  assert.equal(accept.hidden, false, 'needs_review: Accept visible');
  assert.equal(accept.disabled, false, 'needs_review: Accept actionable');
  assert.equal(accept.textContent, 'runAcceptTracked', 'needs_review: Accept label stays executable');
  assert.equal(accept.title, 'runAcceptTrackedTitle', 'needs_review: Accept tooltip stays executable');
  assert.equal(undo.hidden, false, 'needs_review: Undo visible');
  assert.equal(undo.disabled, false, 'needs_review: Undo actionable');
  assert.equal(undo.textContent, 'undoRun', 'needs_review: Undo label stays executable');
});

test('configureAcceptButton needs_review branch wires the inline-confirm flow so Accept can still be retried (behavioral)', () => {
  const run = { id: 'run-nr2', trackedChangeStatus: 'needs_review', undoTrackedChanges: trackedRefs() };
  const harness = loadRunCardControlsHarness({ state: { runs: [run] } });
  const root = buildRunCardRoot('run-nr2');

  harness.configureAcceptButton(root, run);
  // Clicking Accept in needs_review state should also open the inline confirm flow.
  root.querySelector('[data-run-accept]').click();
  assert.equal(root.querySelectorAll('[data-run-accept-confirm]').length, 1, 'needs_review: Confirm button appears');
  assert.equal(root.querySelectorAll('[data-run-accept-cancel]').length, 1, 'needs_review: Cancel button appears');
});

test('acceptRun settlement: successful page action routes to accepted even with warning-class proof codes (source)', () => {
  // Two-state run-card lifecycle — verify the source keeps the settlement
  // helper but lets successful page-side accept work become terminal.
  // Behavioral acceptRun coverage requires a full content-runtime harness that
  // is out of scope for this test file; the source-level assertion locks the
  // contract that downstream subagents can rely on.
  const contentScript = getContentScriptSource();

  // Settlement helper must exist and still know about needs_review codes for
  // explicit no-op/failure outcomes.
  assert.match(contentScript, /function applyAcceptSettlement\(/);
  assert.match(contentScript, /tracked_changes_remain/);
  assert.match(contentScript, /accept_not_verified/);
  // The settlement helper, not the unconditional terminal call, is what
  // acceptRun invokes after the page bridge returns ok.
  const acceptRunBody = contentScript.match(/async function acceptRun\(runId\) \{[\s\S]*?\n  (?:async )?function /)?.[0] || '';
  assert.match(acceptRunBody, /applyAcceptSettlement\(runId,\s*result\)/);
  assert.doesNotMatch(acceptRunBody, /applyTerminalTrackedChangeStatus\(runId,\s*'accepted'\)/);
});

test('undoRunTrackedChanges settlement: successful page action routes to rejected even with warning-class proof codes (source)', () => {
  const contentScript = getContentScriptSource();

  // Symmetric settlement helper for the lifecycle Undo path.
  assert.match(contentScript, /function applyRejectSettlement\(/);
  assert.match(contentScript, /undo_not_verified/);
  assert.match(contentScript, /undo_operation_failed/);
  assert.match(contentScript, /undo_reviewing_restore_unverified/);
  assert.match(contentScript, /tracked_change_nodes_not_identified/);

  const undoTrackedBody = contentScript.match(/async function undoRunTrackedChanges\(runId, run\) \{[\s\S]*?\n  (?:async )?function /)?.[0] || '';
  // The lifecycle reject path now hands off to applyRejectSettlement, not the
  // unconditional terminal call.
  assert.match(undoTrackedBody, /applyRejectSettlement\(runId,\s*result\)/);
  assert.doesNotMatch(undoTrackedBody, /applyTerminalTrackedChangeStatus\(runId,\s*'rejected'\)/);
});

test('applyAcceptSettlement distinguishes blocked vs successful terminal vs retryable needs_review (source)', () => {
  const contentScript = getContentScriptSource();
  const body = contentScript.match(/function applyAcceptSettlement\([\s\S]*?\n  function /)?.[0] || '';

  // Three branches:
  //   1. primary.terminalState === 'blocked' → stay pending (no terminal call).
  //   2. successful page-side work → applyTerminalTrackedChangeStatus(runId, 'accepted').
  //   3. otherwise needs_review code/terminalState → set 'needs_review'.
  assert.match(body, /terminalState\s*===\s*'blocked'/);
  assert.match(body, /isSuccessfulTrackedChangeSettlement\(result\)/);
  assert.match(body, /'needs_review'/);
  assert.match(body, /applyTerminalTrackedChangeStatus\(runId,\s*'accepted'\)/);
});

test('content runtime tracks needs_review as actionable without exposing a third button state (source)', () => {
  // Source-level assertion: configureAcceptButton/configureLifecycleUndoButton
  // include a needs_review branch BEFORE the terminal accepted/rejected branches
  // so the user can still retry, while rendering the same executable copy as
  // pending.
  const contentScript = getContentScriptSource();
  const acceptBody = contentScript.match(/function configureAcceptButton\([\s\S]*?\n  (?:async )?function /)?.[0] || '';
  const undoBody = contentScript.match(/function configureLifecycleUndoButton\([\s\S]*?\n  (?:async )?function /)?.[0] || '';

  assert.match(acceptBody, /status\s*===\s*'needs_review'/);
  assert.match(acceptBody, /runAcceptTracked/);
  assert.doesNotMatch(acceptBody, /runAcceptTrackedNeedsReview/);
  assert.match(undoBody, /status\s*===\s*'needs_review'/);
  assert.match(undoBody, /undoRun/);
  assert.doesNotMatch(undoBody, /runUndoNeedsReview/);
});

test('lifecycle Undo defers terminal rejected to the settlement helper, not an unconditional call', () => {
  const contentScript = getContentScriptSource();
  const undoTrackedBody = contentScript.match(/async function undoRunTrackedChanges\(runId, run\) \{[\s\S]*?\n  (?:async )?function /)?.[0] || '';

  // The lifecycle reject path now hands off to applyRejectSettlement, which is
  // the §7 proof-aware replacement for the v1.3.7 unconditional terminal call.
  assert.match(undoTrackedBody, /applyRejectSettlement\(runId,\s*result\)/);
  // No closed-ledger machinery survives.
  assert.doesNotMatch(undoTrackedBody, /applyTrackedChangeLedger/);
});

test('recordUndoFromApply sets trackedChangeStatus pending when it records tracked-change refs', () => {
  const contentScript = getContentScriptSource();
  const recordUndoBody = contentScript.match(/function recordUndoFromApply\(project, applyResult\) \{[\s\S]*?\n  function normalizeApplyTrackedChanges/)?.[0] || '';

  // When refs are recorded, the run enters the tracked-change lifecycle as pending.
  assert.match(recordUndoBody, /trackedChangeStatus\s*=\s*'pending'/);
  // A run that records no tracked-change refs stays a legacy-undo run.
  assert.match(recordUndoBody, /combinedTrackedChanges\.length/);
});

test('change preview is grouped by file with edit evidence instead of raw operation counts', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /function groupOperationsByFile\(/);
  assert.match(contentScript, /function formatFileChangePreview\(/);
  assert.match(contentScript, /patches/);
  assert.match(contentScript, /局部修改/);
  assert.match(contentScript, /find/);
  assert.match(contentScript, /replace/);
  assert.doesNotMatch(contentScript, /replaceAll: change\.content \|\| ''/);
  assert.doesNotMatch(contentScript, /修改计划：编辑 \$\{summary\.counts\.edit/);
});

test('stale write copy explains user or collaborator edits without snapshot jargon', () => {
  const staleGuard = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/staleGuard.js'),
    'utf8'
  );

  assert.match(staleGuard, /任务执行期间被你或协作者改过/);
  assert.match(staleGuard, /Codex 没有覆盖它/);
  assert.doesNotMatch(staleGuard, /task-start snapshot/);
  assert.doesNotMatch(staleGuard, /captured the project snapshot/);
});

test('confirmation prompts render as Codex plugin dialogs instead of browser page alerts', () => {
  const contentScript = getContentScriptSource();
  const panelRenderer = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/panelRenderer.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.doesNotMatch(contentScript, /window\.confirm\s*\(/);
  assert.match(panelRenderer, /data-plugin-confirm/);
  assert.match(contentScript, /async function showPluginConfirm\(/);
  assert.match(panelRenderer, /confirmBrand/);
  assert.match(contentScript, /assets\/icons\/codex-overleaf-dialog-icon\.png/);
  assert.doesNotMatch(contentScript, /assets\/icons\/codex-overleaf-icon\.png/);
  assert.doesNotMatch(contentScript, /assets\/icons\/icon32\.png/);
  assert.equal(
    fs.existsSync(path.join(__dirname, '../extension/assets/icons/codex-overleaf-dialog-icon.png')),
    true
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.equal(
    manifest.web_accessible_resources[0].resources.includes('assets/icons/codex-overleaf-dialog-icon.png'),
    true
  );
  assert.match(css, /\.codex-plugin-confirm/);
  assert.match(css, /\.codex-plugin-confirm-card/);
});

test('English locale is applied to dialogs, diff review, undo controls, and transcripts', () => {
  const contentScript = getContentScriptSource();
  const panelRenderer = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/panelRenderer.js'),
    'utf8'
  );
  const diffReviewPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diffReviewPanel.js'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );

  const undoBody = contentScript.match(/function configureUndoButton\(root, run\) \{[\s\S]*?\n  function refreshRunCard/)?.[0] || '';
  const transcriptCallBody = contentScript.match(/function appendNativeEvent\([^)]*\) \{[\s\S]*?\n  function appendRunEvent/)?.[0] || '';
  const completionBody = contentScript.match(/function appendCompletionReport\(input = \{\}\) \{[\s\S]*?\n  function formatCompletionWork/)?.[0] || '';

  assert.match(i18n, /confirmBrand:\s*'Codex Confirm'/);
  assert.match(i18n, /diffAcceptAll:\s*'Accept all'/);
  assert.match(i18n, /undoRun:\s*'Undo changes'/);
  assert.match(panelRenderer, /brand\.textContent = tr\('confirmBrand'\)/);
  assert.match(diffReviewPanel, /tr\('diffAccepted'\)/);
  assert.match(diffReviewPanel, /tr\('diffAcceptAll'\)/);
  assert.match(undoBody, /tr\('undoRun'\)/);
  assert.match(undoBody, /tr\('undoApplied'\)/);
  assert.match(transcriptCallBody, /mapAgentEventToActivity\(event,\s*\{\s*locale:\s*getLocale\(\)\s*\}\)/);
  assert.match(completionBody, /locale:\s*getLocale\(\)/);
});

test('page bridge messages require same-origin responses in both directions', () => {
  const contentScript = getContentScriptSource();
  const pageBridge = fs.readFileSync(
    path.join(__dirname, '../extension/src/pageBridge.js'),
    'utf8'
  );

  assert.match(contentScript, /event\.origin !== window\.location\.origin/);
  assert.match(pageBridge, /event\.origin !== window\.location\.origin/);
  assert.match(contentScript, /pageBridgeVersion !== CodexOverleafCompatibility\?\.BUILD_TARGET_VERSION/);
  assert.match(pageBridge, /pageBridgeVersion:\s*PAGE_BRIDGE_INSTALL_VERSION/);
  assert.match(pageBridge, /__codexOverleafPageBridgeInstalledVersion/);
});

test('page bridge exposes a read-only realtime OT observer', () => {
  const contentScript = getContentScriptSource();
  const pageBridge = fs.readFileSync(
    path.join(__dirname, '../extension/src/pageBridge.js'),
    'utf8'
  );
  const injectPageBridgeBody = contentScript.match(/async function injectPageBridge\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const optionalOtBody = contentScript.match(/async function injectOptionalOtDependencies\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const pageBridgeScripts = Array.from(
    injectPageBridgeBody.matchAll(/injectScriptOnce\('([^']+)'/g),
    match => match[1]
  );
  const optionalScripts = Array.from(
    optionalOtBody.matchAll(/injectScriptOnce\('([^']+)'/g),
    match => match[1]
  );
  const otTextIndex = optionalScripts.indexOf('src/shared/otText.js');
  const observerIndex = optionalScripts.indexOf('src/page/overleafRealtimeObserver.js');
  const capabilityIndex = pageBridgeScripts.indexOf('src/page/pageBridgeCapability.js');
  const pageBridgeIndex = pageBridgeScripts.indexOf('src/pageBridge.js');

  assert.ok(optionalOtBody, 'content script keeps optional OT dependency loading separate from page bridge loading');
  assert.ok(otTextIndex > -1, 'content script explicitly injects the OT text helper into the page world when available');
  assert.ok(observerIndex > -1, 'content script explicitly injects the realtime observer into the page world when available');
  assert.ok(capabilityIndex > -1, 'content script injects the page bridge capability guard');
  assert.ok(pageBridgeIndex > -1, 'content script injects the page bridge');
  assert.ok(otTextIndex < observerIndex, 'OT text helper loads before the realtime observer');
  assert.ok(capabilityIndex < pageBridgeIndex, 'page bridge capability guard loads before the page bridge');
  assert.match(injectPageBridgeBody, /await injectOptionalOtDependencies\(\)[\s\S]*await injectScriptOnce\('src\/pageBridge\.js'/);
  assert.match(optionalOtBody, /try\s*\{[\s\S]*src\/shared\/otText\.js[\s\S]*src\/page\/overleafRealtimeObserver\.js[\s\S]*\}\s*catch \(_error\) \{/);
  assert.match(pageBridge, /CodexOverleafRealtimeObserver\.create/);
  assert.match(pageBridge, /method === 'startOtObserver'/);
  assert.match(pageBridge, /method === 'stopOtObserver'/);
  assert.match(pageBridge, /method === 'getOtStatus'/);
  assert.match(pageBridge, /method === 'drainOtEvents'/);
  assert.doesNotMatch(pageBridge, /\b(?:writeOt|applyOt|sendOt)\b/);
});

test('header exposes project custom instructions settings and editor surface', () => {
  const contentScript = getContentScriptSource();
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const panelRenderer = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/panelRenderer.js'),
    'utf8'
  );
  const settingsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/settingsPanel.js'),
    'utf8'
  );
  const headerActions = panelRenderer.match(/<div class="codex-vscode-head-actions"[\s\S]*data-custom-instructions-settings[\s\S]*?<\/div>/)?.[0] || '';
  const settingsSource = `${contentScript}\n${settingsPanel}`;

  assert.match(headerActions, /data-new-session/);
  assert.match(headerActions, /data-custom-instructions-settings/);
  assert.ok(
    headerActions.indexOf('data-new-session') < headerActions.indexOf('data-custom-instructions-settings'),
    'custom instructions settings must be the rightmost header action after New Session'
  );
  assert.match(settingsSource, /data-custom-instructions-panel/);
  assert.match(settingsSource, /data-custom-instructions-input/);
  assert.doesNotMatch(settingsSource, /data-custom-instructions-save/);
  assert.doesNotMatch(settingsSource, /data-custom-instructions-learn-more/);
  for (const key of [
    'personalizationConfig',
    'customInstructionsPlaceholder',
    'settingsScopeProjectTitle',
    'settingsScopeGlobalTitle'
  ]) {
    assert.match(settingsSource, new RegExp(`data-i18n="${key}"|tr\\('${key}'\\)`), `settings panel should use ${key}`);
    assert.match(i18n, new RegExp(`${key}:\\s*'`), `i18n should define ${key}`);
  }
  assert.match(css, /\.codex-custom-instructions-panel/);
  assert.match(css, /\.codex-custom-instructions-input/);
});

test('project custom instructions Learn more link has been removed', () => {
  const settingsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/settingsPanel.js'),
    'utf8'
  );
  const contentScript = getContentScriptSource();
  const contentSurface = `${contentScript}\n${settingsPanel}`;

  assert.doesNotMatch(contentSurface, /data-custom-instructions-learn-more/);
  assert.doesNotMatch(contentScript, /showCustomInstructionsLearnMore/);
  assert.doesNotMatch(contentScript, /customInstructionsLearnMoreToast/);
});

test('project custom instructions editor auto-saves on change and restores by project', async () => {
  const contentScript = getContentScriptSource();
  const harness = Function(`
    let currentProjectId = 'project_a';
    let savedCount = 0;
    let focused = false;
    let customInstructionsEditorProjectId = '';
    let customInstructionsEditorValue = '';
    let state = {
      customInstructionsByProject: {}
    };
    const customInstructionsInput = {
      value: '',
      placeholder: '',
      focus() { focused = true; }
    };
    const settingsButton = {
      dataset: { view: 'settings' },
      setAttribute(name, value) { this[name] = value; }
    };
    const fakeInput = (value = '') => ({ value, checked: false });
    const controls = {
      '[data-custom-instructions-input]': customInstructionsInput,
      '[data-custom-instructions-settings]': settingsButton,
      '[data-reasoning]': fakeInput(),
      '[data-mode]': fakeInput('ask'),
      '[data-task]': fakeInput(),
      '[data-speed]': fakeInput('standard'),
      '[data-require-reviewing]': fakeInput(),
      '[data-auto-recompile]': fakeInput(),
      '[data-experimental-ot]': null,
      '[data-model]': null,
      '[data-project-settings-panel]': null
    };
    // panel.dataset.view drives the settings-visibility guard in readPanelInputs
    const panel = {
      dataset: { view: 'settings' },
      querySelector(selector) {
        return Object.prototype.hasOwnProperty.call(controls, selector) ? controls[selector] : null;
      },
      querySelectorAll() { return []; }
    };
    const settingsPanelInstance = {};
    const SettingsPanel = {
      show() {
        settingsButton.dataset.active = 'true';
        settingsButton.setAttribute('aria-expanded', 'true');
        customInstructionsInput.focus();
      },
      hide() {
        settingsButton.dataset.active = 'false';
        settingsButton.setAttribute('aria-expanded', 'false');
      },
      setStatus() {},
      clearStatus() {},
      isVisible() { return panel.dataset.view === 'settings'; },
      loadState() {},
      readState() {
        return {
          governanceRules: {},
          skillToggles: {}
        };
      }
    };
    const panelRendererInstance = {
      setView(v) { panel.dataset.view = v; }
    };
    function getPanel() { return panel; }
    function getState() { return state; }
    function setState(next) { state = next; }
    function getSettingsPanelInstance() { return settingsPanelInstance; }
    function getPanelRendererInstance() { return panelRendererInstance; }
    function getCurrentProjectId() { return currentProjectId; }
    let lastExperimentalOtProjectId = '';
    function getSkillLoadingSettings() {
      return {
        loadCodexLocalSkills: state.loadCodexLocalSkills !== false,
        loadCodexOverleafSkills: state.loadCodexOverleafSkills !== false
      };
    }
    function setSkillLoadingSettings(settings) {
      if (settings && typeof settings === 'object') {
        state = { ...state, ...settings };
      }
    }
    async function saveState() { savedCount++; }
    // Stub the route-aware branch of closeCustomInstructionsSettings; this
    // settings-persistence test pins the in-project flow.
    const window = { location: { pathname: '/project/' + 'a'.repeat(24) } };
    ${runtimeStubs({ omit: ['getSkillLoadingSettings', 'setSkillLoadingSettings', 'saveState'] })}
    ${extractFromContentScript( 'normalizeCustomInstructionsByProject')}
    ${extractFromContentScript( 'getCustomInstructionsForCurrentProject')}
    ${extractFromContentScript( 'setCustomInstructionsForProject')}
    ${extractFromContentScript( 'syncCustomInstructionsEditorForProject')}
    ${extractFromContentScript( 'clearProjectSettingsStatus')}
    ${extractFromContentScript( 'openCustomInstructionsSettings')}
    ${extractFromContentScript( 'closeCustomInstructionsSettings')}
    ${extractFromContentScript( 'readPanelInputs')}
    ${extractFromContentScript( 'persistPanelInputs')}
    return {
      input: customInstructionsInput,
      panel,
      settingsButton,
      getState: () => state,
      getSavedCount: () => savedCount,
      wasFocused: () => focused,
      navigate(projectId) {
        currentProjectId = projectId;
        syncCustomInstructionsEditorForProject(projectId);
      },
      openCustomInstructionsSettings,
      closeCustomInstructionsSettings,
      persistPanelInputs
    };
  `)();

  harness.openCustomInstructionsSettings();
  assert.equal(harness.wasFocused(), true);
  assert.equal(harness.panel.dataset.view, 'settings');

  harness.input.value = 'Use NeurIPS style and \\\\cref{}.';
  await harness.persistPanelInputs();
  assert.equal(
    harness.getState().customInstructionsByProject.project_a,
    'Use NeurIPS style and \\\\cref{}.'
  );
  assert.equal(harness.getSavedCount(), 1);

  harness.navigate('project_b');
  assert.equal(harness.input.value, '');

  harness.navigate('project_a');
  assert.equal(harness.input.value, 'Use NeurIPS style and \\\\cref{}.');
});

test('settings save feedback is per-card: no global chip, persist has no dead status writer (v1.7.1)', () => {
  const contentScript = getContentScriptSource();
  // The global header Saved chip and its Saving/Saved lifecycle are gone —
  // per-card flashSaved (settingsPanel) is the single feedback mechanism.
  assert.doesNotMatch(contentScript, /setSettingsSaveStatus/);
  assert.doesNotMatch(contentScript, /data-settings-save-status/);
  const persist = extractFromContentScript('persistPanelInputs');
  assert.match(persist, /await saveState\(\)/);
  const settingsPanel = fs.readFileSync(path.join(__dirname, '..', 'extension/src/content/settingsPanel.js'), 'utf8');
  assert.match(settingsPanel, /function flashSaved\(instance, event\)/);
});

test('project settings gear toggles the settings panel closed when already open', () => {
  const contentScript = getContentScriptSource();
  const harness = Function(`
    let currentProjectId = 'project_a';
    let focused = false;
    let customInstructionsEditorProjectId = '';
    let customInstructionsEditorValue = '';
    let state = {
      customInstructionsByProject: {}
    };
    const customInstructionsInput = {
      value: '',
      placeholder: '',
      focus() { focused = true; }
    };
    const customInstructionsPanel = {
      hidden: true
    };
    const settingsButton = {
      dataset: {},
      setAttribute(name, value) { this[name] = value; }
    };
    const controls = {
      '[data-custom-instructions-input]': customInstructionsInput,
      '[data-custom-instructions-panel]': customInstructionsPanel,
      '[data-custom-instructions-settings]': settingsButton
    };
    const panel = {
      querySelector(selector) {
        return controls[selector] || null;
      }
    };
    const settingsPanelInstance = {};
    const SettingsPanel = {
      show() {
        customInstructionsPanel.hidden = false;
        settingsButton.dataset.active = 'true';
        settingsButton.setAttribute('aria-expanded', 'true');
        customInstructionsInput.focus();
      },
      hide() {
        customInstructionsPanel.hidden = true;
        settingsButton.dataset.active = 'false';
        settingsButton.setAttribute('aria-expanded', 'false');
      },
      isVisible() {
        return customInstructionsPanel.hidden === false;
      },
      setStatus() {},
      clearStatus() {},
      loadState() {}
    };
    const panelRendererInstance = null;
    function getPanel() { return panel; }
    function getState() { return state; }
    function setState(next) { state = next; }
    function getSettingsPanelInstance() { return settingsPanelInstance; }
    function getPanelRendererInstance() { return panelRendererInstance; }
    function getCurrentProjectId() { return currentProjectId; }
    // Stub the route-aware branch of closeCustomInstructionsSettings; this
    // toggle test pins the in-project flow (per-project session view).
    const window = { location: { pathname: '/project/' + 'a'.repeat(24) } };
    ${runtimeStubs()}
    ${extractFromContentScript( 'normalizeCustomInstructionsByProject')}
    ${extractFromContentScript( 'syncCustomInstructionsEditorForProject')}
    ${extractFromContentScript( 'clearProjectSettingsStatus')}
    ${extractFromContentScript( 'openCustomInstructionsSettings')}
    ${extractFromContentScript( 'closeCustomInstructionsSettings')}
    ${extractFromContentScript( 'toggleCustomInstructionsSettings')}
    return {
      settingsPanel: customInstructionsPanel,
      settingsButton,
      wasFocused: () => focused,
      toggleCustomInstructionsSettings
    };
  `)();

  harness.toggleCustomInstructionsSettings();
  assert.equal(harness.settingsPanel.hidden, false);
  assert.equal(harness.settingsButton.dataset.active, 'true');
  assert.equal(harness.settingsButton['aria-expanded'], 'true');
  assert.equal(harness.wasFocused(), true);

  harness.toggleCustomInstructionsSettings();
  assert.equal(harness.settingsPanel.hidden, true);
  assert.equal(harness.settingsButton.dataset.active, 'false');
  assert.equal(harness.settingsButton['aria-expanded'], 'false');
});

test('project settings transient status is cleared when reopening the panel', () => {
  const contentScript = getContentScriptSource();
  const harness = Function(`
    let currentProjectId = 'project_a';
    let focused = false;
    let customInstructionsEditorProjectId = '';
    let customInstructionsEditorValue = '';
    let state = {
      customInstructionsByProject: {}
    };
    const customInstructionsInput = {
      value: '',
      placeholder: '',
      focus() { focused = true; }
    };
    const customInstructionsPanel = {
      hidden: true
    };
    const settingsButton = {
      dataset: {},
      setAttribute(name, value) { this[name] = value; }
    };
    const projectSettingsStatus = {
      textContent: '',
      dataset: {}
    };
    const controls = {
      '[data-custom-instructions-input]': customInstructionsInput,
      '[data-custom-instructions-panel]': customInstructionsPanel,
      '[data-custom-instructions-settings]': settingsButton,
      '[data-project-settings-status]': projectSettingsStatus
    };
    const panel = {
      querySelector(selector) {
        return controls[selector] || null;
      }
    };
    const settingsPanelInstance = {};
    const SettingsPanel = {
      show() {
        customInstructionsPanel.hidden = false;
        settingsButton.dataset.active = 'true';
        settingsButton.setAttribute('aria-expanded', 'true');
        customInstructionsInput.focus();
      },
      hide() {
        customInstructionsPanel.hidden = true;
        settingsButton.dataset.active = 'false';
        settingsButton.setAttribute('aria-expanded', 'false');
      },
      setStatus(_instance, text, status) {
        projectSettingsStatus.textContent = text || '';
        projectSettingsStatus.dataset.status = status;
      },
      clearStatus() {
        projectSettingsStatus.textContent = '';
        delete projectSettingsStatus.dataset.status;
      },
      loadState() {}
    };
    const panelRendererInstance = null;
    function getPanel() { return panel; }
    function getState() { return state; }
    function setState(next) { state = next; }
    function getSettingsPanelInstance() { return settingsPanelInstance; }
    function getPanelRendererInstance() { return panelRendererInstance; }
    function getCurrentProjectId() { return currentProjectId; }
    // The transient-status test pins the in-project flow (registry stubs keep
    // isProjectEditorRoute true so closeCustomInstructionsSettings exercises
    // the per-project setView('session') branch; the off-route branch has its
    // own test). window is referenced by the route check; supply a stub
    // location so the sandbox does not blow up on window.location derefs.
    const window = { location: { pathname: '/project/' + 'a'.repeat(24) } };
    ${runtimeStubs()}
    ${extractFromContentScript( 'normalizeCustomInstructionsByProject')}
    ${extractFromContentScript( 'syncCustomInstructionsEditorForProject')}
    ${extractFromContentScript( 'setProjectSettingsStatus')}
    ${extractFromContentScript( 'clearProjectSettingsStatus')}
    ${extractFromContentScript( 'openCustomInstructionsSettings')}
    ${extractFromContentScript( 'closeCustomInstructionsSettings')}
    return {
      status: projectSettingsStatus,
      openCustomInstructionsSettings,
      closeCustomInstructionsSettings,
      setProjectSettingsStatus,
      wasFocused: () => focused
    };
  `)();

  harness.openCustomInstructionsSettings();
  harness.setProjectSettingsStatus('Codex Overleaf skill removed.', 'completed');
  assert.equal(harness.status.textContent, 'Codex Overleaf skill removed.');
  assert.equal(harness.status.dataset.status, 'completed');

  harness.closeCustomInstructionsSettings();
  harness.openCustomInstructionsSettings();

  assert.equal(harness.status.textContent, '');
  assert.notEqual(harness.status.dataset.status, 'completed');
  assert.equal(harness.wasFocused(), true);
});

test('mirror prefetch state sync preserves unsaved custom instructions for same project', () => {
  const contentScript = getContentScriptSource();
  const harness = Function(`
    let currentProjectId = 'project_a';
    let state = {
      customInstructionsByProject: {
        project_a: 'Saved instructions'
      }
    };
    let customInstructionsEditorProjectId = '';
    let customInstructionsEditorValue = '';
    let mirrorPrefetchState = {
      inFlight: null,
      lastSuccessAt: 10,
      lastErrorAt: 0,
      lastError: null,
      timer: null,
      projectId: 'project_a'
    };
    const customInstructionsInput = {
      value: '',
      placeholder: ''
    };
    const panel = {
      dataset: { view: 'settings' },
      querySelector(selector) {
        if (selector === '[data-custom-instructions-input]') {
          return customInstructionsInput;
        }
        return null;
      }
    };
    const window = {
      clearTimeout() {}
    };
    function getCurrentProjectId() { return currentProjectId; }
    ${runtimeStubs()}
    ${extractFromContentScript( 'normalizeCustomInstructionsByProject')}
    ${extractFromContentScript( 'syncCustomInstructionsEditorForProject')}
    ${extractFromContentScript( 'syncMirrorPrefetchStateForProject')}
    return {
      input: customInstructionsInput,
      syncCustomInstructionsEditorForProject,
      syncMirrorPrefetchStateForProject
    };
  `)();

  harness.syncCustomInstructionsEditorForProject('project_a', { force: true });
  assert.equal(harness.input.value, 'Saved instructions');

  harness.input.value = 'Unsaved typed instructions';
  harness.syncMirrorPrefetchStateForProject();

  assert.equal(harness.input.value, 'Unsaved typed instructions');
});

test('stored project custom instructions are rehydrated before lightweight prefs are saved', () => {
  const contentScript = getContentScriptSource();
  const loadBody = contentScript.match(/async function loadStoredState\(\) \{[\s\S]*?\n  async function saveState/)?.[0] || '';
  // saveState was widened in Fix A to accept an `options` argument with
  // projectIdOverride; the regex now tolerates either signature.
  const saveBody = contentScript.match(/async function saveState\([^)]*\) \{[\s\S]*?\n  function appendStorageNoticeOnce/)?.[0] || '';

  assert.match(loadBody, /experimentalOtByProject:\s*prefs\.experimentalOtByProject \|\| \{\}/);
  assert.match(loadBody, /customInstructionsByProject:\s*prefs\.customInstructionsByProject \|\| \{\}/);
  assert.match(saveBody, /compactState\.experimentalOtByProject = state\.experimentalOtByProject/);
  assert.match(saveBody, /compactState\.customInstructionsByProject = state\.customInstructionsByProject/);
});

test('saveState merges latest lightweight prefs before saving project-scoped settings', async () => {
  const contentScript = getContentScriptSource();
  const StorageDbModule = require('../extension/src/shared/storageDb');
  const { prepareStateForStorage } = require('../extension/src/shared/sessionState');

  const harness = Function('StorageDbModule', 'prepareStateForStorage', `
    const savedPrefs = [];
    const storedSessionRecords = [];
    const deletedSessionIds = [];
    let loadPrefsCount = 0;
    let state = {
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      speedTier: 'standard',
      mode: 'confirm',
      locale: 'en',
      requireReviewing: true,
      autoRecompile: false,
      panelWidth: 420,
      activeSessionId: 'session_current',
      codexOverleafSkillEnabled: { 'venue-style': false },
      experimentalOtByProject: {
        project_a: false,
        project_b: false
      },
      customInstructionsByProject: {
        project_a: '',
        project_b: 'stale instructions from this tab'
      },
      sessions: [{
        id: 'session_current',
        title: 'Current task',
        titleSource: 'manual',
        focusFiles: [],
        codexThreadId: '',
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:01:00.000Z',
        runs: [{
          id: 'run_current',
          task: 'Current task',
          status: 'completed',
          statusText: 'Done 7s',
          startedAt: '2026-05-06T00:00:00.000Z',
          finishedAt: '2026-05-06T00:00:07.000Z',
          events: [{
            title: '本轮完成报告',
            status: 'completed',
            kind: 'report',
            detail: '结论：刷新后历史仍应显示这段回答。'
          }]
        }],
        history: [{
          task: 'Current task',
          result: '结论：刷新后历史仍应显示这段回答。',
          at: '2026-05-06T00:00:07.000Z'
        }],
        task: 'Current task',
        mode: 'confirm',
        model: 'gpt-5.4',
        reasoningEffort: 'high',
        speedTier: 'standard',
        requireReviewing: true
      }]
    };
    const latestPrefs = {
      storageSchemaVersion: 1,
      model: 'older-model',
      unknownFuturePref: { keep: true },
      autoRecompile: true,
      activeSessionByProject: {
        project_a: 'session_from_other_tab',
        project_b: 'session_b'
      },
      experimentalOtByProject: {
        project_a: true,
        project_b: true,
        project_c: false
      },
      customInstructionsByProject: {
        project_a: 'newer instructions from another tab',
        project_b: 'keep project b instructions',
        project_c: 'keep project c instructions'
      }
    };
    const StorageDb = {
      ...StorageDbModule,
      putRecords(_storeName, records) {
        storedSessionRecords.push(...records);
        return Promise.resolve(records);
      },
      getAllByIndex() {
        return Promise.resolve([{ id: 'old_project_session' }]);
      },
      deleteRecord(_storeName, id) {
        deletedSessionIds.push(id);
        return Promise.resolve();
      }
    };
    const Migration = {
      loadPrefs() {
        loadPrefsCount++;
        return Promise.resolve(JSON.parse(JSON.stringify(latestPrefs)));
      },
      savePrefs(prefs) {
        savedPrefs.push(JSON.parse(JSON.stringify(prefs)));
        return Promise.resolve();
      }
    };
    const window = {
      CodexOverleafStorageDb: StorageDb,
      CodexOverleafStorageMigration: Migration
    };
    function getCurrentProjectId() { return 'project_a'; }
    function getCodexOverleafSkillEnabled() {
      const map = state.codexOverleafSkillEnabled;
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }
    ${extractFromContentScript( 'normalizeExperimentalOtByProject')}
    ${extractFromContentScript( 'normalizeCustomInstructionsByProject')}
    // Fix A inlined helpers: saveState now reads currentRunView through a
    // defensive accessor and the projectIdOverride / divergent-skip branch
    // logs via appendPlainLog(tx(...)). Provide minimal stubs so the
    // happy-path test still drives saveState end-to-end.
    let currentRunView = null;
    function appendPlainLog() {}
    function tx(en) { return en; }
    function notifyAggressiveCompactionOnce() {}
    ${extractFromContentScript( 'readLiveRunViewForSaveStateGuard')}
    ${extractFromContentScript( 'saveState')}
    return {
      saveState,
      getSavedPrefs: () => savedPrefs[0],
      getLoadPrefsCount: () => loadPrefsCount,
      getStoredSessionRecords: () => storedSessionRecords,
      getDeletedSessionIds: () => deletedSessionIds
    };
  `)(StorageDbModule, prepareStateForStorage);

  await harness.saveState();

  assert.equal(harness.getLoadPrefsCount(), 1);
  assert.deepEqual(harness.getSavedPrefs().unknownFuturePref, { keep: true });
  assert.equal(harness.getSavedPrefs().autoRecompile, false);
  assert.deepEqual(harness.getSavedPrefs().activeSessionByProject, {
    project_a: 'session_current',
    project_b: 'session_b'
  });
  assert.deepEqual(harness.getSavedPrefs().experimentalOtByProject, {
    project_a: false,
    project_b: true,
    project_c: false
  });
  assert.deepEqual(harness.getSavedPrefs().customInstructionsByProject, {
    project_a: '',
    project_b: 'keep project b instructions',
    project_c: 'keep project c instructions'
  });
  assert.equal(harness.getStoredSessionRecords().length, 1);
  assert.equal(harness.getStoredSessionRecords()[0].task, 'Current task');
  assert.equal(harness.getStoredSessionRecords()[0].history[0].result, '结论：刷新后历史仍应显示这段回答。');
  assert.equal(harness.getStoredSessionRecords()[0].runs[0].task, 'Current task');
  assert.equal(harness.getStoredSessionRecords()[0].runs[0].statusText, 'Done 7s');
  assert.equal(harness.getStoredSessionRecords()[0].runs[0].events[0].detail, '结论：刷新后历史仍应显示这段回答。');
  assert.deepEqual(harness.getDeletedSessionIds(), ['old_project_session']);
  assert.deepEqual(harness.getSavedPrefs().codexOverleafSkillEnabled, { 'venue-style': false });
});

test('experimental OT sync ignores stale responses and reverts failed starts to default off', () => {
  const contentScript = getContentScriptSource();
  const syncBody = contentScript.match(/async function syncOtWarmMirrorController\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const failBody = contentScript.match(/function handleFailedOtStart\(projectId, requestId\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const projectChangeBody = contentScript.match(/function syncOtWarmMirrorStateForProject\(\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(contentScript, /let otSyncRequestId\s*=\s*0/);
  assert.match(contentScript, /function syncExperimentalOtToggleForProject\(/);
  assert.match(syncBody, /const projectId = getCurrentProjectId\(\)/);
  assert.match(syncBody, /const requestId = \+\+otSyncRequestId/);
  assert.match(syncBody, /const enabled = isExperimentalOtEnabledForProject\(projectId\)/);
  assert.match(syncBody, /isCurrentOtSync\(requestId,\s*projectId\)/);
  assert.match(syncBody, /getCurrentProjectId\(\) !== projectId/);
  assert.match(syncBody, /handleStaleOtStartResponse\(projectId,\s*requestId\)/);
  assert.match(syncBody, /isSuccessfulOtBridgeResponse\(response\)/);
  assert.match(syncBody, /handleFailedOtStart\(projectId,\s*requestId\)/);
  assert.match(failBody, /setExperimentalOtEnabledForProject\(projectId,\s*false\)/);
  assert.match(failBody, /experimentalOtCheckbox\.checked = false/);
  assert.match(failBody, /updateOtStatusDisplay\('unavailable'\)/);
  assert.match(failBody, /saveStateSoon\(\)/);
  assert.match(projectChangeBody, /otWarmMirrorProjectId = projectId/);
  assert.match(projectChangeBody, /syncExperimentalOtToggleForProject\(projectId\)/);
  assert.match(projectChangeBody, /otSyncRequestId\+\+/);
  assert.match(projectChangeBody, /callPageBridge\('stopOtObserver',\s*\{\s*\}\)/);
  assert.match(projectChangeBody, /syncOtWarmMirrorController\(\)/);
});

test('experimental OT input persistence does not leak checked state after project change', () => {
  const contentScript = getContentScriptSource();
  const harness = Function(`
    let currentProjectId = 'project_a';
    let currentOtStatus = 'observing';
    let lastExperimentalOtProjectId = 'project_a';
    let state = {
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      speedTier: 'standard',
      mode: 'confirm',
      task: '',
      requireReviewing: true,
      autoRecompile: true,
      experimentalOtByProject: { project_a: true }
    };
    const experimentalOtCheckbox = { checked: true };
    const controls = {
      '[data-reasoning]': { value: 'high' },
      '[data-mode]': { value: 'confirm' },
      '[data-task]': { value: '' },
      '[data-require-reviewing]': { checked: true },
      '[data-auto-recompile]': { checked: true },
      '[data-experimental-ot]': experimentalOtCheckbox
    };
    const panel = {
      querySelector(selector) {
        return controls[selector] || null;
      }
    };
    function getCurrentProjectId() { return currentProjectId; }
    function updateActiveSession(current, patch) { return { ...current, ...patch }; }
    function readSelectedModelInput() { return state.model; }
    function readSelectedSpeedInput() { return state.speedTier; }
    function updateOtStatusDisplay(status) { currentOtStatus = status; }
    ${runtimeStubs({ omit: [
      'updateActiveSession',
      'readSelectedModelInput',
      'readSelectedSpeedInput',
      'updateOtStatusDisplay',
      'setExperimentalOtEnabledForProject',
      'syncExperimentalOtToggleForProject'
    ] })}
    ${extractFromContentScript( 'normalizeExperimentalOtByProject')}
    ${extractFromContentScript( 'isExperimentalOtEnabledForProject')}
    ${extractFromContentScript( 'setExperimentalOtEnabledForProject')}
    ${extractFromContentScript( 'syncExperimentalOtToggleForProject')}
    ${extractFromContentScript( 'readPanelInputs')}
    return {
      checkbox: experimentalOtCheckbox,
      getState: () => state,
      getStatus: () => currentOtStatus,
      navigate(projectId) { currentProjectId = projectId; },
      readPanelInputs
    };
  `)();

  assert.equal(harness.checkbox.checked, true);
  harness.navigate('project_b');
  harness.readPanelInputs();

  assert.equal(harness.checkbox.checked, false);
  assert.equal(harness.getState().experimentalOtByProject.project_a, true);
  assert.equal(harness.getState().experimentalOtByProject.project_b, false);
  assert.equal(harness.getStatus(), 'off');
});

test('experimental OT stop does not mark off when stop bridge fails', () => {
  const contentScript = getContentScriptSource();
  const syncBody = contentScript.match(/async function syncOtWarmMirrorController\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const disabledIndex = syncBody.indexOf('if (!enabled) {');
  const failedStopIndex = syncBody.indexOf('if (!isSuccessfulOtBridgeResponse(response))', disabledIndex);
  const unavailableIndex = syncBody.indexOf("updateOtStatusDisplay('unavailable')", failedStopIndex);
  const offIndex = syncBody.indexOf("updateOtStatusDisplay('off')", disabledIndex);

  assert.notEqual(disabledIndex, -1, 'sync should have a disabled stop branch');
  assert.notEqual(failedStopIndex, -1, 'disabled branch should check stop bridge success');
  assert.notEqual(unavailableIndex, -1, 'failed stop should show unavailable');
  assert.notEqual(offIndex, -1, 'successful stop should show off');
  assert.ok(offIndex > failedStopIndex, 'off status should only be applied after successful stop handling');
  assert.ok(offIndex > unavailableIndex, 'off status should not be applied inside failed stop handling');
});

test('markdown links only allow http and https URLs', () => {
  const contentScript = getContentScriptSource();
  const hrefBody = contentScript.match(/function formatMarkdownHref\(href\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(hrefBody, /protocol === 'http:' \|\| parsed\.protocol === 'https:'/);
  assert.doesNotMatch(hrefBody, /file:\/\//);
  assert.doesNotMatch(hrefBody, /return target/);
});

test('markdown renderer recognizes multi-character headings with project line ranges', () => {
  const harness = loadMarkdownRendererHarness([{ path: 'resume-zh_CN.tex', kind: 'text' }]);
  const target = createMinimalDocument().createElement('div');

  harness.renderMarkdownBlockText(target, [
    '## 教育背景 (resume-zh_CN.tex:56-60)',
    '',
    '后续正文。'
  ].join('\n'));

  const headings = collectElements(target, node => node.className === 'run-final-heading');
  assert.equal(headings.length, 1);
  assert.equal(collectElementText(headings[0]), '教育背景 (resume-zh_CN.tex:56-60)');
  assert.equal(target.children[0], headings[0]);
  assert.equal(collectElementText(target.children[1]), '后续正文。');
});

test('completion reports keep leading markdown headings at logical line start', () => {
  const contentScript = getContentScriptSource();
  const source = [
    extractFunction(contentScript, 'hasLeadingMarkdownBlock'),
    extractFunction(contentScript, 'formatConclusionMarkdown')
  ].join('\n');
  const formatConclusionMarkdown = Function('getLocale', `
    ${source}
    return formatConclusionMarkdown;
  `)(() => 'en');

  assert.equal(
    formatConclusionMarkdown('## 教育背景 (resume-zh_CN.tex:56-60)'),
    'Conclusion:\n## 教育背景 (resume-zh_CN.tex:56-60)'
  );
  assert.equal(formatConclusionMarkdown('- first\n- second'), 'Conclusion:\n- first\n- second');
  assert.equal(formatConclusionMarkdown('Plain answer.'), 'Conclusion: Plain answer.');
});

test('markdown renderer turns resolvable plain line references into safe jump buttons', async () => {
  const harness = loadMarkdownRendererHarness([
    { path: 'main.tex', kind: 'text' },
    { path: 'sections/main.tex', kind: 'text' },
    { path: 'sections/intro.tex', kind: 'text' },
    { path: 'appendix/intro.tex', kind: 'text' },
    { path: 'assets/data.tex', kind: 'binary' }
  ]);
  const target = createMinimalDocument().createElement('div');

  target.replaceChildren(...harness.buildMarkdownInlineNodes(
    'See main.tex:117 and sections/intro.tex:42. Ambiguous intro.tex:8 and binary assets/data.tex:9 stay text.'
  ));

  const buttons = findLineReferenceButtons(target);
  assert.deepEqual(buttons.map(button => button.textContent), ['main.tex:117', 'sections/intro.tex:42']);
  assert.equal(buttons[0].type, 'button');
  assert.equal(buttons[0].dataset.path, 'main.tex');
  assert.equal(buttons[0].dataset.line, '117');
  assert.equal(buttons[0].getAttribute('aria-label'), 'Open main.tex line 117');
  assert.match(collectElementText(target), /Ambiguous intro\.tex:8/);
  assert.match(collectElementText(target), /binary assets\/data\.tex:9/);

  await buttons[0].click();

  assert.deepEqual(harness.pageBridgeCalls[0], {
    method: 'jumpToPosition',
    params: { path: 'main.tex', line: 117, selectLine: true }
  });
});

test('markdown renderer leaves inline and fenced code refs non-clickable', () => {
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }]);
  const inlineTarget = createMinimalDocument().createElement('div');
  const blockTarget = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(inlineTarget, '`see main.tex:42` and main.tex:43');
  harness.renderMarkdownBlockText(blockTarget, [
    '```tex',
    'main.tex:99',
    '```',
    '',
    'Outside main.tex:100'
  ].join('\n'));

  assert.deepEqual(findLineReferenceButtons(inlineTarget).map(button => button.textContent), ['main.tex:43']);
  assert.deepEqual(findLineReferenceButtons(blockTarget).map(button => button.textContent), ['main.tex:100']);
  assert.match(collectElementText(inlineTarget), /main\.tex:42/);
  assert.match(collectElementText(blockTarget), /main\.tex:99/);
});

test('markdown renderer turns standalone inline code location refs into jump buttons', async () => {
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }]);
  const target = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(target, '位置在 `main.tex:28`。');

  const buttons = findLineReferenceButtons(target);
  assert.deepEqual(buttons.map(button => button.textContent), ['main.tex:28']);
  assert.equal(collectElements(target, node => node.tagName === 'CODE').length, 0);

  await buttons[0].click();

  assert.deepEqual(harness.pageBridgeCalls[0], {
    method: 'jumpToPosition',
    params: { path: 'main.tex', line: 28, selectLine: true }
  });
});

test('line-reference buttons render with link-like visual affordance', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  assert.match(css, /#codex-overleaf-panel \.codex-line-reference\s*\{/);
  // The link hue is now the unified accent token (theme-aware) instead of a raw blue.
  assert.match(css, /\.codex-line-reference[\s\S]*color:\s*var\(--tl-accent\)/);
  assert.match(css, /\.codex-line-reference[\s\S]*text-decoration:\s*underline/);
  assert.match(css, /\.codex-line-reference[\s\S]*cursor:\s*pointer/);
  assert.match(css, /\.codex-line-reference[\s\S]*background:\s*transparent/);
});

test('markdown renderer sanitizes local absolute paths inside inline and fenced code', () => {
  const rawLocalPath = '/Users/alice/.codex-overleaf/projects/p/workspace/main.tex:42';
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }]);
  const inlineTarget = createMinimalDocument().createElement('div');
  const blockTarget = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(inlineTarget, `Inline \`${rawLocalPath}\``);
  harness.renderMarkdownBlockText(blockTarget, ['```', rawLocalPath, '```'].join('\n'));

  assert.equal(collectElementText(inlineTarget).includes('/Users/alice'), false);
  assert.equal(collectElementText(blockTarget).includes('/Users/alice'), false);
  assert.equal(findLineReferenceButtons(inlineTarget).length, 0);
  assert.equal(findLineReferenceButtons(blockTarget).length, 0);
});

test('line-reference button clicks distinguish line and line-column jumps', async () => {
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }]);
  const target = createMinimalDocument().createElement('div');
  target.replaceChildren(...harness.buildMarkdownInlineNodes('main.tex:42 and main.tex:42:7'));

  const buttons = findLineReferenceButtons(target);
  await buttons[0].click();
  await buttons[1].click();

  assert.deepEqual(harness.pageBridgeCalls, [
    {
      method: 'jumpToPosition',
      params: { path: 'main.tex', line: 42, selectLine: true }
    },
    {
      method: 'jumpToPosition',
      params: { path: 'main.tex', line: 42, column: 7, selectLine: false }
    }
  ]);
});

test('markdown renderer makes every adjacent punctuation-separated line reference clickable', async () => {
  const harness = loadMarkdownRendererHarness([{ path: 'camera_ready.tex', kind: 'text' }]);
  const target = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(
    target,
    '对应位置包括 camera_ready.tex:169、camera_ready.tex:225，camera_ready.tex:248,camera_ready.tex:252。'
  );

  const buttons = findLineReferenceButtons(target);
  assert.deepEqual(
    buttons.map(button => button.textContent),
    [
      'camera_ready.tex:169',
      'camera_ready.tex:225',
      'camera_ready.tex:248',
      'camera_ready.tex:252'
    ]
  );

  for (const button of buttons) {
    await button.click();
  }

  assert.deepEqual(
    harness.pageBridgeCalls.map(call => call.params),
    [
      { path: 'camera_ready.tex', line: 169, selectLine: true },
      { path: 'camera_ready.tex', line: 225, selectLine: true },
      { path: 'camera_ready.tex', line: 248, selectLine: true },
      { path: 'camera_ready.tex', line: 252, selectLine: true }
    ]
  );
});

test('markdown renderer sanitizes local path labels while preserving HTTPS links', () => {
  const rawLocalPath = '/Users/alice/.codex-overleaf/projects/p/workspace/main.tex:42';
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }]);
  const target = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(target, `[${rawLocalPath}](https://example.test/review)`);

  const anchors = collectElements(target, node => node.tagName === 'A');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, 'https://example.test/review');
  assert.equal(anchors[0].textContent.includes('/Users/alice'), false);
  assert.equal(collectElementText(target).includes('/Users/alice'), false);
  assert.equal(findLineReferenceButtons(target).length, 0);
});

test('markdown renderer turns target-only local markdown line refs into safe jump buttons', async () => {
  const rawLocalTarget = '/Users/alice/.codex-overleaf/projects/p/workspace/main.tex:117';
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }]);
  const target = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(target, `[main.tex](${rawLocalTarget})`);

  const buttons = findLineReferenceButtons(target);
  const anchors = collectElements(target, node => node.tagName === 'A');
  assert.equal(anchors.length, 0);
  assert.deepEqual(buttons.map(button => button.textContent), ['main.tex:117']);
  assert.equal(collectElementText(target).includes('/Users/alice'), false);
  assert.equal(buttons[0].title.includes('/Users/alice'), false);

  await buttons[0].click();

  assert.deepEqual(harness.pageBridgeCalls[0], {
    method: 'jumpToPosition',
    params: { path: 'main.tex', line: 117, selectLine: true }
  });
});

test('unresolved local markdown targets render sanitized label-only text', () => {
  const rawLocalTarget = '/Users/alice/.codex-overleaf/projects/p/workspace/missing.tex:117';
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }]);
  const target = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(target, `[main.tex](${rawLocalTarget})`);

  assert.equal(findLineReferenceButtons(target).length, 0);
  assert.equal(collectElements(target, node => node.tagName === 'A').length, 0);
  assert.equal(collectElementText(target), 'main.tex');
  assert.equal(collectElementText(target).includes('/Users/alice'), false);
  assert.equal(collectElementText(target).includes('workspace'), false);
  assert.equal(collectElementText(target).includes('missing.tex:117'), false);
});

test('http markdown links never expose unsafe local target text as their label', () => {
  const rawLocalTarget = '/Users/alice/.codex-overleaf/projects/p/workspace/main.tex:117';
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }]);
  const target = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(target, `[review](https://example.test/review?file=${encodeURIComponent(rawLocalTarget)})`);

  const anchors = collectElements(target, node => node.tagName === 'A');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].textContent, 'review');
  assert.equal(anchors[0].textContent.includes('/Users/alice'), false);
  assert.equal(anchors[0].textContent.includes('workspace'), false);
  assert.equal(anchors[0].href.includes('/Users/alice'), false);
  assert.equal(anchors[0].href, 'https://example.test/review');
});

test('line-reference buttons show pending state and failure feedback without leaking local paths', async () => {
  const rawLocalFailure = '/Users/alice/.codex-overleaf/projects/p/workspace/main.tex:117';
  let resolveJump;
  const pending = new Promise(resolve => {
    resolveJump = resolve;
  });
  const harness = loadMarkdownRendererHarness([{ path: 'main.tex', kind: 'text' }], {
    callPageBridge() {
      return pending;
    }
  });
  const target = createMinimalDocument().createElement('div');

  harness.renderMarkdownInlineText(target, 'main.tex:117');
  const button = findLineReferenceButtons(target)[0];
  const clickPromise = button.click();

  assert.equal(button.disabled, true);
  assert.equal(button.dataset.status, 'pending');

  resolveJump({ ok: false, error: `Could not open ${rawLocalFailure}` });
  await clickPromise;

  assert.equal(button.disabled, false);
  assert.equal(button.dataset.status, 'failed');
  assert.equal(button.title.includes('/Users/alice'), false);
  assert.equal(JSON.stringify(harness.toasts).includes('/Users/alice'), false);
});

test('run view captures safe project file inventory for final report line references beyond focus files', () => {
  const contentScript = getContentScriptSource();

  assert.match(contentScript, /function captureProjectReferenceFiles\(/);
  assert.match(contentScript, /currentRunView\.projectFiles = captureProjectReferenceFiles\(project\)/);
  assert.match(contentScript, /projectFiles:\s*captureProjectReferenceFiles\(arguments\[0\]\?\.project\)/);
});

test('session row controls do not interpolate translated strings through innerHTML', () => {
  const sessionPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/sessionPanel.js'),
    'utf8'
  );
  const renderBody = sessionPanel.match(/function renderSessionRow\(instance, session\) \{[\s\S]*?\n  function beginRename/)?.[0] || '';

  assert.doesNotMatch(renderBody, /innerHTML\s*=/);
  assert.match(renderBody, /createElement\('button'\)/);
  assert.match(renderBody, /setAttribute\('aria-label', t\(instance, 'renameSession'\)\)/);
});

test('user-facing task failures do not render raw stack traces', () => {
  const contentScript = getContentScriptSource();
  const runTaskBody = contentScript.match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function persistRunResult/)?.[0] || '';

  assert.doesNotMatch(runTaskBody, /stack:\s*error\.stack/);
  assert.doesNotMatch(runTaskBody, /stack:\s*persistenceError\.stack/);
});

test('selectPrimaryFailure honors severity then stage tie-breaker (native blocked beats navigation blocked)', () => {
  const { selectPrimaryFailure } = require('../extension/src/shared/failureReasons');
  const failures = [
    { code: 'a', stage: 'codex', severity: 'warning', userMessage: 'm', retryable: false },
    { code: 'b', stage: 'navigation', severity: 'blocked', userMessage: 'm', retryable: false },
    { code: 'c', stage: 'native', severity: 'blocked', userMessage: 'm', retryable: false }
  ];
  const primary = selectPrimaryFailure(failures);
  assert.equal(primary.code, 'c', 'native blocked beats navigation blocked by tie-breaker');
});

test('selectPrimaryFailure: navigation blocked beats preflight blocked', () => {
  const { selectPrimaryFailure } = require('../extension/src/shared/failureReasons');
  const failures = [
    { code: 'p', stage: 'preflight', severity: 'blocked', userMessage: 'm', retryable: false },
    { code: 'n', stage: 'navigation', severity: 'blocked', userMessage: 'm', retryable: false }
  ];
  assert.equal(selectPrimaryFailure(failures).code, 'n');
});

test('selectPrimaryFailure: navigation blocked beats navigation error', () => {
  const { selectPrimaryFailure } = require('../extension/src/shared/failureReasons');
  const failures = [
    { code: 'navE', stage: 'navigation', severity: 'error', userMessage: 'm', retryable: false },
    { code: 'navB', stage: 'navigation', severity: 'blocked', userMessage: 'm', retryable: false }
  ];
  assert.equal(selectPrimaryFailure(failures).code, 'navB');
});

// ---------------------------------------------------------------------------
// Welcome-panel + write-guard v1.3.8 add-on (Task 4): SPA route lifecycle,
// account scope derivation, post-navigation run settlement. Source-grep +
// behavioral pattern consistent with the existing tests above. See
// docs/superpowers/specs/2026-05-24-project-list-welcome-panel-design.md
// §5.1, §5.2, §5.7.
// ---------------------------------------------------------------------------

test('isProjectEditorRoute returns true only for /project/<24-hex>(/anything)?', () => {
  const src = getContentScriptSource();
  // Pattern check: the predicate matches `/project/<id>(/anything)?` and
  // restricts the captured id to 24-hex (Overleaf ObjectId shape).
  assert.match(src, /\/\^\\\/project\\\/\(\[\^\/\?#\]\+\)\(\?:\\\/\.\*\)\?\$\//);
  assert.match(src, /\^\[a-f0-9\]\{24\}\$/);
  assert.match(src, /PROJECT_EDITOR_RESERVED_IDS/);
  // Behavioral test: extract the function body and evaluate inside a sandbox.
  const helperBody = extractFunction(src, 'extractProjectIdFromLocation');
  const body = extractFunction(src, 'isProjectEditorRoute');
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(
    "const PROJECT_EDITOR_RESERVED_IDS = new Set(['new','upload','import']);" + helperBody + body
      + ";result = {" +
        "good: isProjectEditorRoute({ pathname: '/project/' + 'a'.repeat(24) })," +
        "goodSub: isProjectEditorRoute({ pathname: '/project/' + 'b'.repeat(24) + '/detacher' })," +
        "tooShort: isProjectEditorRoute({ pathname: '/project/abc' })," +
        "uppercase: isProjectEditorRoute({ pathname: '/project/' + 'A'.repeat(24) })," +
        "reservedNew: isProjectEditorRoute({ pathname: '/project/new' })," +
        "reservedUpload: isProjectEditorRoute({ pathname: '/project/upload' })," +
        "reservedImport: isProjectEditorRoute({ pathname: '/project/import' })," +
        "projectHome: isProjectEditorRoute({ pathname: '/project' })," +
        "root: isProjectEditorRoute({ pathname: '/' })," +
        "missing: isProjectEditorRoute(null)" +
      "};",
    sandbox
  );
  assert.equal(sandbox.result.good, true, '24-hex id should match');
  assert.equal(sandbox.result.goodSub, true, '24-hex id with sub-path should match');
  assert.equal(sandbox.result.tooShort, false, 'short id should not match');
  assert.equal(sandbox.result.uppercase, false, 'uppercase hex should not match');
  assert.equal(sandbox.result.reservedNew, false, 'reserved /project/new should not match');
  assert.equal(sandbox.result.reservedUpload, false, 'reserved /project/upload should not match');
  assert.equal(sandbox.result.reservedImport, false, 'reserved /project/import should not match');
  assert.equal(sandbox.result.projectHome, false, '/project dashboard should not match');
  assert.equal(sandbox.result.root, false, 'root url should not match');
  assert.equal(sandbox.result.missing, false, 'null url should not match');
});

test('deriveAccountScopeId returns null when no stable identifier is observable (fail-closed, no display-name fallback)', () => {
  // Spec §5.2: stable identifiers only. Display name is NEVER a fallback —
  // display names are not unique and would silently leak across accounts.
  const src = getContentScriptSource();
  assert.match(src, /deriveAccountScopeId/);
  assert.match(src, /display name is not a fallback|display name is never used as a fallback/i);
  // The selector chain probes meta + data attributes; the fallback branch
  // returns null without ever consulting a display-name selector.
  assert.match(src, /ol-user-email|user-email/);
  assert.match(src, /data-user-email|data-account-email/);
  assert.match(src, /cachedAccountScopeId/);
  assert.match(src, /codexOverleafDeriveAccountScopeId/);
});

test('leaveActiveProject cancels pending writebacks, pauses observers, and resets activeProjectId on non-project navigation', () => {
  const src = getContentScriptSource();
  assert.match(src, /function leaveActiveProject/);
  // The function reassigns activeProjectId; the non-project navigation path
  // hands in `null`, so the source must contain that exact branch.
  assert.match(src, /activeProjectId\s*=\s*newId|activeProjectId\s*=\s*null/);
  assert.match(src, /cancelPendingWritebacks/);
  assert.match(src, /pauseProjectObservers/);
  assert.match(src, /disableComposer/);
});

test('enterProject re-binds observers and reloads project run history', () => {
  const src = getContentScriptSource();
  assert.match(src, /function enterProject/);
  assert.match(src, /bindProjectObservers/);
  assert.match(src, /reloadProjectRunHistory/);
  assert.match(src, /enableComposer/);
});

test('settleRunAfterNavigation picks background_completed / needs_review_after_navigation / abandoned_after_navigation per spec §5.7.1', () => {
  const src = getContentScriptSource();
  assert.match(src, /function settleRunAfterNavigation/);
  assert.match(src, /background_completed/);
  assert.match(src, /needs_review_after_navigation/);
  assert.match(src, /abandoned_after_navigation/);
  // The settlement compares against run.runProjectId (the immutable captured
  // id from T2), NOT activeProjectId. This is the entire point of the
  // T2 immutability contract.
  assert.match(src, /run\.runProjectId/);
  // Behavioral test: extract the function and exercise the three branches.
  // Fix B: settleRunAfterNavigation now calls collectRunResultSkipped to
  // accept both the full syncOutcome (with `applied.skipped`) AND the
  // pre-flattened `{ skipped: [...] }` shape; include the helper so the
  // legacy assertions still work against the new implementation.
  const body = extractFunction(src, 'settleRunAfterNavigation');
  const collectBody = extractFunction(src, 'collectRunResultSkipped');
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(
    "let activeProjectId = 'OTHER';" + collectBody + ";" + body + ";"
      + "result = {"
      + "sameProject: (function(){ activeProjectId = 'SAME'; return settleRunAfterNavigation({ runProjectId: 'SAME' }, { skipped: [] }); })(),"
      + "guard: (function(){ activeProjectId = 'X'; return settleRunAfterNavigation({ runProjectId: 'Y' }, { skipped: [ { result: { code: 'aborted_project_changed' } } ] }); })(),"
      + "guardEditor: (function(){ activeProjectId = 'X'; return settleRunAfterNavigation({ runProjectId: 'Y' }, { skipped: [ { result: { code: 'editor_project_id_unavailable' } } ] }); })(),"
      + "needsReviewTracked: (function(){ activeProjectId = 'X'; return settleRunAfterNavigation({ runProjectId: 'Y' }, { skipped: [ { result: { code: 'tracked_changes_remain' } } ] }); })(),"
      + "needsReviewAccept: (function(){ activeProjectId = 'X'; return settleRunAfterNavigation({ runProjectId: 'Y' }, { skipped: [ { result: { code: 'accept_not_verified' } } ] }); })(),"
      + "needsReviewUndo: (function(){ activeProjectId = 'X'; return settleRunAfterNavigation({ runProjectId: 'Y' }, { skipped: [ { result: { code: 'undo_not_verified' } } ] }); })(),"
      + "needsReviewMismatch: (function(){ activeProjectId = 'X'; return settleRunAfterNavigation({ runProjectId: 'Y' }, { skipped: [ { result: { code: 'write_observed_mismatch' } } ] }); })(),"
      + "background: (function(){ activeProjectId = 'X'; return settleRunAfterNavigation({ runProjectId: 'Y' }, { skipped: [] }); })()"
      + "};",
    sandbox
  );
  assert.equal(sandbox.result.sameProject, null, 'same project returns null (normal settlement path)');
  assert.equal(sandbox.result.guard, 'abandoned_after_navigation', 'aborted_project_changed classifies as abandoned');
  assert.equal(sandbox.result.guardEditor, 'abandoned_after_navigation', 'editor_project_id_unavailable classifies as abandoned');
  assert.equal(sandbox.result.needsReviewTracked, 'needs_review_after_navigation', 'tracked_changes_remain classifies as needs_review');
  assert.equal(sandbox.result.needsReviewAccept, 'needs_review_after_navigation', 'accept_not_verified classifies as needs_review');
  assert.equal(sandbox.result.needsReviewUndo, 'needs_review_after_navigation', 'undo_not_verified classifies as needs_review');
  assert.equal(sandbox.result.needsReviewMismatch, 'needs_review_after_navigation', 'write_observed_mismatch classifies as needs_review');
  assert.equal(sandbox.result.background, 'background_completed', 'clean run after navigation classifies as background_completed');
});

// ---------------------------------------------------------------------------
// Welcome-panel + write-guard v1.3.8 add-on (Task 5): Recent-projects variant
// UI — markup, row rendering, click validation, badge mapping (10 statuses),
// settings/diagnostics scope gating, bilingual strings, CSS palette tokens.
// Source-grep + behavioral pattern consistent with T4 above. See
// docs/superpowers/specs/2026-05-24-project-list-welcome-panel-design.md
// §5.3, §5.4, §5.5, §5.8, §5.9, §5.10.
// ---------------------------------------------------------------------------

test('Recent-projects variant renders a welcome header, list container, and settings entry', () => {
  const src = getContentScriptSource();
  // Variant renderer plus its required data attributes for empty / degraded /
  // populated states (spec §5.3, §5.5). Tests downstream rely on these hooks.
  assert.match(src, /function renderRecentProjectsVariant/);
  assert.match(src, /renderRecentProjectRow/);
  assert.match(src, /renderWelcomeHeader/);
  assert.match(src, /renderEmptyState/);
  assert.match(src, /renderDegradedState/);
  assert.match(src, /renderSettingsEntry/);
  assert.match(src, /data-recent-projects-row/);
  assert.match(src, /data-recent-projects-list/);
  assert.match(src, /data-recent-projects-empty/);
  assert.match(src, /data-recent-projects-degraded/);
  // The variant pulls rows from the T3 cross-project query.
  assert.match(src, /listRecentProjectsAcrossAccount/);
  // Opportunistic enrichment runs as best-effort and must not block render.
  assert.match(src, /opportunisticEnrichmentFromDom/);
});

test('Recent-projects row click validates project id and URL-encodes the navigation target', () => {
  const src = getContentScriptSource();
  assert.match(src, /function isValidProjectId/);
  assert.match(src, /function openProjectFromRow/);
  assert.match(src, /encodeURIComponent/);
  // Disabled-row affordance: invalid ids surface a "Project link unavailable"
  // warning sourced via tr(...) in the renderer (spec §5.8). The English
  // i18n key carries the canonical copy; the renderer references it by key.
  assert.match(src, /recentProjects_row_projectLinkUnavailable/);
  // Behavioral: isValidProjectId enforces the 24-hex shape + reserved-set guard.
  const body = extractFunction(src, 'isValidProjectId');
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(
    "const PROJECT_EDITOR_RESERVED_IDS = new Set(['new','upload','import']);" + body
      + ";result = {" +
        "good: isValidProjectId('a'.repeat(24))," +
        "upper: isValidProjectId('A'.repeat(24))," +
        "short: isValidProjectId('abc')," +
        "reserved: isValidProjectId('new')," +
        "nonString: isValidProjectId(null)," +
        "empty: isValidProjectId('')" +
      "};",
    sandbox
  );
  assert.equal(sandbox.result.good, true, '24-hex lowercase id is valid');
  assert.equal(sandbox.result.upper, false, 'uppercase hex is rejected');
  assert.equal(sandbox.result.short, false, 'short id is rejected');
  assert.equal(sandbox.result.reserved, false, 'reserved /project/new id is rejected');
  assert.equal(sandbox.result.nonString, false, 'null id is rejected');
  assert.equal(sandbox.result.empty, false, 'empty string id is rejected');
});

test('Recent-projects status badge renderer covers all 10 spec status values per §5.10', () => {
  const src = getContentScriptSource();
  assert.match(src, /function renderStatusBadge/);
  assert.match(src, /STATUS_BADGE_CLASS/);
  // All ten status values from spec §5.10 must appear in the badge map so
  // no row ever renders an unstyled / missing badge (acceptance criterion 6).
  for (const status of [
    'pending', 'accepted', 'rejected', 'needs_review',
    'running', 'completed', 'failed',
    'background_completed', 'needs_review_after_navigation', 'abandoned_after_navigation'
  ]) {
    assert.ok(src.indexOf(status) !== -1, 'badge map must reference ' + status);
  }
  // Behavioral: badge map maps each status to its CSS class. Extract the
  // table object literal and confirm 10 keys (the renderer falls back to
  // the pending class for unknown values).
  const tableMatch = src.match(/const STATUS_BADGE_CLASS = \{([\s\S]*?)\n  \};/);
  assert.ok(tableMatch, 'STATUS_BADGE_CLASS literal should exist');
  const body = tableMatch[1];
  for (const status of [
    'pending', 'accepted', 'rejected', 'needs_review',
    'running', 'completed', 'failed',
    'background_completed', 'needs_review_after_navigation', 'abandoned_after_navigation'
  ]) {
    assert.ok(body.indexOf(status + ':') !== -1, 'STATUS_BADGE_CLASS must define ' + status);
  }
});

test('Recent-projects settings/diagnostics scope gates project-only sections when activeProjectId is null', () => {
  const src = getContentScriptSource();
  // The variant settings entry opens settings in account scope (spec §5.9).
  assert.match(src, /scope:\s*['"]account['"]/);
  // The settings open path must gate the project-scoped sections on a
  // non-null activeProjectId. The implementer uses a data attribute on the
  // settings panel root so CSS / template can hide project-scoped scope
  // blocks when no project is active.
  assert.match(src, /data-settings-scope|settings-scope-account|activeProjectId\s*!==?\s*null|activeProjectId\s*===?\s*null/);
});

test('Recent-projects bilingual strings: en + zh both define welcome / empty / degraded / badge keys', () => {
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'shared', 'i18n.js'), 'utf8');
  const keys = [
    'recentProjects_welcome',
    'recentProjects_welcome_subtitle',
    'recentProjects_empty',
    'recentProjects_degraded',
    'recentProjects_row_projectLinkUnavailable',
    'recentProjects_badge_pending',
    'recentProjects_badge_accepted',
    'recentProjects_badge_rejected',
    'recentProjects_badge_needs_review',
    'recentProjects_badge_running',
    'recentProjects_badge_completed',
    'recentProjects_badge_failed',
    'recentProjects_badge_background_completed',
    'recentProjects_badge_needs_review_after_navigation',
    'recentProjects_badge_abandoned_after_navigation'
  ];
  // Each key must appear at least twice — once in the en block and once in
  // the zh block. We assert occurrence count >= 2 to confirm parity without
  // brittle line-position checks.
  for (const key of keys) {
    const occurrences = i18n.split(key + ':').length - 1;
    assert.ok(occurrences >= 2, key + ' should appear in both en and zh blocks (saw ' + occurrences + ')');
  }
});

test('Recent-projects CSS variant + badge styles reuse panel palette tokens for all 10 statuses', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'extension', 'styles', 'panel.css'), 'utf8');
  // Variant container + row + disabled-row styles per spec §5.3 / §5.4 / §5.8.
  assert.match(css, /\[data-recent-projects-list\]/);
  assert.match(css, /\[data-recent-projects-row\]/);
  // All ten badge variants — class naming mirrors the JS STATUS_BADGE_CLASS
  // map. The renderer adds these classes onto the row badge span.
  for (const cls of [
    'badge-pending', 'badge-accepted', 'badge-rejected', 'badge-needs-review',
    'badge-running', 'badge-completed', 'badge-failed',
    'badge-background-completed', 'badge-needs-review-after-navigation',
    'badge-abandoned-after-navigation'
  ]) {
    assert.ok(css.indexOf(cls) !== -1, 'panel.css must style .' + cls);
  }
});

// ---------------------------------------------------------------------------
// Welcome-panel + write-guard v1.3.8 add-on FX1 (Fix A / spec §5.7.1):
// post-navigation `saveState` gate. The URL-derived projectId in `saveState`
// belongs to the route the user is currently looking at; when a run is in
// flight on a DIFFERENT project (mid-run SPA navigation), routing the
// completion through `saveStateSoon` -> `saveState` would persist the
// original project's in-memory sessions under the WRONG projectId key.
// ---------------------------------------------------------------------------

test('Fix A: finishRunView gates saveStateSoon on navigation divergence (currentRunView.runProjectId !== activeProjectId)', () => {
  const src = getContentScriptSource();
  const body = extractFunction(src, 'finishRunView');
  // The body must read activeProjectId / runProjectId divergence and skip
  // saveStateSoon on the divergent branch. The exact identifier names are
  // load-bearing because tests downstream search for them.
  assert.match(body, /navigationDivergent/);
  assert.match(body, /activeProjectId !== currentRunView\.runProjectId/);
  // The saveStateSoon call inside finishRunView must be gated, not bare.
  // Look for the if (!navigationDivergent) shape.
  assert.match(body, /if\s*\(\s*!\s*navigationDivergent\s*\)\s*\{\s*\n[\s\S]*?saveStateSoon\(\)/);
});

test('Fix A: finishRunView still calls saveStateSoon on the happy path (no navigation, currentRunView aligned)', () => {
  // Behavioral check via extracted function + a minimal driver harness. The
  // harness simulates the finishRunView body's prerequisites and asserts the
  // saveStateSoon counter ticks when navigationDivergent is false.
  const src = getContentScriptSource();
  const body = extractFunction(src, 'finishRunView');
  const sandbox = {
    result: { divergent: null, aligned: null },
    saveCount: 0
  };
  vm.createContext(sandbox);
  vm.runInContext(
    "let activeProjectId = 'P_aligned';"
    + "let currentRunView = { recordId: 'r1', sessionId: 's1', runProjectId: 'P_aligned', startedAt: 0 };"
    + "const state = { sessions: [{ id: 's1', runs: [{ id: 'r1', status: 'running' }] }] };"
    + "function sanitizeAssistantVisibleText(x){ return x; }"
    + "function findRunRecord(){ return state.sessions[0].runs[0]; }"
    + "function flushPendingStreamRenders(){}"
    + "function formatProcessedSummary(){ return ''; }"
    + "function saveStateSoon(){ saveCount++; }"
    + "function renderSessionList(){}"
    + "function getCurrentRunViewForRender(){ return null; }"
    + "function stopRunElapsedTick(){}"
    + body
    + ";"
    + "saveCount = 0; finishRunView('done', 'completed'); result.aligned = saveCount;"
    + "activeProjectId = 'P_other'; currentRunView = { recordId: 'r2', sessionId: 's2', runProjectId: 'P_original', startedAt: 0 };"
    + "state.sessions.push({ id: 's2', runs: [{ id: 'r2', status: 'running' }] });"
    + "saveCount = 0; finishRunView('done', 'completed'); result.divergent = saveCount;",
    sandbox
  );
  assert.equal(sandbox.result.aligned, 1, 'happy path: saveStateSoon is called when runProjectId === activeProjectId');
  assert.equal(sandbox.result.divergent, 0, 'navigation-divergent: saveStateSoon is NOT called (settlement owns persistence)');
});

test('Fix A: saveState honors options.projectIdOverride instead of getCurrentProjectId()', () => {
  const src = getContentScriptSource();
  const body = extractFunction(src, 'saveState');
  // Defense-in-depth surface: a `projectIdOverride` option is accepted and,
  // when set, used in place of getCurrentProjectId(). When the override is
  // absent AND a navigation-divergent run is in flight, saveState skips
  // (warns + returns) rather than persist to the wrong projectId.
  assert.match(body, /projectIdOverride/);
  assert.match(body, /options\s*&&\s*typeof\s+options\.projectIdOverride\s*===\s*['"]string['"]/);
  assert.match(body, /projectIdOverride\s*\|\|\s*urlProjectId/);
  assert.match(body, /if\s*\(!projectId\)\s*\{\s*return;\s*\}/);
  // The navigation-divergent skip path must log and return early. The
  // accessor reads the live currentRunView through a defensive helper
  // (readLiveRunViewForSaveStateGuard) so test harnesses that inline
  // `saveState` without re-declaring `currentRunView` still work.
  assert.match(body, /readLiveRunViewForSaveStateGuard\(\)/);
  assert.match(body, /liveRunView\.runProjectId\s*!==\s*urlProjectId/);
  assert.match(body, /appendPlainLog\(/);
  assert.match(body, /return;/);
});

test('Fix A: saveState skips persistence when run is navigation-divergent and no override is set', () => {
  // Behavioral: drive the override + divergent branches by inlining the body.
  // The harness records which projectId the StorageDb wrapper sees so we can
  // assert (a) the override wins, (b) absence + divergence triggers an early
  // return with NO writes to StorageDb.
  const src = getContentScriptSource();
  const body = extractFunction(src, 'saveState');
  const guardAccessor = extractFunction(src, 'readLiveRunViewForSaveStateGuard');
  const sandbox = {
    result: { withOverride: null, divergent: null, happy: null },
    storageWrites: []
  };
  vm.createContext(sandbox);
  // Patched async runner: drive a stub StorageDb / Migration with a tiny
  // surface so the body completes without exploding. We only care about
  // (a) which projectId is computed and (b) whether the early-return fired.
  vm.runInContext(
    "const window = {"
    + "  CodexOverleafStorageDb: {"
    + "    extractLightweightPrefs: (s, pid) => ({ _pid: pid }),"
    + "    buildActiveSessionByProject: () => ({}),"
    + "    buildSessionRecord: rec => rec,"
    + "    putRecords: (store, rec) => { storageWrites.push({ store, pid: rec[0] && rec[0].projectId }); return Promise.resolve(); },"
    + "    getAllByIndex: () => Promise.resolve([]),"
    + "    deleteRecord: () => Promise.resolve()"
    + "  },"
    + "  CodexOverleafStorageMigration: {"
    + "    loadPrefs: () => Promise.resolve({}),"
    + "    savePrefs: () => Promise.resolve()"
    + "  },"
    + "  location: { pathname: '/project/' + 'a'.repeat(24), href: 'http://x/project/' + 'a'.repeat(24) }"
    + "};"
    + "let currentRunView = null;"
    + "const state = { sessions: [{ id: 's1', task: 't' }], autoRecompile: true, loadCodexLocalSkills: true, loadCodexOverleafSkills: true, experimentalOtByProject: {}, customInstructionsByProject: {}, governanceRulesByProject: {}, activeSessionId: 's1' };"
    + "function prepareStateForStorage(s){ return { ...s, sessions: s.sessions }; }"
    + "function normalizeExperimentalOtByProject(v){ return v || {}; }"
    + "function normalizeGovernanceRulesByProject(v){ return v || {}; }"
    + "function normalizeCustomInstructionsByProject(v){ return v || {}; }"
    + "function getCodexOverleafSkillEnabled(){ return {}; }"
    + "function isStorageQuotaError(){ return false; }"
    + "function appendStorageNoticeOnce(){}"
    + "function notifyAggressiveCompactionOnce(){}"
    + "function appendPlainLog(){ window.__skipLogged = true; }"
    + "function tx(en, _zh){ return en; }"
    + "function getCurrentProjectId(){ return window.__projectId || ''; }"
    + "let chrome = { storage: { local: { set: () => Promise.resolve() } } };"
    + guardAccessor + ";"
    + body
    + ";"
    + "(async () => {"
    + "  window.__projectId = 'a'.repeat(24);"
    + "  storageWrites = []; window.__skipLogged = false;"
    + "  await saveState({ projectIdOverride: 'b'.repeat(24) });"
    + "  result.withOverride = storageWrites.map(w => w.pid);"
    + "  storageWrites = []; window.__skipLogged = false;"
    + "  currentRunView = { runProjectId: 'c'.repeat(24) };"
    + "  await saveState();"
    + "  result.divergent = { writes: storageWrites.length, logged: window.__skipLogged === true };"
    + "  storageWrites = []; window.__skipLogged = false;"
    + "  currentRunView = { runProjectId: 'a'.repeat(24) };"
    + "  await saveState();"
    + "  result.happy = storageWrites.map(w => w.pid);"
    + "  storageWrites = []; window.__skipLogged = false; currentRunView = null; window.__projectId = '';"
    + "  await saveState();"
    + "  result.noProject = { writes: storageWrites.length, logged: window.__skipLogged === true };"
    + "})().then(() => { result.done = true; });",
    sandbox
  );
  // Wait for the inlined async chain to settle. The promise above is
  // microtask-resolved, but vm.runInContext returns synchronously, so we
  // poll the done flag through a setTimeout.
  return new Promise(resolve => setTimeout(() => {
    assert.equal(sandbox.result.done, true, 'inline saveState driver completed');
    // The sandbox arrays/objects have a different prototype chain than the
    // outer test process (vm.createContext gives them the context's own
    // Array.prototype), so strict deepEqual rejects them even though the
    // values match. Compare via JSON to sidestep that.
    assert.equal(JSON.stringify(sandbox.result.withOverride), JSON.stringify(['b'.repeat(24)]),
      'override wins over URL projectId');
    assert.equal(JSON.stringify(sandbox.result.divergent), JSON.stringify({ writes: 0, logged: true }),
      'navigation-divergent saveState skips writes and emits a warning log');
    assert.equal(JSON.stringify(sandbox.result.happy), JSON.stringify(['a'.repeat(24)]),
      'happy path uses URL projectId (no override, no divergence)');
    assert.equal(JSON.stringify(sandbox.result.noProject), JSON.stringify({ writes: 0, logged: false }),
      'non-project routes do not persist dashboard sessions');
    resolve();
  }, 40));
});

// ---------------------------------------------------------------------------
// Welcome-panel + write-guard v1.3.8 add-on FX1 (Fix B / spec §5.7.1):
// `settleRunAfterNavigation` accepts the full `syncOutcome` (not just a
// pre-flattened skipped list). Skip codes outside the recognized list
// (delete_confirmation_rejected, governance_blocked,
// binary_confirmation_rejected, ...) and early-return branches with
// hasSkippedOperations=true but no `applied` must now classify as
// `needs_review_after_navigation`, not `background_completed`.
// ---------------------------------------------------------------------------

test('Fix B: settleRunAfterNavigation classifies hasSkippedOperations=true (no applied) as needs_review_after_navigation', () => {
  const src = getContentScriptSource();
  const settleBody = extractFunction(src, 'settleRunAfterNavigation');
  const collectBody = extractFunction(src, 'collectRunResultSkipped');
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(
    "let activeProjectId = 'X';"
    + collectBody + ";" + settleBody + ";"
    + "result = {"
    // Early-return branch: outcome has hasSkippedOperations=true but no
    // `applied` field at all (matches the §3534 / §3613 / §3678 branches of
    // applySyncChangesToOverleaf).
    + "  earlyReturn: settleRunAfterNavigation({ runProjectId: 'Y' }, { hasSkippedOperations: true }),"
    // Skip codes outside the previous allow-list — all three from the user's
    // example list. These previously fell through to background_completed.
    + "  deleteConfirmRejected: settleRunAfterNavigation({ runProjectId: 'Y' }, {"
    + "    applied: { skipped: [ { result: { code: 'delete_confirmation_rejected' } } ] }"
    + "  }),"
    + "  governanceBlocked: settleRunAfterNavigation({ runProjectId: 'Y' }, {"
    + "    applied: { skipped: [ { result: { code: 'governance_blocked' } } ] }"
    + "  }),"
    + "  binaryConfirmRejected: settleRunAfterNavigation({ runProjectId: 'Y' }, {"
    + "    applied: { skipped: [ { result: { code: 'binary_confirmation_rejected' } } ] }"
    + "  })"
    + "};",
    sandbox
  );
  assert.equal(sandbox.result.earlyReturn, 'needs_review_after_navigation',
    'hasSkippedOperations=true (no applied) classifies as needs_review_after_navigation, not background_completed');
  assert.equal(sandbox.result.deleteConfirmRejected, 'needs_review_after_navigation',
    'delete_confirmation_rejected classifies as needs_review_after_navigation');
  assert.equal(sandbox.result.governanceBlocked, 'needs_review_after_navigation',
    'governance_blocked classifies as needs_review_after_navigation');
  assert.equal(sandbox.result.binaryConfirmRejected, 'needs_review_after_navigation',
    'binary_confirmation_rejected classifies as needs_review_after_navigation');
});

test('Fix B: settleRunAfterNavigation still classifies guard codes as abandoned and clean outcomes as background_completed', () => {
  const src = getContentScriptSource();
  const settleBody = extractFunction(src, 'settleRunAfterNavigation');
  const collectBody = extractFunction(src, 'collectRunResultSkipped');
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(
    "let activeProjectId = 'X';"
    + collectBody + ";" + settleBody + ";"
    + "result = {"
    // Guard codes — abandoned remains the strongest signal.
    + "  guardAborted: settleRunAfterNavigation({ runProjectId: 'Y' }, {"
    + "    applied: { skipped: [ { result: { code: 'aborted_project_changed' } } ] },"
    + "    hasSkippedOperations: true"
    + "  }),"
    + "  guardEditor: settleRunAfterNavigation({ runProjectId: 'Y' }, {"
    + "    applied: { skipped: [ { result: { code: 'editor_project_id_unavailable' } } ] },"
    + "    hasSkippedOperations: true"
    + "  }),"
    // Clean run — no skipped, no hasSkippedOperations, but at least one
    // applied entry. Classifies as background_completed per rule 3.
    + "  clean: settleRunAfterNavigation({ runProjectId: 'Y' }, {"
    + "    applied: { ok: true, applied: [ { path: 'main.tex' } ], skipped: [] },"
    + "    hasSkippedOperations: false"
    + "  }),"
    // True no-op (e.g. Ask mode) — empty syncOutcome shape. Rule 4: still
    // background_completed.
    + "  noop: settleRunAfterNavigation({ runProjectId: 'Y' }, {"
    + "    hasSkippedOperations: false"
    + "  })"
    + "};",
    sandbox
  );
  assert.equal(sandbox.result.guardAborted, 'abandoned_after_navigation');
  assert.equal(sandbox.result.guardEditor, 'abandoned_after_navigation');
  assert.equal(sandbox.result.clean, 'background_completed');
  assert.equal(sandbox.result.noop, 'background_completed');
});

test('Fix B: runCodexTask passes the full syncOutcome to settleRunAfterNavigation (not a pre-flattened skipped list)', () => {
  const src = getContentScriptSource();
  // The call site must pass `syncOutcome` directly, not `{ skipped:
  // collectRunResultSkipped(syncOutcome) }`. That's the entire point of
  // Fix B — settleRunAfterNavigation sees `hasSkippedOperations` and the
  // raw `applied` so it can catch unrecognized skip codes and early-return
  // branches.
  assert.match(src, /settleRunAfterNavigation\(finishedRunRecord,\s*syncOutcome\)/);
  // Defense-in-depth: the old `{ skipped: collectRunResultSkipped(syncOutcome) }`
  // shape must NOT remain at the call site. (collectRunResultSkipped itself
  // stays — it's still useful for the applied-array shape and legacy tests.)
  assert.ok(!/settleRunAfterNavigation\([^,]+,\s*\{\s*skipped:\s*collectRunResultSkipped/.test(src),
    'old pre-flattened call shape must be removed');
});

// ---------------------------------------------------------------------------
// Settings back-button must respect the current route variant.
// Bug: clicking Settings from the Recent-projects variant (/project URL) and
// then clicking Back rendered the per-project session view, which is empty /
// meaningless when no project is active. closeCustomInstructionsSettings must
// branch on isProjectEditorRoute and re-render Recent projects when off-route.
// ---------------------------------------------------------------------------

test('closeCustomInstructionsSettings branches on isProjectEditorRoute (does not unconditionally setView session)', () => {
  const src = getContentScriptSource();
  const body = extractFunction(src, 'closeCustomInstructionsSettings');
  assert.match(body, /isProjectEditorRoute/, 'back handler must check the route');
  assert.match(body, /renderRecentProjectsVariant/, 'back handler must re-render Recent projects on non-project URLs');
  // The session-view dispatch must only happen on the project-editor branch
  // (i.e. inside the `if (isProjectEditorRoute(...))` block — same line ordering).
  const sessionIndex = body.indexOf("setView?.('session')");
  const routeCheckIndex = body.indexOf('isProjectEditorRoute');
  assert.ok(routeCheckIndex !== -1 && sessionIndex !== -1, 'both calls must be present');
  assert.ok(routeCheckIndex < sessionIndex, 'session view dispatch must be guarded by the route check');
});

// ---------------------------------------------------------------------------
// Completion-report rendering: the conclusion (Codex's human answer) and the
// system-meta fields (Why nothing changed / Write result / Undo / Next) must
// be visually distinguishable. The renderer takes a structured payload and
// emits a dedicated meta block beneath the conclusion; CSS demotes it with a
// separator + muted color. Legacy (string-detail) events still render via
// the fallback path so persisted reports keep working after reload.
// ---------------------------------------------------------------------------

test('renderCompletionReport branches on detailStructured and emits a meta block', () => {
  const src = getContentScriptSource();
  const body = extractFunction(src, 'renderCompletionReport');
  assert.match(body, /detailStructured/, 'renderer must read the structured payload off the event');
  assert.match(body, /appendCompletionMetaBlock/, 'renderer must delegate to the shared meta-block appender');
  // Legacy fallback (string detail) must still be reachable; the old class
  // and markdown-text path must be preserved for persisted / recovered events.
  assert.match(body, /'run-final-answer'/, 'legacy fallback path must remain');
  assert.match(body, /formatEventDetail/, 'legacy fallback must still call formatEventDetail');
  // Full-coverage fix: the flat fallback must ALSO split status sections out so
  // Write result / Undo / Next demote even when no structured payload survived.
  assert.match(body, /splitFlatCompletionReport/, 'fallback must split status sections from the flat text');

  const appender = extractFunction(src, 'appendCompletionMetaBlock');
  assert.match(appender, /run-final-answer__meta/, 'appender must emit the meta-block class');
  assert.match(appender, /run-final-answer__meta-label/, 'appender must emit the meta label class');
  assert.match(appender, /run-final-answer__meta-value/, 'appender must emit the meta value class');
});

// The flat-text fallback (events with no structured payload — persisted before
// structured reports existed, or restored from a prefs-only compact fallback)
// must still demote the trailing status sections so "Write result / Undo / Next"
// read as run metadata, not as part of Codex's answer.
test('splitFlatCompletionReport demotes status sections out of the flat answer body', () => {
  const src = getContentScriptSource();
  const constMatch = src.match(/const FLAT_REPORT_STATUS_SECTIONS = \[[\s\S]*?\];/);
  assert.ok(constMatch, 'FLAT_REPORT_STATUS_SECTIONS const must exist');
  const split = new Function(`
    const tx = (en) => en;
    ${constMatch[0]}
    ${extractFunction(src, 'splitFlatCompletionReport')}
    return splitFlatCompletionReport;
  `)();

  // The exact shape the user reported: a Changes content section followed by
  // the Write result / Undo / Next status sections, joined by blank lines.
  const flat = [
    'Changes:\nmain.tex: edit (Synced 2 local Codex workspace edits.)',
    'Write result: wrote 1 item, skipped 0 items',
    'Undo: this run has 1 reversible write',
    'Next: Review the synced file in Overleaf.'
  ].join('\n\n');

  const result = split(flat);
  // Content stays in the body…
  assert.match(result.body, /Changes:/, 'the Changes content section stays in the body');
  assert.match(result.body, /main\.tex: edit/, 'the changed-file line stays in the body');
  // …and the status lines are pulled out of the body entirely.
  assert.doesNotMatch(result.body, /Write result:/, 'Write result must not remain in the answer body');
  assert.doesNotMatch(result.body, /Undo:/, 'Undo must not remain in the answer body');
  assert.doesNotMatch(result.body, /Next:/, 'Next must not remain in the answer body');

  const keys = result.meta.map(row => row.key);
  assert.deepEqual(keys, ['writeResult', 'undo', 'nextStep'], 'status sections demote in order');
  const writeRow = result.meta.find(row => row.key === 'writeResult');
  assert.equal(writeRow.label, 'Write result', 'meta row carries the localized label');
  assert.equal(writeRow.value, 'wrote 1 item, skipped 0 items', 'meta row strips the label prefix from the value');
});

// Guard against over-eager demotion: a multi-line conclusion paragraph that
// merely contains a "Next: …" sentence must NOT be split into the meta block.
test('splitFlatCompletionReport keeps multi-line prose containing a status word in the body', () => {
  const src = getContentScriptSource();
  const constMatch = src.match(/const FLAT_REPORT_STATUS_SECTIONS = \[[\s\S]*?\];/);
  const split = new Function(`
    const tx = (en) => en;
    ${constMatch[0]}
    ${extractFunction(src, 'splitFlatCompletionReport')}
    return splitFlatCompletionReport;
  `)();

  const flat = 'Conclusion: I rewrote the intro.\nNext: I considered trimming it further.';
  const result = split(flat);
  assert.match(result.body, /Next: I considered/, 'a multi-line prose section is not demoted');
  assert.equal(result.meta.length, 0, 'no status rows extracted from prose');
});

test('appendCompletionReport forwards detailStructured from the report shaper', () => {
  const src = getContentScriptSource();
  // Same default-value brace caveat as appendRunEvent above — grep the file
  // directly instead of extracting the function body.
  assert.match(src, /detailStructured:\s*report\.structured/, 'must forward report.structured as detailStructured');
});

test('appendRunEvent preserves detailStructured through the event-shape contract', () => {
  const src = getContentScriptSource();
  // extractFunction can't grab appendRunEvent's body cleanly because its
  // signature uses a `{}` default value that fools the brace counter; the
  // structural property is unique enough that a source-level grep is fine.
  assert.match(src, /detailStructured:\s*input\.detailStructured\s*\?\s*sanitizeAssistantVisibleValue/,
    'event must include sanitized detailStructured');
});

test('panel.css ships a muted meta block style with separator', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'styles', 'panel.css'), 'utf8');
  assert.match(src, /\.run-final-answer__meta\b/, 'meta block class must exist');
  assert.match(src, /\.run-final-answer__meta-label\b/, 'meta label class must exist');
  assert.match(src, /\.run-final-answer__meta-value\b/, 'meta value class must exist');
  // The defining characteristic the user picked: separator (border-top) plus
  // a muted color on a smaller font. The v1.3.10 redesign moved these to
  // design tokens (--tl-border / --tl-fg-3) and bumped 11.5px -> 12px to clear
  // WCAG-AA at the muted color.
  const metaBlock = src.match(/\.run-final-answer__meta\s*\{[^}]*\}/);
  assert.ok(metaBlock, 'meta block CSS rule must be present');
  assert.match(metaBlock[0], /border-top:\s*1px solid/, 'meta block must have a top separator');
  assert.match(metaBlock[0], /font-size:\s*12px/, 'meta block uses the readable 12px size');
  assert.match(metaBlock[0], /color:\s*var\(--tl-fg-3\)/, 'meta block must use the muted token color');
});

// ---------------------------------------------------------------------------
// Write-guard regression: when runWriteGuard fires (Overleaf hydration race
// or project_id mismatch) it emits a batch-level skip with `operation: <empty>`
// — no specific per-op to attribute the block to. summarizeOperationForAudit
// must tolerate that shape. The original v1.3.8 add-on pushed `operation: null`
// AND used `function summarizeOperationForAudit(operation = {}, ...)`, but JS
// default-parameter values fire only for undefined — null walked right past
// the default and crashed with "Cannot read properties of null (reading
// 'path')". The crash escaped runCodexTask's catch, masking the real
// partial-sync conclusion with the misleading "local Codex returned no usable
// result" fallback.
// ---------------------------------------------------------------------------

test('summarizeOperationForAudit tolerates null operation (write-guard batch-skip shape)', () => {
  const src = getContentScriptSource();
  const summarize = new Function(`
    ${extractFunction(src, 'summarizeOperationForAudit')}
    return summarizeOperationForAudit;
  `)();

  // The crashing case: write-guard pushed `operation: null` and audit code
  // called summarizeOperationForAudit(null, {code: '...'}, 'skipped').
  const fromNull = summarize(null, { code: 'editor_project_id_unavailable', failure: { code: 'editor_project_id_unavailable' } }, 'skipped');
  assert.equal(fromNull.path, '');
  assert.equal(fromNull.type, '');
  assert.equal(fromNull.reason, 'editor_project_id_unavailable');
  assert.equal(fromNull.status, 'skipped');

  // undefined still works (default parameter was the original intent).
  const fromUndef = summarize(undefined, undefined, 'changed');
  assert.equal(fromUndef.path, '');
  assert.equal(fromUndef.status, 'changed');

  // Real operations still work end-to-end.
  const fromReal = summarize({ path: 'main.tex', type: 'edit' }, { code: 'ok' }, 'applied');
  assert.equal(fromReal.path, 'main.tex');
  assert.equal(fromReal.type, 'edit');
  assert.equal(fromReal.status, 'applied');
});

test('write-guard emit sites use operation: {} (not null) so downstream audit code does not crash', () => {
  const writeGuardSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'page', 'writeGuard.js'), 'utf8');
  const writebackRouterSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'page', 'writebackRouter.js'), 'utf8');

  // The page-side writeGuard.abortDispatchResult path (extracted from
  // pageBridge.js for the v1.3.9 budget refactor).
  const abortFn = extractFunction(writeGuardSrc, 'abortDispatchResult');
  assert.match(abortFn, /operation:\s*\{\}/, 'abortDispatchResult must emit operation: {} (empty object)');
  assert.doesNotMatch(abortFn, /operation:\s*null/, 'abortDispatchResult must NOT emit operation: null');

  // The writebackRouter defense-in-depth check.
  assert.match(writebackRouterSrc, /function checkWritebackRunProjectId[\s\S]*?operation:\s*\{\}/,
    'checkWritebackRunProjectId must emit operation: {} (empty object)');
  // Bound the scan so we don't catch operation: null in unrelated code: the
  // checkWritebackRunProjectId function is short — extract it and grep.
  const checkFnIdx = writebackRouterSrc.indexOf('function checkWritebackRunProjectId');
  assert.notEqual(checkFnIdx, -1, 'checkWritebackRunProjectId must exist');
  const next500 = writebackRouterSrc.slice(checkFnIdx, checkFnIdx + 1500);
  assert.doesNotMatch(next500, /operation:\s*null/, 'checkWritebackRunProjectId must NOT emit operation: null');
});

// ---------------------------------------------------------------------------
// runCodexTask's outer catch must thread codexReturned through to
// translateRawError so the post-processing branch fires when Codex's stream
// completion landed before the exception. Without this signal the user sees
// the misleading 'local Codex returned no usable result' fallback even
// though Codex's answer is sitting right there in chat.
// ---------------------------------------------------------------------------

test('runCodexTask catch passes codexReturned signal to translateRawError', () => {
  const src = getContentScriptSource();
  // The catch must read the current run's assistant answer and forward the
  // boolean. Without `codexReturned` (or with it hardcoded false), the
  // post-processing branch in translateRawError is unreachable from prod.
  assert.match(src, /const codexReturned\s*=\s*Boolean\(getAssistantAnswerForCurrentRun\(\)\)/,
    'catch must derive codexReturned from getAssistantAnswerForCurrentRun');
  assert.match(src, /translateRawError\(error\.message,\s*\{[^}]*codexReturned[^}]*\}\)/,
    'translateRawError call must include codexReturned in the context object');
});

// ---------------------------------------------------------------------------
// applyOperations page-bridge timeout must accommodate the realistic page-
// side worst case. writebackRouter's openFileByPath can wait 5s for DOM-
// click activation (treeOperations.js:230) AND retry through 4 manager
// methods × ~5s each, plus waitForActiveEditorText, plus save-state
// verification. The pre-fix default of 8000ms timed out mid-flight and
// left a zombie write running on the page side. Verify the carve-out.
// ---------------------------------------------------------------------------

test('getPageBridgeTimeoutMs gives applyOperations 30s to accommodate the slow openFile path', () => {
  const src = getContentScriptSource();
  const body = extractFromContentScript('getPageBridgeTimeoutMs');
  assert.match(body, /method === 'applyOperations'/,
    'applyOperations must have a dedicated branch (not the 8000 default)');
  // The carve-out branch must return at least 30000.
  const applyMatch = body.match(/method === 'applyOperations'[\s\S]*?return\s+(\d+)/);
  assert.ok(applyMatch, 'applyOperations branch must return a numeric timeout');
  assert.ok(Number(applyMatch[1]) >= 30000,
    `applyOperations timeout must be >= 30000ms, got ${applyMatch[1]}`);
});

// ---------------------------------------------------------------------------
// saveState in-flight serialization. saveStateSoon used to start a fresh
// saveState() each time the debounce fired; if a debounce timer was cleared
// while a previous saveState() was still writing async, the older
// snapshot's writes could end up landing AFTER newer state mutations.
// The fix tracks an in-flight flag and queues at most one trailing run.
// ---------------------------------------------------------------------------

test('saveStateSoon serializes against an in-flight saveState (no parallel writers)', () => {
  const src = getContentScriptSource();
  // The two state flags must exist.
  assert.match(src, /let saveStateInFlight\s*=\s*false/, 'saveStateInFlight flag must be declared');
  assert.match(src, /let saveStateRunAfterFlight\s*=\s*false/, 'trailing-run flag must be declared');
  // saveStateSoon must short-circuit when a save is in flight, setting the
  // trailing flag instead of starting a parallel save.
  const body = extractFromContentScript('saveStateSoon');
  assert.match(body, /if \(saveStateInFlight\)/, 'saveStateSoon must check the in-flight flag');
  assert.match(body, /saveStateRunAfterFlight\s*=\s*true/, 'saveStateSoon must set the trailing flag instead of starting a parallel save');
  // runQueuedSaveState must flip the flag, await saveState, and re-trigger
  // when the trailing flag was set during the in-flight phase.
  const runner = extractFromContentScript('runQueuedSaveState');
  assert.match(runner, /saveStateInFlight\s*=\s*true/, 'runQueuedSaveState must mark in-flight');
  assert.match(runner, /\.finally\(/, 'runQueuedSaveState must clear in-flight in finally');
  assert.match(runner, /if \(saveStateRunAfterFlight\)/, 'runQueuedSaveState must re-trigger when the trailing flag fired');
});

// ---------------------------------------------------------------------------
// Cancel-by-projectKey + force-release recovery flow.
//
// After a page refresh, content-side currentRunView is null and the original
// requestId from nativeChannel is gone. The user is otherwise locked out
// (Run button shows "Send", clicking it fires a new task that hits
// project_locked). Two fixes thread through:
//   - cancelActiveRun now includes projectKey so the native host can find
//     the controller even when activeRequestId is null.
//   - forceCancelStuckTaskForCurrentProject + a recovery button rendered
//     inside the completion-report for codex_project_locked failures gives
//     the user a one-click escape hatch.
// ---------------------------------------------------------------------------

test('cancelActiveRun forwards projectKey to the native cancel so post-refresh cancel succeeds', () => {
  const src = getContentScriptSource();
  const body = extractFromContentScript('cancelActiveRun');
  assert.match(body, /projectKey/,
    'cancelActiveRun must reference projectKey for the native cancel payload');
  assert.match(body, /currentRunView\?\.runProjectId\s*\|\|\s*getCurrentProjectId\(\)/,
    'cancelActiveRun must derive projectKey from currentRunView with URL fallback');
  // The native send must include both fields so the host matches whichever resolves.
  assert.match(body, /method:\s*'codex\.cancel'[\s\S]*?requestId:[\s\S]*?projectKey:/,
    'codex.cancel payload must carry both requestId and projectKey');
});

test('forceCancelStuckTaskForCurrentProject sends force=true so a zombie lock can be dropped', () => {
  const body = extractFromContentScript('forceCancelStuckTaskForCurrentProject');
  assert.match(body, /projectKey/, 'force-cancel must read the current project key');
  assert.match(body, /force:\s*true/,
    'force-cancel must set force: true so the native host drops zombie lock entries');
  assert.match(body, /method:\s*'codex\.cancel'/, 'must dispatch via codex.cancel');
});

test('renderCompletionReport surfaces recovery action buttons per failure code (v1.7.5 registry)', () => {
  const src = getContentScriptSource();
  const renderer = extractFromContentScript('renderCompletionReport');
  assert.match(renderer, /appendRecoveryActionForFailure/,
    'renderCompletionReport must call the recovery-action appender');
  const action = extractFromContentScript('appendRecoveryActionForFailure');
  // The v1.7.5 registry: retryable codes refill the composer, native codes
  // open setup guidance, file codes open the file, storage codes open the
  // storage settings, and codex_project_locked keeps its force-release.
  assert.match(action, /RETRYABLE_FAILURE_CODES/,
    'retryable failures must route through the retry-refill set');
  assert.match(action, /refillComposerForRetry/,
    'retryable failures must refill the composer');
  assert.match(action, /NATIVE_SETUP_FAILURE_CODES[\s\S]*showNativeSetupGuidance/,
    'native-bridge failures must open the setup guidance');
  assert.match(action, /OPEN_FILE_FAILURE_CODES[\s\S]*openProjectFileForFailure/,
    'file-targeting failures must offer opening the file');
  assert.match(action, /STORAGE_FAILURE_CODES[\s\S]*openStorageSettings/,
    'storage failures must open the history & storage settings');
  assert.match(action, /CODEX_INSTALL_FAILURE_CODES[\s\S]*CODEX_CLI_TROUBLESHOOTING_URL/,
    'codex_not_found must open the CLI troubleshooting guide (v1.7.6)');
  assert.match(action, /failureCode\s*!==\s*'codex_project_locked'/,
    'codex_project_locked keeps the force-release fallback');
  assert.match(action, /forceCancelStuckTaskForCurrentProject/,
    'locked-project click must invoke the force-cancel helper');
  assert.match(action, /run-final-answer__recovery-action/,
    'buttons must carry the canonical CSS class');
  // The structured failure must actually reach the report event — without
  // this forwarding no recovery button can ever render (latent since v1.6.2).
  const reportAppend = extractFromContentScript('appendCompletionReport');
  assert.match(reportAppend, /failure:\s*input\.failure/,
    'appendCompletionReport must forward input.failure onto the report event');
  assert.match(reportAppend, /compileErrors:\s*input\.compileErrors/,
    'appendCompletionReport must forward compile errors for the fix action');
});

test('writeback failure promotes the primary skipped failure so file/write recovery buttons are reachable (v1.7.5 fleet)', () => {
  // Target-file and write-stage failure codes only ever exist inside
  // applied.skipped[].result.failure. Without promoting one to the report's
  // run-level failure, the registry's OPEN_FILE / write-retry branches are
  // dead code (fleet-confirmed).
  const fn = extractFromContentScript('applySyncChangesToOverleaf');
  assert.match(fn, /failure:\s*writebackIncomplete \? promoteWritebackSkippedFailure\(applied\)/,
    'the failed-writeback report must carry the primary skipped failure');
  const picker = extractFromContentScript('promoteWritebackSkippedFailure');
  assert.match(picker, /getSkippedEntries\(applied\)/);
  assert.match(picker, /failure\.file/, 'promoted failure must keep/derive the file for the open-file action');
});

test('clear-all-history re-renders the panel explicitly instead of relying on startNewSession (v1.7.5 fleet)', () => {
  // startNewSession's empty-session reuse guard early-returns before
  // applyStateToPanel when the sessions list was just emptied, leaving the
  // deleted run cards on screen (fleet-confirmed). The clear flow must
  // normalize + save + re-render itself.
  const body = extractFromContentScript('clearAllHistoryWithConfirm');
  assert.match(body, /clearAllStores/);
  // v1.8.0 phase 8: the handler lives in panelMaintenance.js and goes
  // through the injected getState/setState accessors.
  assert.match(body, /setState\(normalizePanelState\(\{ \.\.\.getState\(\), sessions: \[\], runs: \[\], activeSessionId: '' \}\)\)/);
  assert.match(body, /applyStateToPanel\(\)/, 'must re-render the emptied panel');
  assert.doesNotMatch(body, /await startNewSession\(\)/,
    'must not route through startNewSession (its reuse guard skips the re-render)');
  assert.match(body, /destructive: true/, 'confirm must be destructive-styled');
});

test('panel.css ships visible styling for the recovery action button', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'extension', 'styles', 'panel.css'), 'utf8');
  assert.match(css, /\.run-final-answer__recovery-action\s*\{/,
    'recovery action button must have a CSS rule');
  assert.match(css, /\.run-final-answer__recovery-action:hover/,
    'recovery action button must have a :hover state');
  assert.match(css, /\.run-final-answer__recovery-action:disabled/,
    'recovery action button must have a :disabled state');
});

test('every page-world module writebackRouter dereferences is actually injected (v1.8.0 fleet P1)', () => {
  // The vm test harnesses load page modules manually, so ONLY the real
  // injectPageBridge sequence proves a carved module reaches the page world.
  // v1.8.0's phase-7 carve shipped with the module in the manifest but NOT
  // in this list — the writeback pipeline was dead on every page while the
  // whole suite stayed green.
  const body = extractFromContentScript('injectPageBridge');
  const lifecycleAt = body.indexOf("src/page/trackedChangesLifecycle.js");
  const routerAt = body.indexOf("src/page/writebackRouter.js");
  assert.ok(lifecycleAt !== -1, 'trackedChangesLifecycle.js must be injected');
  assert.ok(routerAt !== -1, 'writebackRouter.js must be injected');
  assert.ok(lifecycleAt < routerAt, 'lifecycle must load before the router that dereferences it');
});

test('verified text-only writebacks confirm the mirror in place with a full-resync fallback (v1.8.0)', () => {
  // The written content ORIGINATES in the local workspace, so a verified
  // writeback only needs the baseline re-hashed (mirror.confirmWriteback) —
  // not a full project re-download. Anything unusual must fall back.
  const refresh = extractFromContentScript('refreshProjectMirrorAfterWriteback');
  assert.match(refresh, /await tryConfirmMirrorWriteback\(applied\)/,
    'the incremental confirm path runs first');
  assert.match(refresh, /getProjectSnapshot/,
    'the full zip resync fallback stays in place');
  const confirm = extractFromContentScript('tryConfirmMirrorWriteback');
  assert.match(confirm, /MIRROR_CONFIRMABLE_OPERATION_TYPES\.has\(operation\.type\)/,
    'only whitelisted text operations qualify');
  assert.match(confirm, /return false/,
    'any non-qualifying entry falls back to the full resync');
  assert.match(confirm, /mirror\.confirmWriteback/,
    'dispatches the v1.8.0 confirm method');
  assert.match(confirm, /catch \(error\)/,
    'an old native host without the method must not break the refresh');
  const src = getContentScriptSource();
  assert.match(src, /MIRROR_CONFIRMABLE_OPERATION_TYPES = new Set\(\['edit'\]\)/,
    'tree ops and binary writes are excluded from the in-place confirm');
});

test('writeback records the undo checkpoint before any cancellable verify await; mirror runs in background with barriers (v1.7.5)', () => {
  // A user-cancel during the post-write save-verify throws codex_cancelled.
  // If undo recording sat after that await, a cancel would strip the "Undo
  // written parts" button for changes that already landed.
  const fn = extractFromContentScript('applySyncChangesToOverleaf');
  const undoAt = fn.indexOf('recordUndoFromApply(project, applied)');
  const verifyAt = fn.indexOf('await verifyPostWriteSaveState()');
  // v1.7.5: the mirror refresh no longer blocks the completion report — it
  // runs in the background and its promise is stored for barriers.
  const mirrorAt = fn.indexOf('pendingMirrorRefresh = refreshProjectMirrorAfterWriteback');
  assert.ok(undoAt !== -1, 'undo recording present');
  assert.ok(verifyAt !== -1 && mirrorAt !== -1, 'verify await + background mirror present');
  assert.ok(undoAt < verifyAt, 'undo must be recorded before the save-verify await');
  assert.ok(undoAt < mirrorAt, 'undo must be recorded before the mirror refresh starts');
  assert.doesNotMatch(fn, /await refreshProjectMirrorAfterWriteback/,
    'the report path must not block on the mirror refresh');
  // The barriers: an in-flight mirror.sync landing AFTER an undo (or after
  // the next run started) would push the pre-undo snapshot as the local
  // baseline. Both consumers must wait it out.
  const undoBody = extractFromContentScript('undoRun');
  assert.match(undoBody, /getPendingMirrorRefresh/,
    'undoRun must barrier on the pending mirror refresh');
  const runTaskBody = getContentScriptSource().match(/async function runTask\([^)]*\) \{[\s\S]*?\n  async function handleTaskResult/)?.[0] || '';
  assert.match(runTaskBody, /getPendingMirrorRefresh/,
    'runTask must barrier on the pending mirror refresh');
  // The ~5s save-verify must only run when real writes landed, not on an
  // all-skipped (zero-write) run.
  assert.match(fn, /const saveVerification = appliedPaths\.length/,
    'save-verify must gate on applied write count, not on skipped-inclusive entries');
});
