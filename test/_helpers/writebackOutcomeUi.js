'use strict';
const vm = require('node:vm');
const { req, read, Settlement, I18n, extractFunction } = require('./writebackOutcomeHarness');
const Notice = req('extension/src/content/runFailureNotice');
const timeline = read('extension/src/content/runRecoveryActions.js') + '\n' + read('extension/src/content/runTimelineView.js');
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this._text = ''; this.open = false; }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(' '); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  click() { if (!this.disabled) return this.listeners.click?.({ stopPropagation() {} }); }
  cloneNode() { const copy = new Node(this.tagName); Object.assign(copy.attributes, this.attributes); return copy; }
  replaceWith(node) { const index = this.parent.children.indexOf(this); this.parent.children[index] = node; node.parent = this.parent; }
  all(predicate) { return this.children.flatMap(node => [...(predicate(node) ? [node] : []), ...node.all(predicate)]); }
  closest() { return this.parent || null; }
  querySelector(selector) { return this.all(node => selector === '[data-run-process]' ? node.process
    : Object.hasOwn(node.attributes, selector.slice(1, -1)))[0] || null; }
  scrollIntoView() {}
}
function renderNotice(flow, event, run, options = {}) {
  const actions = [], c = flow.c;
  c.getPanel = () => c.panel; c.getState = () => c.state;
  vm.runInContext(extractFunction(read('extension/src/content/panelMaintenance.js'), 'refillComposerForRetry'), c);
  const document = { createElement: tag => new Node(tag) };
  const tr = (key, params) => I18n.t('en', key, params);
  const failureNotice = Notice.create({ document, tr, projectRunSettlement: Settlement.projectRunSettlement });
  const ctx = vm.createContext({ document, failureNotice, tx: en => en,
    refillComposerForRetry: value => { actions.push({ type: 'refill', runId: value?.id }); c.refillComposerForRetry(value); },
    getCurrentRunView: () => c.currentRunView, retryWriteback: id => c.retryRunWriteback(id),
    checkWriteback: options.checkWriteback,
    openManualReviewFile: options.openManualReviewFile, verifyManualReview: options.verifyManualReview,
    checkCreatedDirectories: options.checkCreatedDirectories,
    getCurrentProjectId: () => c.getCurrentProjectId(), getAccountScopeId: () => c.cachedAccountScopeId,
    trackedChangeInFlight: c.trackedChangeInFlight,
    canEditRun: value => c.runController.isRetryReplacementEligible(value, Settlement.projectRunSettlement(value)),
    openProjectFileForFailure: file => { actions.push({ type: 'open-file', file }); },
    showNativeSetupGuidance: () => actions.push({ type: 'native-setup' }),
    openStorageSettings: () => actions.push({ type: 'storage' }),
    forceCancelStuckTaskForCurrentProject: async () => { actions.push({ type: 'force-cancel' }); return { ok: true }; },
    window: { open: url => actions.push({ type: 'open-url', url }) }
  });
  const start = timeline.indexOf('  const RETRYABLE_FAILURE_CODES =');
  const end = timeline.indexOf('  function buildRecoveryButton(', start);
  vm.runInContext(timeline.slice(start, end), ctx);
  for (const name of ['buildRecoveryButton', 'appendEditAndResend', 'appendRecoveryActionForFailure', 'appendManualReviewActions', 'renderDirectoryCleanup', 'configureWritebackButton', 'configureWritebackCheckButton', 'configureEditButton']) vm.runInContext(extractFunction(timeline, name), ctx);
  const report = new Node('section'), card = new Node('article'), process = new Node('details');
  process.process = true; card.append(report, process); report.dataset.status = event.status || run.status;
  const directoryCleanup = new Node('section'); directoryCleanup.setAttribute('data-run-directory-cleanup', ''); card.append(directoryCleanup);
  for (const action of ['sync-retry', 'sync-check', 'edit']) { const button = new Node('button'); button.setAttribute('data-run-' + action, ''); card.append(button); }
  failureNotice.append(report, event, run);
  ctx.appendRecoveryActionForFailure(report, event, run);
  ctx.configureWritebackButton(card, run); ctx.configureEditButton(card, run);
  const buttons = report.all(node => node.tagName === 'button');
  const snapshot = () => ({ text: report.textContent,
    notices: report.all(node => node.className === 'run-feedback').map(node => ({ tone: node.dataset.tone, text: node.textContent })),
    buttons: buttons.map(node => ({ text: node.textContent, recoveryFor: node.dataset.recoveryFor })),
    meta: (event.detailStructured?.meta || []).map(row => ({ ...row, value: failureNotice.formatMetaValue(report, row) })),
    toolbar: Object.fromEntries(['sync-retry', 'sync-check', 'edit'].map(action => { const button = card.querySelector('[data-run-' + action + ']');
      return [action, { hidden: button.hidden, disabled: button.disabled || false, title: button.title || '' }]; })),
    directoryCleanup: { hidden: directoryCleanup.hidden, text: directoryCleanup.textContent,
      disabled: card.querySelector('[data-run-directories-check]')?.disabled },
    processOpen: process.open });
  return { actions, snapshot, clickCheck: () => card.querySelector('[data-run-sync-check]').click(),
    clickDirectories: () => card.querySelector('[data-run-directories-check]')?.click(), async click(index = 0) {
    const before = { nativeRuns: flow.h.io.requests.length, pageCalls: flow.trace.filter(item => item.kind === 'page').length };
    await buttons[index]?.click();
    return { before, after: { nativeRuns: flow.h.io.requests.length, pageCalls: flow.trace.filter(item => item.kind === 'page').length },
      actions, composer: flow.h.controls.get('[data-task]').value, snapshot: snapshot() };
  } };
}
module.exports = { renderNotice };
