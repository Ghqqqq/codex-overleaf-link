'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Notice = require('../extension/src/content/runFailureNotice');
const Session = require('../extension/src/shared/sessionState');
const Storage = require('../extension/src/shared/storageDb');
const Settlement = require('../extension/src/shared/writebackSettlement');
const FailureReasons = require('../extension/src/shared/failureReasons');
const I18n = require('../extension/src/shared/i18n');
const timeline = fs.readFileSync(path.join(__dirname, '../extension/src/content/runTimelineView.js'), 'utf8');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const failed = title => ({ title, status: 'failed', kind: 'activity',
  activity: { v: 1, kind: 'notice', state: 'failed', output: title } });
const titles = ['Undo result: undone 1 item(s), skipped 2 item(s)',
  'Undo result: rejected 0 tracked change(s), skipped 1',
  'Undo result: undone 0 file(s), skipped 1',
  '撤销结果：已撤销 0 项，跳过 2 项', '撤销结果：已拒绝 1 条留痕，跳过 2 条'];
for (const terminal of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'rejected' }]) {
  test('resolved undo hides only obsolete attempt notices: ' + JSON.stringify(terminal), () => {
    const other = failed('Could not compile the current document.');
    const stream = { ...failed(titles[0]), kind: 'stream', streamRole: 'assistant' };
    const completed = { ...failed(titles[0]), status: 'completed' };
    const run = { ...terminal, events: [...titles.map(failed), other, stream, completed] };
    const saved = JSON.stringify(run), projected = Notice.projectResolvedUndo(run);
    assert.deepEqual(projected.events, [other, stream, completed]);
    assert.equal(JSON.stringify(run), saved, 'raw events and normalized activity metadata remain intact');
  });
}
for (const status of [{}, { undoStatus: 'running' }, { undoStatus: 'partial' },
  { trackedChangeStatus: 'needs_review' }, { trackedChangeStatus: 'accepted' }]) {
  test('unresolved or accepted run retains its failed undo evidence: ' + JSON.stringify(status), () => {
    const run = { ...status, events: titles.map(failed) };
    assert.equal(Notice.projectResolvedUndo(run), run);
  });
}
test('presentation remains selective after session hydration', () => {
  const hydrated = Session.normalizePanelState({ sessions: [{ id: 's', runs: [{ id: 'r', status: 'completed',
    undoStatus: 'applied', events: [failed(titles[0]), failed('Unrelated write failed')] }] }], activeSessionId: 's' });
  const run = hydrated.sessions[0].runs[0];
  assert.equal(run.events.length, 2);
  assert.deepEqual(Notice.projectResolvedUndo(run).events.map(event => event.title), ['Unrelated write failed']);
});
test('live activity projection uses the same filtered run without changing persistence', () => {
  let options;
  const run = { id: 'r', undoStatus: 'applied', events: [failed(titles[0])] };
  const context = vm.createContext({ window: {} });
  for (const file of ['moduleRegistryKernel', 'runRecoveryActions']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/' + file + '.js'), 'utf8'), context);
  }
  vm.runInContext(timeline, context);
  context.window.CodexOverleafRunTimelineView.create({ RunFailureNotice: Notice,
    RunActivitySummary: { create(value) { options = value; return {}; } }, findRunRecord: () => run });
  assert.equal(options.findRunRecord('r').events.length, 0);
  assert.equal(run.events.length, 1);
});
function extract(source, name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, name);
  const end = /\n  }(?=\n|$)/.exec(source.slice(match.index + match[0].length));
  assert.ok(end, name + ' closing boundary');
  return source.slice(match.index, match.index + match[0].length + end.index + end[0].length);
}
test('resolved card refresh preserves disclosure and scroll position', () => {
  const run = { id: 'r', undoStatus: 'applied', events: [failed(titles[0])] };
  const process = { open: false }, next = { querySelector: () => process };
  let replacement, restored;
  const existing = { querySelector: () => ({ open: true }), replaceWith: node => { replacement = node; } };
  const log = { querySelector: () => existing };
  const context = vm.createContext({ getPanel: () => ({ querySelector: () => log }),
    cssEscape: value => value, findRunRecord: () => run, displayRun: Notice.projectResolvedUndo,
    scrollLayout: { snapshot: () => ({ scrollTop: 123 }), restore: value => { restored = value; } },
    renderRunCard: value => { assert.equal(value, run); return next; } });
  vm.runInContext(extract(timeline, 'refreshRunCard'), context);
  assert.equal(context.refreshRunCard('r'), true);
  assert.equal(replacement, next);
  assert.equal(process.open, true);
  assert.equal(restored.scrollTop, 123);
});
test('settlement control refresh replaces the resolved transcript before stale rows survive', () => {
  let refreshed = 0;
  const context = vm.createContext({ findRunRecord: () => ({ id: 'r' }),
    panel: { querySelector: () => ({}) }, cssEscape: value => value,
    runTimelineView: { refreshResolvedUndo: id => { assert.equal(id, 'r'); refreshed++; return true; } },
    configureAcceptButton() { assert.fail('old card must not be reused'); } });
  vm.runInContext(extract(runtime, 'refreshRunCardControls'), context);
  context.refreshRunCardControls('r');
  assert.equal(refreshed, 1);
});

class NoticeNode {
  constructor(tag) { this.tagName = tag; this.dataset = {}; this.children = []; this.listeners = {}; this.text = ''; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(type, callback) { this.listeners[type] = callback; }
}
function renderFailure(run, locale) {
  const document = { createElement: tag => new NoticeNode(tag) };
  const report = document.createElement('section'); report.dataset.status = 'failed';
  const view = Notice.create({ document, tr: (key, params) => I18n.t(locale, key, params),
    projectRunSettlement: Settlement.projectRunSettlement });
  view.append(report, {}, run);
  return { report, view, message: report.children[0].children[1].textContent };
}
const undoPath = 'codex-smoke-20261004/nested.tex';
const originalMismatch = undoPath + ' 当前内容或文档身份与本轮撤销检查点不一致；Codex 保留恢复材料并停止撤销。';
function persistedUndoFailure(code, reason) {
  const initial = { id: 'r', status: 'completed', mode: 'auto', undoStatus: 'ready',
    undoExpectedFiles: [{ path: undoPath, content: 'before' }], events: [] };
  const result = { ok: false, applied: [], skipped: [{ trackedChange: { path: undoPath },
    result: { ok: false, code, file: undoPath, reason, changedDocument: false } }] };
  const run = Settlement.applySettlementTransition(initial,
    Settlement.settleLegacyUndo({ run: initial, status: 'partial', result }));
  const record = Storage.buildSessionRecord({ id: 's', projectId: 'qa', accountScopeId: 'test', runs: [run] });
  return Session.normalizeRuns(JSON.parse(JSON.stringify(record)).runs)[0];
}
for (const code of ['snapshot_undo_current_mismatch', 'snapshot_undo_open_failed', 'snapshot_undo_unavailable']) {
  test('snapshot Undo stays canonical through settlement/storage and follows current Notice locale: ' + code, () => {
    const run = persistedUndoFailure(code, originalMismatch);
    const before = JSON.stringify(run);
    const failure = Settlement.projectRunSettlement(run).primaryFailure;
    assert.equal(failure.code, code);
    assert.equal(failure.stage, 'undo');
    assert.equal(failure.file, undoPath);
    assert.equal(failure.userMessage, originalMismatch, 'raw producer reason remains stored');
    for (const locale of ['en', 'zh', 'en']) {
      const rendered = renderFailure(run, locale);
      assert.equal(rendered.message, undoPath + ': ' + I18n.t(locale, 'failureReason_' + code + '_user'));
      assert.equal(rendered.view.getRecoveryContext(rendered.report).failure.code, code);
      assert.equal(rendered.view.getRecoveryContext(rendered.report).file, undoPath);
    }
    assert.equal(JSON.stringify(run), before, 'display-time localization does not rewrite recovery facts');
  });
}
test('old screenshot Notice is localized without granting a parsed file recovery action', () => {
  const run = persistedUndoFailure('unknown_legacy_failure', originalMismatch);
  run.settlement.failures[0].file = '';
  const before = JSON.stringify(run);
  for (const locale of ['en', 'zh']) {
    const { report, view, message } = renderFailure(run, locale);
    assert.equal(message, undoPath + ': ' + I18n.t(locale, 'failureReason_snapshot_undo_current_mismatch_user'));
    assert.equal(view.getRecoveryContext(report).failure.code, 'unknown_legacy_failure');
    assert.equal(view.getRecoveryContext(report).file, '', 'path inferred for display never authorizes opening a file');
    assert.equal(view.getRecoveryContext(report).failure.retryable, false);
  }
  assert.equal(JSON.stringify(run), before);
});
test('unknown diagnostics and near-miss legacy templates are preserved verbatim', () => {
  for (const reason of ['Unrecognized Page diagnostic: 自定义原因', originalMismatch + ' Additional context.',
    originalMismatch.replace(undoPath, '../private.tex')]) {
    const run = persistedUndoFailure('unknown_legacy_failure', reason);
    run.settlement.failures[0].file = '';
    assert.equal(renderFailure(run, 'en').message, reason);
    assert.equal(renderFailure(run, 'zh').message, reason);
  }
});
test('other exact historical snapshot templates use the selected language without changing their failure code', () => {
  for (const [reason, code] of [
    [undoPath + ' 当前内容已经不是本轮写入后的内容；为避免覆盖你的后续修改，Codex 不执行快照撤销。', 'snapshot_undo_current_mismatch'],
    ['无法打开 ' + undoPath + ' 来执行快照撤销。', 'snapshot_undo_open_failed'],
    ['The saved checkpoint is unavailable for this undo.', 'snapshot_undo_unavailable']
  ]) {
    const run = persistedUndoFailure('unknown_legacy_failure', reason);
    for (const locale of ['en', 'zh']) {
      const { report, view, message } = renderFailure(run, locale);
      assert.equal(message, undoPath + ': ' + I18n.t(locale, 'failureReason_' + code + '_user'));
      assert.equal(view.getRecoveryContext(report).failure.code, 'unknown_legacy_failure');
    }
  }
});
test('snapshot originalCode localizes historical diagnostics without changing classification or evidence', () => {
  const failure = { code: 'unknown_legacy_failure', stage: 'unknown', severity: 'error',
    retryable: false, userMessage: originalMismatch, technicalMessage: originalMismatch,
    evidence: { originalCode: 'snapshot_undo_current_mismatch', originalReason: originalMismatch } };
  const before = JSON.stringify(failure);
  for (const locale of ['en', 'zh']) {
    const localized = FailureReasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key));
    assert.equal(localized.userMessage, I18n.t(locale, 'failureReason_snapshot_undo_current_mismatch_user'));
  }
  assert.equal(FailureReasons.normalizeFailureReason({ failure }).code, 'unknown_legacy_failure');
  assert.equal(JSON.stringify(failure), before);
});
test('a retained originalCode takes display precedence over a legacy message template', () => {
  const run = persistedUndoFailure('unknown_legacy_failure', originalMismatch);
  const failure = run.settlement.failures[0];
  failure.evidence = { originalCode: 'snapshot_undo_open_failed' };
  const before = JSON.stringify(failure);
  // Read the event failure directly: old compact settlement facts intentionally
  // omit evidence, while a retained structured event can still provide it.
  const document = { createElement: tag => new NoticeNode(tag) };
  const report = document.createElement('section'); report.dataset.status = 'failed';
  const view = Notice.create({ document, tr: (key, params) => I18n.t('en', key, params) });
  view.append(report, { failure }, {});
  assert.equal(report.children[0].children[1].textContent,
    undoPath + ': ' + I18n.t('en', 'failureReason_snapshot_undo_open_failed_user'));
  assert.equal(JSON.stringify(failure), before);
});
test('existing Bridge and apply-result Undo details use the same snapshot translations', () => {
  const context = vm.createContext({ window: {} });
  for (const file of ['failureReasons', 'i18n']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/shared/' + file + '.js'), 'utf8'), context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/applyResultFormatters.js'), 'utf8'), context);
  let locale = 'en';
  const formatters = context.window.CodexOverleafApplyResultFormatters.create({ i18n: context.CodexOverleafI18n,
    FailureReasons: context.CodexOverleafFailureReasons,
    getLocale: () => locale, tr: (key, params) => I18n.t(locale, key, params), tx: (en, zh) => locale === 'zh' ? zh : en });
  for (const code of ['snapshot_undo_current_mismatch', 'snapshot_undo_open_failed', 'snapshot_undo_unavailable', 'file_tree_controls_unavailable']) {
    const result = { ok: false, code, file: undoPath, reason: originalMismatch };
    for (locale of ['en', 'zh']) {
      const expected = undoPath + ': ' + I18n.t(locale, 'failureReason_' + code + '_user');
      assert.equal(formatters.formatBridgeResultReason(result), expected);
      assert.equal(formatters.formatApplyResultReason({ result, operation: { path: undoPath } }), expected);
    }
    assert.equal(result.reason, originalMismatch);
  }
  locale = 'en';
  assert.equal(formatters.formatBridgeResultReason({ code: 'unrecognized', reason: '原始诊断保留' }), '原始诊断保留');
});
test('unsupported file controls keep their exact preflight blocker and current-language Notice', () => {
  const code = 'file_tree_controls_unavailable';
  const reason = 'No supported Overleaf file-tree method was detected';
  const raw = FailureReasons.normalizeFailureReason({ code, reason, ok: false }, { path: undoPath, type: 'move' });
  assert.equal(raw.code, code); assert.equal(raw.stage, 'preflight');
  assert.equal(raw.severity, 'blocked'); assert.equal(raw.retryable, false);
  assert.equal(raw.technicalMessage, reason);
  const run = persistedUndoFailure(code, reason);
  for (const locale of ['en', 'zh']) {
    const { report, view, message } = renderFailure(run, locale);
    assert.equal(message, undoPath + ': ' + I18n.t(locale, 'failureReason_' + code + '_user'));
    assert.equal(view.getRecoveryContext(report).failure.retryable, false);
  }
});
test('declined deletion is a nonretryable blocker without implying other writes were cancelled', () => {
  const code = 'delete_confirmation_rejected';
  const failure = FailureReasons.normalizeFailureReason({ ok: false, code,
    reason: 'Delete requires explicit confirmation and was skipped.' }, { type: 'delete', path: undoPath });
  assert.equal(failure.code, code);
  assert.equal(failure.stage, 'preflight');
  assert.equal(failure.severity, 'blocked');
  assert.equal(failure.retryable, false);
  assert.equal(failure.operationType, 'delete');
  assert.equal(failure.file, undoPath);
  for (const [locale, expected] of [
    ['en', 'The deletion was cancelled and was not applied. Other allowed changes in this run may still proceed.'],
    ['zh', '删除已取消，未执行该删除；本轮其他获准改动仍可能继续。']
  ]) {
    const localized = FailureReasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key));
    assert.equal(localized.userMessage, expected);
    assert.equal(localized.nextAction, I18n.t(locale, 'failureReason_' + code + '_next'));
  }
});
